import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LarkCardActionEvent, LarkMessageEvent } from "../shared/contracts.js";
import type { ControlPlaneConfig } from "./config.js";
import { LarkGateway } from "../lark/gateway.js";
import { sha256 } from "../shared/crypto.js";
import { randomToken } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import type { ControlPlaneRepository } from "./repository.js";
import { legacyBotId, type BotRow } from "./bot-types.js";
import { MessageRouter } from "./message-router.js";

const helpCommands = new Set(["/help", "/帮助"]);

export class EventRouter {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: ControlPlaneConfig,
    private readonly lark: LarkGateway,
    private readonly repository: ControlPlaneRepository,
    private readonly bot: BotRow = {
      id: legacyBotId, app_id: config.botAppId, profile_name: null, bot_open_id: config.botAppId,
      display_name: config.agentDisplayName, role_instructions: "", owner_open_id: config.ownerOpenId,
      attention_model: null, attention_reasoning_effort: null, execution_model: null, execution_reasoning_effort: null,
      default_executor_id: null, default_workspace_alias: null, enabled: true, is_system: true,
      config_revision: 1, credential_state: "verified", credential_error: null, deleted_at: null,
      created_at: new Date(), updated_at: new Date()
    },
    private readonly messageRouter = new MessageRouter(db)
  ) {}

  async handleMessage(event: LarkMessageEvent): Promise<void> {
    const duplicate = await this.db.selectFrom("processed_events").select("event_id").where("bot_id", "=", this.bot.id).where("event_id", "=", event.event_id).executeTakeFirst();
    if (duplicate) return;

    const registeredBots = await this.db
      .selectFrom("bots")
      .selectAll()
      .where("deleted_at", "is", null)
      .execute();
    const senderBot = registeredBots.find((item) => item.app_id === event.sender_id || item.bot_open_id === event.sender_id) ?? null;
    if (senderBot?.id === this.bot.id) {
      await this.markDiscarded(event.event_id, event.type);
      return;
    }

    const displayNameCounts = new Map<string, number>();
    for (const item of registeredBots) displayNameCounts.set(item.display_name, (displayNameCounts.get(item.display_name) ?? 0) + 1);
    const fastMentionedBotIds = new Set(
      event.chat_type === "group" && (event.sender_id === this.bot.owner_open_id || Boolean(senderBot))
        ? registeredBots
            .filter((item) => displayNameCounts.get(item.display_name) === 1 && event.content.includes(`@${item.display_name}`))
            .map((item) => item.id)
        : []
    );
    const canUseOwnerMentionFastPath = fastMentionedBotIds.size > 0;
    const details = canUseOwnerMentionFastPath ? null : await this.lark.getMessage(event.message_id);
    if (details?.senderType === "app" && !senderBot) {
      await this.markDiscarded(event.event_id, event.type);
      return;
    }
    if (event.chat_type === "p2p") {
      const command = event.content.trim();
      const binding = command.match(/^\/绑定控制台\s+([A-Za-z0-9_-]{20,256})$/);
      if (binding?.[1]) {
        await this.handleOwnerBinding(event, binding[1]);
        return;
      }
      if (helpCommands.has(command)) {
        await this.handleHelp(event);
        return;
      }
      if (command === "/连接控制台") {
        await this.handleAdminConnect(event);
        return;
      }
    }
    const rootMessageId = details?.rootId ?? event.message_id;
    const mentionIds = new Set(details?.mentions.map((mention) => mention.id) ?? []);
    const hasRegisteredBotMention = canUseOwnerMentionFastPath || registeredBots.some((item) => mentionIds.has(item.app_id) || Boolean(item.bot_open_id && mentionIds.has(item.bot_open_id)));
    const mentionsThisBot = canUseOwnerMentionFastPath
      ? fastMentionedBotIds.has(this.bot.id)
      : mentionIds.has(this.bot.app_id) || Boolean(this.bot.bot_open_id && mentionIds.has(this.bot.bot_open_id));
    if (event.chat_type === "group" && hasRegisteredBotMention && !mentionsThisBot) return;
    const explicitlyActivated = event.chat_type === "p2p" || mentionsThisBot;
    const sourceContext = senderBot ? await this.botMessageContext(senderBot.id, event.message_id) : null;
    await this.messageRouter.route(this.bot, {
      eventId: event.event_id,
      eventType: event.type,
      messageId: event.message_id,
      chatId: event.chat_id,
      chatType: event.chat_type,
      rootMessageId,
      senderId: event.sender_id,
      senderRole: senderBot ? "member" : event.sender_id === this.bot.owner_open_id ? "owner" : "member",
      senderType: senderBot ? "bot" : "user",
      senderBotId: senderBot?.id ?? null,
      senderDisplayName: senderBot?.display_name ?? null,
      ingressSource: "lark",
      originMessageId: sourceContext?.originMessageId ?? event.message_id,
      botDialogueDepth: sourceContext?.botDialogueDepth ?? (senderBot ? 1 : 0),
      messageType: event.message_type,
      content: event.content,
      explicitlyActivated,
      receivedAt: new Date()
    });
  }

  private async botMessageContext(senderBotId: string, messageId: string): Promise<{ originMessageId: string; botDialogueDepth: number } | null> {
    const output = await this.db.selectFrom("task_outputs").innerJoin("tasks", "tasks.id", "task_outputs.task_id")
      .select(["tasks.id"]).where("tasks.bot_id", "=", senderBotId).where("task_outputs.message_id", "=", messageId).executeTakeFirst();
    if (!output) return null;
    const signals = await this.db.selectFrom("signals").select(["origin_message_id", "bot_dialogue_depth", "sender_type", "created_at"])
      .where("task_id", "=", output.id).orderBy("seq").execute();
    const latestUser = signals.filter((signal) => signal.sender_type === "user").at(-1);
    if (latestUser) return { originMessageId: latestUser.origin_message_id, botDialogueDepth: 1 };
    const deepest = signals.toSorted((a, b) => b.bot_dialogue_depth - a.bot_dialogue_depth)[0];
    return deepest ? { originMessageId: deepest.origin_message_id, botDialogueDepth: deepest.bot_dialogue_depth + 1 } : null;
  }

  async handleCardAction(event: LarkCardActionEvent): Promise<void> {
    const duplicate = await this.db.selectFrom("processed_events").select("event_id").where("bot_id", "=", this.bot.id).where("event_id", "=", event.event_id).executeTakeFirst();
    if (duplicate) return;
    const marker = await this.db.insertInto("processed_events").values({ bot_id: this.bot.id, event_id: event.event_id, event_type: event.type, status: "processed", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
    if (!marker) return;
    if (event.operator_id !== this.bot.owner_open_id) throw new AppError("only the owner may use task control cards", 403, "owner_required");
    let action: { action?: string; taskId?: string; approvalId?: string };
    try {
      action = JSON.parse(event.action_value) as typeof action;
    } catch {
      throw new AppError("invalid card action payload", 400, "invalid_card_action");
    }
    if (!action.taskId || !action.action) throw new AppError("card action is missing taskId/action", 400, "invalid_card_action");
    if (action.action === "approve" || action.action === "reject") {
      if (!action.approvalId) throw new AppError("approvalId is required", 400, "invalid_card_action");
      await this.repository.decideApproval(action.approvalId, event.operator_id, action.action === "approve");
      return;
    }
    const task = await this.db.selectFrom("tasks").selectAll().where("id", "=", action.taskId).executeTakeFirstOrThrow();
    if (action.action === "handoff") {
      await this.db.updateTable("tasks").set({ state: "human_owned", revision: sql`revision + 1`, summary: "主人请求本机接手", updated_at: new Date() }).where("id", "=", task.id).execute();
      await this.db.updateTable("conversations").set({ active: true, updated_at: new Date() }).where("id", "=", task.conversation_id).execute();
    } else if (action.action === "return_agent") {
      await this.db.updateTable("tasks").set({ state: "waiting_worker", revision: sql`revision + 1`, preferred_executor_id: task.executor_id, lease_token_hash: null, lease_expires_at: null, updated_at: new Date() }).where("id", "=", task.id).execute();
      await this.db.updateTable("conversations").set({ active: true, updated_at: new Date() }).where("id", "=", task.conversation_id).execute();
    } else if (action.action === "complete") {
      await this.db.updateTable("tasks").set({ state: "completed", revision: sql`revision + 1`, completed_at: new Date(), updated_at: new Date() }).where("id", "=", task.id).execute();
      await this.db.updateTable("conversations").set({ active: false, updated_at: new Date() }).where("id", "=", task.conversation_id).execute();
    } else if (action.action === "cancel") {
      await this.db.updateTable("tasks").set({ state: "cancelled", revision: sql`revision + 1`, completed_at: new Date(), lease_token_hash: null, lease_expires_at: null, updated_at: new Date() }).where("id", "=", task.id).execute();
      await this.db.updateTable("conversations").set({ active: false, updated_at: new Date() }).where("id", "=", task.conversation_id).execute();
    }
  }

  private async markDiscarded(eventId: string, eventType: string): Promise<void> {
    await this.db.insertInto("processed_events").values({ bot_id: this.bot.id, event_id: eventId, event_type: eventType, status: "discarded", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).execute();
  }

  private async handleHelp(event: LarkMessageEvent): Promise<void> {
    await this.lark.sendMarkdownToChat(
      event.chat_id,
      [
        `**${this.bot.display_name} 可用指令**`,
        "",
        "- `/帮助` 或 `/help`：查看这份指令列表。",
        "- `/连接控制台`：生成 2 分钟内有效、仅可使用一次的控制台连接；仅主人可用。",
        "",
        `请在与 ${this.bot.display_name} 的私聊中单独发送指令，不要添加其他文字。`
      ].join("\n"),
      `command-help-${sha256(event.event_id).slice(0, 24)}`
    );
    await this.db.insertInto("processed_events").values({ bot_id: this.bot.id, event_id: event.event_id, event_type: event.type, status: "command_help", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).execute();
  }

  private async handleAdminConnect(event: LarkMessageEvent): Promise<void> {
    const role = event.sender_id === this.bot.owner_open_id ? "owner" : null;
    if (!role) {
      await this.lark.sendMarkdownToChat(event.chat_id, "当前飞书身份没有 Lark Agent 控制台权限。", `admin-connect-denied-${sha256(event.event_id).slice(0, 24)}`);
      await this.markDiscarded(event.event_id, event.type);
      return;
    }
    const token = randomToken(48);
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom("admin_login_tokens").where("open_id", "=", event.sender_id).where("consumed_at", "is", null).execute();
      await trx.insertInto("admin_login_tokens").values({
        token_hash: sha256(token),
        open_id: event.sender_id,
        role,
        expires_at: new Date(Date.now() + 2 * 60_000),
        consumed_at: null
      }).execute();
    });
    const link = `${this.config.adminOrigin}/admin/login#token=${token}`;
    await this.lark.sendMarkdownToChat(
      event.chat_id,
      [
        `**${this.bot.display_name} 控制台 · 身份确认**`,
        "",
        `已确认你的飞书身份。请在 2 分钟内点击：[打开 ${this.bot.display_name} 控制台](${link})`,
        "",
        "该链接仅可使用一次，请勿转发。"
      ].join("\n"),
      `admin-connect-${sha256(event.event_id).slice(0, 24)}`
    );
    await this.db.insertInto("processed_events").values({ bot_id: this.bot.id, event_id: event.event_id, event_type: event.type, status: "admin_login", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).execute();
  }

  private async handleOwnerBinding(event: LarkMessageEvent, token: string): Promise<void> {
    const tokenHash = sha256(token);
    const bound = await this.db.transaction().execute(async (trx) => {
      const record = await trx.selectFrom("bot_owner_binding_tokens").selectAll().where("token_hash", "=", tokenHash).where("bot_id", "=", this.bot.id).forUpdate().executeTakeFirst();
      if (!record || record.consumed_at || new Date(record.expires_at).getTime() <= Date.now()) return false;
      await trx.updateTable("bot_owner_binding_tokens").set({ consumed_at: new Date() }).where("token_hash", "=", tokenHash).execute();
      await trx.updateTable("bots").set({ owner_open_id: event.sender_id, updated_at: new Date() }).where("id", "=", this.bot.id).execute();
      await trx.insertInto("processed_events").values({ bot_id: this.bot.id, event_id: event.event_id, event_type: event.type, status: "owner_bound", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).execute();
      return true;
    });
    if (bound) this.bot.owner_open_id = event.sender_id;
    await this.lark.sendMarkdownToChat(event.chat_id, bound ? "机器人已成功绑定到 Lark Agent 控制台。" : "绑定指令无效或已经过期，请在控制台重新生成。", `owner-binding-${sha256(event.event_id).slice(0, 24)}`);
  }
}
