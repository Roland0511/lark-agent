import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { ControlPlaneConfig } from "./config.js";
import { LarkGateway, previewSummary } from "../lark/gateway.js";
import { AppError, errorMessage } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import { taskTurnResultSchema, type CommentaryStreamUpdate } from "../shared/contracts.js";
import { BotGatewayRegistry } from "./bot-runtime.js";

type OutputRow = Awaited<ReturnType<TaskOutputService["getOutput"]>>;

export class TaskOutputService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: ControlPlaneConfig,
    private readonly lark: LarkGateway | BotGatewayRegistry
  ) {}

  async streamCommentary(taskId: string, update: CommentaryStreamUpdate): Promise<{ messageId: string | null; ignored: boolean }> {
    return this.serialized(taskId, async () => {
      const existing = await this.getOutput(taskId);
      if (existing?.last_item_id === update.itemId && update.ordinal <= existing.last_ordinal) return { messageId: existing.message_id, ignored: true };
      const visibleText = visibleStreamText(update.text);
      if (visibleText === null) return { messageId: existing?.message_id ?? null, ignored: true };
      const output = existing?.message_id ? existing : await this.openCard(taskId, visibleText, true);
      if (!output.message_id || !output.card_id) return { messageId: output.message_id, ignored: false };
      if (!existing?.message_id) {
        await this.db.updateTable("task_outputs").set({ last_item_id: update.itemId, last_ordinal: update.ordinal, visible_phase: "commentary", updated_at: new Date() }).where("task_id", "=", taskId).execute();
        return { messageId: output.message_id, ignored: false };
      }
      await this.updateContent(output, visibleText, "commentary", update.ordinal, update.itemId);
      return { messageId: output.message_id, ignored: false };
    });
  }

  async showStatus(taskId: string, content: string): Promise<void> {
    await this.serialized(taskId, async () => {
      const output = await this.getOutput(taskId);
      if (!output?.message_id || !output.card_id || output.state === "completed" || output.state === "unknown") return;
      await this.updateContent(output, content, "commentary", output.last_ordinal);
    });
  }

  async markHeld(taskId: string): Promise<void> {
    await this.showStatus(taskId, "收到新消息，正在重新判断…");
    await this.db.updateTable("task_outputs").set({ state: "held", updated_at: new Date() }).where("task_id", "=", taskId).where("state", "!=", "unknown").execute();
  }

  async finalize(taskId: string, content: string, fallbackIdempotencyKey: string): Promise<{ messageId: string; transport: "cardkit" | "markdown_fallback" }> {
    return this.serialized(taskId, async () => {
      let output = await this.getOutput(taskId);
      if (output?.state === "completed" && output.message_id) {
        return { messageId: output.message_id, transport: output.transport };
      }
      if (output?.state === "unknown") throw new Error("CardKit output state is uncertain; refusing an automatic retry");
      if (!this.config.larkEnabled) {
        await this.ensureOutputRow(taskId);
        await this.db.updateTable("task_outputs").set({ state: "completed", visible_phase: "final", current_content: content, current_content_hash: sha256(content), closed_at: new Date(), updated_at: new Date() }).where("task_id", "=", taskId).execute();
        return { messageId: "", transport: "cardkit" };
      }
      if (!output?.message_id) {
        try {
          output = await this.openCard(taskId, content, false);
          await this.db.updateTable("task_outputs").set({ state: "completed", visible_phase: "final", closed_at: new Date(), updated_at: new Date() }).where("task_id", "=", taskId).execute();
          await this.recordStage(taskId, "card.finalized", "CardKit 最终回复已完成", { streaming: false });
          return { messageId: output.message_id ?? "", transport: "cardkit" };
        } catch (error) {
          const failed = await this.getOutput(taskId);
          if (failed?.message_id || failed?.state === "unknown") throw error;
          const target = await this.deliveryTarget(taskId);
          const gateway = await this.gatewayForTask(taskId);
          const messageId = target.chatType === "group"
            ? await gateway.replyMarkdownToMessage(target.rootMessageId, content, fallbackIdempotencyKey)
            : await gateway.sendMarkdownToChat(target.chatId, content, fallbackIdempotencyKey);
          await this.ensureOutputRow(taskId);
          await this.db.updateTable("task_outputs").set({
            transport: "markdown_fallback", card_id: null, message_id: messageId, state: "completed", visible_phase: "final",
            current_content: content, current_content_hash: sha256(content), closed_at: new Date(), last_error: errorMessage(error), updated_at: new Date()
          }).where("task_id", "=", taskId).execute();
          await this.db.updateTable("conversations").set({ response_message_id: messageId, updated_at: new Date() }).where("id", "=", failed?.conversation_id ?? (await this.conversationId(taskId))).execute();
          return { messageId, transport: "markdown_fallback" };
        }
      }
      if (!output.card_id) throw new Error("task output has a message but no CardKit card_id");
      output = await this.updateContent(output, content, "final", output.last_ordinal);
      await this.closeStream(output, previewSummary(content));
      await this.db.updateTable("task_outputs").set({ state: "completed", visible_phase: "final", closed_at: new Date(), updated_at: new Date() }).where("task_id", "=", taskId).execute();
      await this.recordStage(taskId, "card.finalized", "CardKit 流式回复已关闭", { streaming: true, sequence: output.sequence + 1 });
      return { messageId: output.message_id ?? "", transport: "cardkit" };
    });
  }

  private async openCard(taskId: string, content: string, streaming: boolean): Promise<NonNullable<OutputRow>> {
    const output = await this.ensureOutputRow(taskId);
    if (output.message_id) return output;
    if (output.state === "unknown" || output.card_id) throw new Error("CardKit send result is uncertain; refusing to create a second reply");
    const createUuid = `card-create-${taskId}`;
    await this.recordOperation(taskId, "create_card", null, createUuid, content);
    let cardId: string;
    const gateway = await this.gatewayForTask(taskId);
    try {
      cardId = await gateway.createCardEntity(content, streaming);
      await this.completeOperation(createUuid);
      await this.db.updateTable("task_outputs").set({ card_id: cardId, current_content: content, current_content_hash: sha256(content), updated_at: new Date() }).where("task_id", "=", taskId).execute();
      await this.recordStage(taskId, "card.created", "CardKit 卡片实体已创建", { streaming });
    } catch (error) {
      await this.failOperation(createUuid, error, "failed");
      await this.db.updateTable("task_outputs").set({ state: "failed", last_error: errorMessage(error), updated_at: new Date() }).where("task_id", "=", taskId).execute();
      throw error;
    }
    const sendUuid = `card-send-${taskId}`;
    await this.recordOperation(taskId, "send_card", null, sendUuid, null);
    try {
      const target = await this.deliveryTarget(taskId);
      const messageId = target.chatType === "group"
        ? await gateway.replyCardEntityToMessage(target.rootMessageId, cardId, sendUuid)
        : await gateway.sendCardEntityToChat(target.chatId, cardId, sendUuid);
      await this.completeOperation(sendUuid);
      await this.db.updateTable("task_outputs").set({ message_id: messageId, state: streaming ? "streaming" : "completed", visible_phase: streaming ? "commentary" : "final", opened_at: new Date(), updated_at: new Date() }).where("task_id", "=", taskId).execute();
      await this.db.updateTable("conversations").set({ response_message_id: messageId, updated_at: new Date() }).where("id", "=", output.conversation_id).execute();
      await this.recordStage(taskId, "card.sent", "CardKit 已发送到飞书", { streaming, messageId });
      return (await this.getOutput(taskId)) as NonNullable<OutputRow>;
    } catch (error) {
      const state = isDefiniteLarkRejection(error) ? "failed" : "unknown";
      await this.failOperation(sendUuid, error, state);
      await this.db.updateTable("task_outputs").set({ state, last_error: errorMessage(error), updated_at: new Date() }).where("task_id", "=", taskId).execute();
      throw error;
    }
  }

  private async updateContent(output: NonNullable<OutputRow>, content: string, phase: "commentary" | "final", ordinal: number, itemId?: string): Promise<NonNullable<OutputRow>> {
    if (!output.card_id) throw new Error("CardKit output is missing card_id");
    const sequence = output.sequence + 1;
    const requestUuid = randomUUID();
    await this.recordOperation(output.task_id, "update_content", sequence, requestUuid, content);
    try {
      await (await this.gatewayForTask(output.task_id)).streamCardContent(output.card_id, output.element_id, content, sequence, requestUuid);
      await this.completeOperation(requestUuid);
      await this.db.updateTable("task_outputs").set({
        sequence, state: phase === "final" ? output.state : "streaming", visible_phase: phase,
        current_content: content, current_content_hash: sha256(content),
        last_item_id: phase === "commentary" ? (itemId ?? output.last_item_id) : output.last_item_id,
        last_ordinal: phase === "commentary" && itemId !== output.last_item_id ? ordinal : Math.max(output.last_ordinal, ordinal),
        last_error: null, updated_at: new Date()
      }).where("task_id", "=", output.task_id).execute();
      return (await this.getOutput(output.task_id)) as NonNullable<OutputRow>;
    } catch (error) {
      await this.failOperation(requestUuid, error, "unknown");
      await this.db.updateTable("task_outputs").set({ state: "unknown", last_error: errorMessage(error), updated_at: new Date() }).where("task_id", "=", output.task_id).execute();
      throw error;
    }
  }

  private async closeStream(output: NonNullable<OutputRow>, summary: string): Promise<void> {
    if (!output.card_id) throw new Error("CardKit output is missing card_id");
    const sequence = output.sequence + 1;
    const requestUuid = randomUUID();
    await this.recordOperation(output.task_id, "close_stream", sequence, requestUuid, summary);
    try {
      await (await this.gatewayForTask(output.task_id)).closeCardStream(output.card_id, summary, sequence, requestUuid);
      await this.completeOperation(requestUuid);
      await this.db.updateTable("task_outputs").set({ sequence, updated_at: new Date() }).where("task_id", "=", output.task_id).execute();
    } catch (error) {
      await this.failOperation(requestUuid, error, "unknown");
      await this.db.updateTable("task_outputs").set({ state: "unknown", last_error: errorMessage(error), updated_at: new Date() }).where("task_id", "=", output.task_id).execute();
      throw error;
    }
  }

  private async ensureOutputRow(taskId: string): Promise<NonNullable<OutputRow>> {
    const conversationId = await this.conversationId(taskId);
    await this.db.insertInto("task_outputs").values({ task_id: taskId, conversation_id: conversationId, card_id: null, message_id: null, visible_phase: null, current_content: null, current_content_hash: null, last_item_id: null, last_error: null, opened_at: null, closed_at: null }).onConflict((conflict) => conflict.column("task_id").doNothing()).execute();
    return (await this.getOutput(taskId)) as NonNullable<OutputRow>;
  }

  private getOutput(taskId: string) {
    return this.db.selectFrom("task_outputs").selectAll().where("task_id", "=", taskId).executeTakeFirst();
  }

  private async conversationId(taskId: string): Promise<string> {
    return (await this.db.selectFrom("tasks").select("conversation_id").where("id", "=", taskId).executeTakeFirstOrThrow()).conversation_id;
  }

  private async gatewayForTask(taskId: string): Promise<LarkGateway> {
    if (this.lark instanceof BotGatewayRegistry) {
      const task = await this.db.selectFrom("tasks").select("bot_id").where("id", "=", taskId).executeTakeFirstOrThrow();
      return this.lark.gateway(task.bot_id);
    }
    return this.lark;
  }

  private async deliveryTarget(taskId: string): Promise<{ chatId: string; chatType: string; rootMessageId: string }> {
    const conversation = await this.db
      .selectFrom("tasks")
      .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
      .select(["conversations.chat_id", "conversations.chat_type", "tasks.trigger_message_id"])
      .where("tasks.id", "=", taskId)
      .executeTakeFirstOrThrow();
    return {
      chatId: conversation.chat_id,
      chatType: conversation.chat_type,
      rootMessageId: conversation.trigger_message_id
    };
  }

  private async recordOperation(taskId: string, operation: "create_card" | "send_card" | "update_content" | "close_stream", sequence: number | null, requestUuid: string, content: string | null): Promise<void> {
    await this.db.insertInto("task_output_updates").values({ task_id: taskId, operation, sequence, request_uuid: requestUuid, content, content_hash: content ? sha256(content) : null, last_error: null, sent_at: null }).onConflict((conflict) => conflict.column("request_uuid").doNothing()).execute();
  }

  private async completeOperation(requestUuid: string): Promise<void> {
    await this.db.updateTable("task_output_updates").set({ state: "sent", attempt: 1, sent_at: new Date(), updated_at: new Date() }).where("request_uuid", "=", requestUuid).execute();
  }

  private async failOperation(requestUuid: string, error: unknown, state: "failed" | "unknown"): Promise<void> {
    await this.db.updateTable("task_output_updates").set({ state, attempt: 1, last_error: errorMessage(error), updated_at: new Date() }).where("request_uuid", "=", requestUuid).execute();
  }

  private async recordStage(taskId: string, eventType: string, summary: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.insertInto("task_events").values({ task_id: taskId, event_type: eventType, summary, payload: JSON.stringify(payload) }).execute();
  }

  private serialized<T>(taskId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(action);
    const tracked = next.finally(() => {
      if (this.queues.get(taskId) === tracked) this.queues.delete(taskId);
    });
    this.queues.set(taskId, tracked);
    return tracked;
  }
}

/**
 * App Server versions may briefly label the structured final answer as
 * commentary while streaming it. Keep lifecycle metadata out of the user-facing
 * card: incomplete JSON is buffered, and a complete task result exposes only
 * its reply field. Ordinary commentary remains unchanged.
 */
export function visibleStreamText(text: string): string | null {
  const trimmed = text.trim();
  const fencedJson = /^```(?:json)?(?:\s|$)/i.test(trimmed);
  const jsonCandidate = fencedJson
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim()
    : trimmed;
  if (!jsonCandidate.startsWith("{")) return fencedJson ? null : text;
  try {
    const result = taskTurnResultSchema.safeParse(JSON.parse(jsonCandidate));
    return result.success ? result.data.reply : null;
  } catch {
    return null;
  }
}

function isDefiniteLarkRejection(error: unknown): boolean {
  return error instanceof AppError && error.code === "lark_cli_error" && /ErrCode:\s*\d+/i.test(error.message);
}
