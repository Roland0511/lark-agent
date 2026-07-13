import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { sha256 } from "../shared/crypto.js";
import { errorMessage } from "../shared/errors.js";
import type { AdminEventBus } from "./admin-events.js";
import type { BotGatewayRegistry } from "./bot-runtime.js";
import type { BotRow } from "./bot-types.js";
import { MessageRouter } from "./message-router.js";

interface DialogueContext {
  originMessageId: string;
  botDialogueDepth: number;
}

export class BotMessageFanoutService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly gateways: BotGatewayRegistry,
    private readonly router: MessageRouter,
    private readonly events?: AdminEventBus
  ) {}

  async contextForTask(taskId: string, processedRoomSeq: number): Promise<DialogueContext | null> {
    const signals = await this.db.selectFrom("signals")
      .select(["origin_message_id", "bot_dialogue_depth", "sender_type", "message_id", "seq"])
      .where("task_id", "=", taskId).where("seq", "<=", processedRoomSeq).orderBy("seq").execute();
    const latestUser = signals.filter((signal) => signal.sender_type === "user").at(-1);
    if (latestUser) return { originMessageId: latestUser.message_id, botDialogueDepth: 1 };
    const deepest = signals.toSorted((a, b) => b.bot_dialogue_depth - a.bot_dialogue_depth)[0];
    return deepest ? { originMessageId: deepest.origin_message_id, botDialogueDepth: deepest.bot_dialogue_depth + 1 } : null;
  }

  async contextForPlatformMessage(senderBotId: string, messageId: string): Promise<DialogueContext | null> {
    const output = await this.db.selectFrom("task_outputs").innerJoin("tasks", "tasks.id", "task_outputs.task_id")
      .select(["tasks.id"])
      .where("tasks.bot_id", "=", senderBotId).where("task_outputs.message_id", "=", messageId).executeTakeFirst();
    if (!output) return null;
    const task = await this.db.selectFrom("tasks").select("turn_index").where("id", "=", output.id).executeTakeFirstOrThrow();
    const signals = await this.db.selectFrom("signals").select("seq").where("task_id", "=", output.id).orderBy("seq", "desc").executeTakeFirst();
    return this.contextForTask(output.id, signals?.seq ?? task.turn_index);
  }

  async publishFinal(taskId: string, messageId: string, content: string, processedRoomSeq: number, messageType: string): Promise<void> {
    if (!messageId) return;
    const source = await this.db.selectFrom("tasks")
      .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
      .innerJoin("bots", "bots.id", "tasks.bot_id")
      .select([
        "tasks.id as task_id", "tasks.bot_id", "conversations.chat_id", "conversations.chat_type",
        "bots.app_id", "bots.display_name"
      ]).where("tasks.id", "=", taskId).executeTakeFirstOrThrow();
    if (source.chat_type !== "group") return;
    const context = await this.contextForTask(taskId, processedRoomSeq);
    if (!context) return;

    const setting = await this.db.selectFrom("bot_dialogue_settings").select("max_consecutive_depth").where("id", "=", 1).executeTakeFirstOrThrow();
    const existingGuard = await this.db.selectFrom("bot_dialogue_guards").select("chat_id")
      .where("chat_id", "=", source.chat_id).where("origin_message_id", "=", context.originMessageId).executeTakeFirst();
    if (existingGuard || context.botDialogueDepth >= setting.max_consecutive_depth) {
      await this.guard(source, context, setting.max_consecutive_depth);
      return;
    }

    const candidates = await this.db.selectFrom("bots")
      .innerJoin("bot_chat_bindings", "bot_chat_bindings.bot_id", "bots.id")
      .selectAll("bots")
      .where("bots.id", "!=", source.bot_id)
      .where("bots.enabled", "=", true)
      .where("bots.deleted_at", "is", null)
      .where("bot_chat_bindings.chat_id", "=", source.chat_id)
      .where("bot_chat_bindings.enabled", "=", true)
      .execute();
    const counts = new Map<string, number>();
    for (const bot of candidates) counts.set(bot.display_name, (counts.get(bot.display_name) ?? 0) + 1);
    const mentioned = candidates.filter((bot) => counts.get(bot.display_name) === 1 && content.includes(`@${bot.display_name}`));
    const recipients = mentioned.length
      ? mentioned
      : (await Promise.all(candidates.map(async (bot) => {
          const active = await this.db.selectFrom("conversations").select("id").where("bot_id", "=", bot.id)
            .where("chat_id", "=", source.chat_id).where("chat_type", "=", "group").where("active", "=", true).executeTakeFirst();
          return active ? bot : null;
        }))).filter((bot): bot is BotRow => Boolean(bot));

    if (!recipients.length) {
      await this.record(taskId, "bot.fanout.skipped", "没有其他活跃机器人需要接收最终回复", { messageId, result: "no_recipient" });
      return;
    }
    for (const target of recipients) {
      const result = await this.router.route(target, {
        eventId: `bot-output:${messageId}`,
        eventType: "bot.message.final",
        messageId,
        chatId: source.chat_id,
        chatType: "group",
        rootMessageId: messageId,
        senderId: source.app_id,
        senderRole: "member",
        senderType: "bot",
        senderBotId: source.bot_id,
        senderDisplayName: source.display_name,
        ingressSource: "internal",
        originMessageId: context.originMessageId,
        botDialogueDepth: context.botDialogueDepth,
        messageType,
        content,
        explicitlyActivated: mentioned.some((bot) => bot.id === target.id),
        decisionRationale: "registered bot final reply"
      });
      await this.record(taskId, result.status === "routed" ? "bot.fanout.delivered" : "bot.fanout.skipped", result.status === "routed"
        ? `最终回复已进入机器人 ${target.display_name} 的收件箱`
        : `机器人 ${target.display_name} 未接收最终回复：${result.status}`, {
        messageId,
        targetBotId: target.id,
        targetTaskId: result.taskId,
        result: result.status,
        originMessageId: context.originMessageId,
        botDialogueDepth: context.botDialogueDepth
      });
      if (result.taskId) this.events?.publish("task", result.taskId);
    }
  }

  private async guard(
    source: { task_id: string; bot_id: string; chat_id: string; app_id: string; display_name: string },
    context: DialogueContext,
    maxDepth: number
  ): Promise<void> {
    const inserted = await this.db.insertInto("bot_dialogue_guards").values({
      chat_id: source.chat_id,
      origin_message_id: context.originMessageId,
      source_task_id: source.task_id,
      reached_depth: context.botDialogueDepth,
      notification_outbox_id: null
    }).onConflict((conflict) => conflict.columns(["chat_id", "origin_message_id"]).doNothing()).returning("chat_id").executeTakeFirst();
    await this.record(source.task_id, "bot.dialogue.guarded", "机器人连续对话已达到上限，停止继续传播", {
      originMessageId: context.originMessageId,
      botDialogueDepth: context.botDialogueDepth,
      maxDepth,
      firstGuard: Boolean(inserted)
    });
    if (!inserted) return;

    const content = `机器人连续对话已达到 ${maxDepth} 轮，已暂停并等待人类继续。`;
    const idempotencyKey = `bot-dialogue-guard-${sha256(`${source.chat_id}:${context.originMessageId}`).slice(0, 32)}`;
    const outbox = await this.db.insertInto("outbox_messages").values({
      task_id: source.task_id,
      draft_id: null,
      target_message_id: context.originMessageId,
      content,
      idempotency_key: idempotencyKey,
      operation_kind: "bot_dialogue_guard",
      state: "pending",
      platform_message_id: null,
      last_error: null,
      sent_at: null,
      updated_at: new Date()
    }).returningAll().executeTakeFirstOrThrow();
    await this.db.updateTable("bot_dialogue_guards").set({ notification_outbox_id: outbox.id })
      .where("chat_id", "=", source.chat_id).where("origin_message_id", "=", context.originMessageId).execute();
    try {
      const messageId = await (await this.gateways.gateway(source.bot_id)).sendMarkdownToChat(source.chat_id, content, idempotencyKey);
      await this.db.updateTable("outbox_messages").set({ state: "sent", platform_message_id: messageId, sent_at: new Date(), updated_at: new Date(), attempt: 1 }).where("id", "=", outbox.id).execute();
    } catch (error) {
      await this.db.updateTable("outbox_messages").set({ state: "unknown", last_error: errorMessage(error), updated_at: new Date(), attempt: 1 }).where("id", "=", outbox.id).execute();
    }
    this.events?.publish("outbox", outbox.id);
  }

  private async record(taskId: string, eventType: string, summary: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.insertInto("task_events").values({ task_id: taskId, event_type: eventType, summary, payload: JSON.stringify(payload) }).execute();
  }
}
