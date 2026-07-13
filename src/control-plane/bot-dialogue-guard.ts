import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { sha256 } from "../shared/crypto.js";
import { errorMessage } from "../shared/errors.js";
import type { AdminEventBus } from "./admin-events.js";
import type { BotGatewayRegistry } from "./bot-runtime.js";
import type { BotMessageContext } from "./bot-message-context.js";

export class BotDialogueGuardService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly gateways: BotGatewayRegistry,
    private readonly events?: AdminEventBus
  ) {}

  async isSystemNotice(messageId: string): Promise<boolean> {
    const row = await this.db.selectFrom("outbox_messages").select("id")
      .where("platform_message_id", "=", messageId)
      .where("operation_kind", "=", "bot_dialogue_guard")
      .executeTakeFirst();
    return Boolean(row);
  }

  async guardIfNeeded(sourceBotId: string, chatId: string, context: BotMessageContext): Promise<boolean> {
    const setting = await this.db.selectFrom("bot_dialogue_settings").select("max_consecutive_depth").where("id", "=", 1).executeTakeFirstOrThrow();
    const existing = await this.db.selectFrom("bot_dialogue_guards").select("chat_id")
      .where("chat_id", "=", chatId).where("origin_message_id", "=", context.originMessageId).executeTakeFirst();
    if (!existing && context.botDialogueDepth < setting.max_consecutive_depth) return false;

    const inserted = await this.db.insertInto("bot_dialogue_guards").values({
      chat_id: chatId,
      origin_message_id: context.originMessageId,
      source_task_id: context.sourceTaskId,
      reached_depth: context.botDialogueDepth,
      notification_outbox_id: null
    }).onConflict((conflict) => conflict.columns(["chat_id", "origin_message_id"]).doNothing()).returning("chat_id").executeTakeFirst();
    await this.db.insertInto("task_events").values({
      task_id: context.sourceTaskId,
      event_type: "bot.dialogue.guarded",
      summary: "机器人连续对话已达到上限，原生消息不再进入其他机器人收件箱",
      payload: JSON.stringify({
        originMessageId: context.originMessageId,
        botDialogueDepth: context.botDialogueDepth,
        maxDepth: setting.max_consecutive_depth,
        firstGuard: Boolean(inserted)
      })
    }).execute();
    if (!inserted) return true;

    const content = `机器人连续对话已达到 ${setting.max_consecutive_depth} 轮，已暂停并等待人类继续。`;
    const idempotencyKey = `bot-dialogue-guard-${sha256(`${chatId}:${context.originMessageId}`).slice(0, 32)}`;
    const outbox = await this.db.insertInto("outbox_messages").values({
      task_id: context.sourceTaskId,
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
      .where("chat_id", "=", chatId).where("origin_message_id", "=", context.originMessageId).execute();
    try {
      const messageId = await (await this.gateways.gateway(sourceBotId)).sendMarkdownToChat(chatId, content, idempotencyKey);
      await this.db.updateTable("outbox_messages").set({ state: "sent", platform_message_id: messageId, sent_at: new Date(), updated_at: new Date(), attempt: 1 }).where("id", "=", outbox.id).execute();
    } catch (error) {
      await this.db.updateTable("outbox_messages").set({ state: "unknown", last_error: errorMessage(error), updated_at: new Date(), attempt: 1 }).where("id", "=", outbox.id).execute();
    }
    this.events?.publish("outbox", outbox.id);
    return true;
  }
}
