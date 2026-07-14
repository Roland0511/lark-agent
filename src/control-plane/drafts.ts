import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { ControlPlaneConfig } from "./config.js";
import { LarkGateway } from "../lark/gateway.js";
import { AppError, errorMessage } from "../shared/errors.js";
import { sha256 } from "../shared/crypto.js";
import type { LarkMessageDetails } from "../shared/contracts.js";
import { extractLarkAttachments, safeMessageContent } from "../lark/attachments.js";
import { TaskOutputService } from "./task-output.js";
import { BotGatewayRegistry } from "./bot-runtime.js";
import { botMessageContextForPlatformMessage } from "./bot-message-context.js";
import type { BotDialogueGuardService } from "./bot-dialogue-guard.js";

export class DraftService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: ControlPlaneConfig,
    private readonly lark: LarkGateway | BotGatewayRegistry,
    private readonly outputs: TaskOutputService,
    private readonly dialogueGuard?: BotDialogueGuardService
  ) {}

  async submit(taskId: string, content: string, baseRoomSeq: number, force: boolean) {
    const task = await this.db.selectFrom("tasks").selectAll().where("id", "=", taskId).executeTakeFirstOrThrow();
    await this.reconcileUnseenMessages(task.id, task.conversation_id);
    const conversation = await this.db.selectFrom("conversations").selectAll().where("id", "=", task.conversation_id).executeTakeFirstOrThrow();
    const held = conversation.room_seq !== baseRoomSeq || force;
    await this.db.insertInto("task_events").values({
      task_id: task.id,
      event_type: "draft.checked",
      summary: held ? "草稿版本已过期，进入搁置" : "草稿新鲜度检查通过",
      payload: JSON.stringify({ baseRoomSeq, observedRoomSeq: conversation.room_seq, held, force })
    }).execute();
    const draft = await this.db
      .insertInto("drafts")
      .values({
        task_id: task.id,
        conversation_id: conversation.id,
        base_room_seq: baseRoomSeq,
        observed_room_seq: conversation.room_seq,
        content,
        state: held ? "held" : "drafted",
        hold_count: held ? 1 : 0,
        force_requested: force,
        updated_at: new Date(),
        sent_at: null
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (held) {
      await this.db.updateTable("tasks").set({ state: "held_draft", revision: sql`revision + 1`, updated_at: new Date() }).where("id", "=", task.id).execute();
      await this.outputs.markHeld(task.id);
      return { draft, sent: false, held: true };
    }

    const idempotencyKey = `draft-${draft.id}`;
    const outbox = await this.db
      .insertInto("outbox_messages")
      .values({
        task_id: task.id,
        draft_id: draft.id,
        target_message_id: task.trigger_message_id,
        content,
        idempotency_key: idempotencyKey,
        operation_kind: "card_finalize",
        state: "pending",
        platform_message_id: null,
        last_error: null,
        sent_at: null,
        updated_at: new Date()
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    if (!this.config.larkEnabled) {
      await this.db.transaction().execute(async (trx) => {
        await trx.updateTable("outbox_messages").set({ state: "simulated", updated_at: new Date() }).where("id", "=", outbox.id).execute();
        await trx.updateTable("drafts").set({ state: "approved", updated_at: new Date() }).where("id", "=", draft.id).execute();
      });
      return { draft: { ...draft, state: "approved" as const }, sent: false, held: false, simulated: true };
    }
    try {
      const delivery = await this.outputs.finalize(task.id, content, idempotencyKey);
      const platformMessageId = delivery.messageId;
      const now = new Date();
      await this.db.transaction().execute(async (trx) => {
        await trx.updateTable("outbox_messages").set({ state: "sent", platform_message_id: platformMessageId, sent_at: now, updated_at: now, attempt: outbox.attempt + 1 }).where("id", "=", outbox.id).execute();
        await trx.updateTable("drafts").set({ state: "sent", sent_at: now, updated_at: now }).where("id", "=", draft.id).execute();
      });
      return { draft, sent: true, held: false, platformMessageId };
    } catch (error) {
      await this.db.updateTable("outbox_messages").set({ state: "unknown", last_error: errorMessage(error), updated_at: new Date(), attempt: outbox.attempt + 1 }).where("id", "=", outbox.id).execute();
      await this.db.updateTable("tasks").set({ state: "waiting_input", revision: sql`revision + 1`, summary: "飞书发送结果不确定，需要人工核查", updated_at: new Date() }).where("id", "=", task.id).execute();
      throw error;
    }
  }

  private async reconcileUnseenMessages(taskId: string, conversationId: string): Promise<void> {
    if (!this.config.larkEnabled) return;
    const [conversation, task] = await Promise.all([
      this.db.selectFrom("conversations").selectAll().where("id", "=", conversationId).executeTakeFirstOrThrow(),
      this.db.selectFrom("tasks").select(["created_at", "bot_id"]).where("id", "=", taskId).executeTakeFirstOrThrow()
    ]);
    // A private top-level message is an independent task. Listing the whole P2P
    // chat would incorrectly merge later independent tasks into this one.
    if (conversation.chat_type !== "group") return;
    const messages: LarkMessageDetails[] = [];
    const end = new Date();
    let pageToken: string | undefined;
    do {
      const gateway = this.lark instanceof BotGatewayRegistry ? await this.lark.gateway(task.bot_id) : this.lark;
      const page = await gateway.listChatMessages(conversation.chat_id, new Date(task.created_at), end, pageToken);
      messages.push(...page.messages);
      pageToken = page.hasMore && page.pageToken ? page.pageToken : undefined;
    } while (pageToken && messages.length < 500);
    messages.splice(500);
    messages.reverse();
    const registeredBots = await this.db.selectFrom("bots").select(["id", "app_id", "display_name", "owner_open_id"])
      .where("deleted_at", "is", null).execute();
    const currentBot = registeredBots.find((bot) => bot.id === task.bot_id);
    for (const message of messages) {
      const rawContent = message.rawContent ?? message.content;
      const attachments = extractLarkAttachments(message.messageType, rawContent);
      const safeContent = safeMessageContent(message.messageType, rawContent, attachments);
      const senderBot = message.senderType === "app" ? registeredBots.find((bot) => bot.app_id === message.senderId) ?? null : null;
      if (message.senderType === "app" && (!senderBot || senderBot.id === currentBot?.id)) continue;
      if (message.senderType === "app") {
        const systemMessage = await this.db.selectFrom("outbox_messages").select("id")
          .where("platform_message_id", "=", message.messageId)
          .where("operation_kind", "=", "bot_dialogue_guard")
          .executeTakeFirst();
        if (systemMessage) continue;
      }
      const known = await this.db.selectFrom("signals").select("id").where("bot_id", "=", task.bot_id).where("message_id", "=", message.messageId).executeTakeFirst();
      if (known) continue;
      const syntheticEventId = `refresh:${sha256(message.messageId).slice(0, 32)}`;
      const context = senderBot ? await botMessageContextForPlatformMessage(this.db, senderBot.id, message.messageId) : null;
      if (senderBot && context && await this.dialogueGuard?.guardIfNeeded(senderBot.id, conversation.chat_id, context)) continue;
      await this.db.transaction().execute(async (trx) => {
        const inserted = await trx.insertInto("processed_events").values({ bot_id: task.bot_id, event_id: syntheticEventId, event_type: "chat.refresh", status: "processed", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
        if (!inserted) return;
        const current = await trx.selectFrom("conversations").select("room_seq").where("id", "=", conversationId).forUpdate().executeTakeFirstOrThrow();
        const duplicate = await trx.selectFrom("signals").select("id").where("bot_id", "=", task.bot_id).where("message_id", "=", message.messageId).executeTakeFirst();
        if (duplicate) return;
        const nextSeq = current.room_seq + 1;
        await trx.updateTable("conversations").set({ room_seq: nextSeq, updated_at: new Date() }).where("id", "=", conversationId).execute();
        await trx.insertInto("signals").values({
          bot_id: task.bot_id,
          conversation_id: conversationId,
          task_id: taskId,
          event_id: syntheticEventId,
          seq: nextSeq,
          message_id: message.messageId,
          sender_id: message.senderId,
          sender_role: senderBot ? "member" : message.senderId === currentBot?.owner_open_id ? "owner" : "member",
          sender_type: senderBot ? "bot" : "user",
          sender_bot_id: senderBot?.id ?? null,
          sender_display_name: senderBot?.display_name ?? null,
          ingress_source: "history",
          origin_message_id: context?.originMessageId ?? message.messageId,
          bot_dialogue_depth: context?.botDialogueDepth ?? (senderBot ? 1 : 0),
          message_type: message.messageType,
          content: safeContent,
          preview: safeContent.slice(0, 500),
          attachments: JSON.stringify(attachments),
          priority: 80,
          decision: "pending",
          decision_rationale: "reconciled before draft send",
          decided_at: null
        }).execute();
      });
    }
  }
}
