import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { LarkCardActionEvent, LarkMessageEvent } from "../shared/contracts.js";
import { authorizationFromMessage } from "./policy.js";
import type { ControlPlaneConfig } from "./config.js";
import { LarkGateway } from "../lark/gateway.js";
import { sha256 } from "../shared/crypto.js";
import { randomToken } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import type { ControlPlaneRepository } from "./repository.js";
import { legacyBotId, type BotRow } from "./bot-types.js";

const activeTaskStates = ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"] as const;
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
      default_executor_id: null, default_workspace_alias: null, enabled: true, is_system: true,
      config_revision: 1, credential_state: "verified", credential_error: null, deleted_at: null,
      created_at: new Date(), updated_at: new Date()
    }
  ) {}

  async handleMessage(event: LarkMessageEvent): Promise<void> {
    const duplicate = await this.db.selectFrom("processed_events").select("event_id").where("bot_id", "=", this.bot.id).where("event_id", "=", event.event_id).executeTakeFirst();
    if (duplicate) return;
    const details = await this.lark.getMessage(event.message_id);
    if (details.senderType === "app") {
      await this.markDiscarded(event.event_id, event.type);
      return;
    }
    if (event.chat_type === "p2p") {
      const command = details.content.trim();
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
    if (event.chat_type === "group") {
      const binding = await this.db.selectFrom("bot_chat_bindings").selectAll().where("bot_id", "=", this.bot.id).where("chat_id", "=", event.chat_id).where("enabled", "=", true).executeTakeFirst();
      if (!binding) return;
    }

    const rootMessageId = details.rootId ?? details.messageId;
    const mentionIds = new Set(details.mentions.map((mention) => mention.id));
    const registeredBots = event.chat_type === "group" && mentionIds.size
      ? await this.db.selectFrom("bots").select(["app_id", "bot_open_id"]).where("deleted_at", "is", null).execute()
      : [];
    const hasRegisteredBotMention = registeredBots.some((item) => mentionIds.has(item.app_id) || Boolean(item.bot_open_id && mentionIds.has(item.bot_open_id)));
    const mentionsThisBot = mentionIds.has(this.bot.app_id) || Boolean(this.bot.bot_open_id && mentionIds.has(this.bot.bot_open_id));
    if (event.chat_type === "group" && hasRegisteredBotMention && !mentionsThisBot) return;
    const explicitlyActivated = event.chat_type === "p2p" || mentionsThisBot;

    let createdTaskId: string | null = null;
    await this.db.transaction().execute(async (trx) => {
      if (event.chat_type === "group") {
        await sql`select pg_advisory_xact_lock(hashtext(${`${this.bot.id}:${event.chat_id}`}))`.execute(trx);
      }
      let conversation = event.chat_type === "group"
        ? await trx
            .selectFrom("conversations")
            .selectAll()
            .where("bot_id", "=", this.bot.id)
            .where("chat_id", "=", event.chat_id)
            .where("chat_type", "=", "group")
            .where("active", "=", true)
            .orderBy("created_at", "desc")
            .forUpdate()
            .executeTakeFirst()
        : await trx
            .selectFrom("conversations")
            .selectAll()
            .where("bot_id", "=", this.bot.id)
            .where("chat_id", "=", event.chat_id)
            .where("root_message_id", "=", rootMessageId)
            .forUpdate()
            .executeTakeFirst();
      if (conversation?.followup_expires_at && new Date(conversation.followup_expires_at).getTime() <= Date.now()) {
        const activeTask = await trx.selectFrom("tasks").select("id").where("conversation_id", "=", conversation.id).where("state", "in", [...activeTaskStates]).executeTakeFirst();
        if (!activeTask) {
          await trx.updateTable("conversations").set({ active: false, followup_expires_at: null, updated_at: new Date() }).where("id", "=", conversation.id).execute();
          conversation = undefined;
        }
      }
      if (!conversation && !explicitlyActivated) return;
      const marker = await trx.insertInto("processed_events").values({ bot_id: this.bot.id, event_id: event.event_id, event_type: event.type, status: "processed", processed_at: new Date() }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
      if (!marker) return;
      if (!conversation) {
        conversation = await trx
          .insertInto("conversations")
          .values({
            bot_id: this.bot.id,
            bot_config_revision: this.bot.config_revision,
            role_instructions_snapshot: this.bot.role_instructions,
            chat_id: event.chat_id,
            chat_type: event.chat_type,
            root_message_id: rootMessageId,
            thread_id: null,
            room_seq: 0,
            active: true,
            response_message_id: null,
            followup_expires_at: null,
            updated_at: new Date()
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      let task = await trx
        .selectFrom("tasks")
        .selectAll()
        .where("conversation_id", "=", conversation.id)
        .where("state", "in", [...activeTaskStates])
        .orderBy("created_at", "desc")
        .executeTakeFirst();
      if (!task) {
        const policy = await trx.selectFrom("bot_chat_bindings").selectAll().where("bot_id", "=", this.bot.id).where("chat_id", "=", event.chat_id).executeTakeFirst();
        const owner = event.sender_id === this.bot.owner_open_id;
        const previous = await trx.selectFrom("tasks").selectAll().where("conversation_id", "=", conversation.id).orderBy("turn_index", "desc").executeTakeFirst();
        if (previous && !conversation.active) return;
        task = await trx
          .insertInto("tasks")
          .values({
            bot_id: this.bot.id,
            conversation_id: conversation.id,
            state: previous ? "waiting_worker" : "queued",
            turn_index: (previous?.turn_index ?? 0) + 1,
            trigger_message_id: event.message_id,
            conversation_disposition: null,
            disposition_reason: null,
            requester_id: event.sender_id,
            requester_role: owner ? "owner" : "member",
            authorization_grant: JSON.stringify(authorizationFromMessage(event.content, owner)),
            requested_workspace_alias: previous?.requested_workspace_alias ?? policy?.workspace_alias ?? this.bot.default_workspace_alias,
            resolved_workspace_alias: previous?.resolved_workspace_alias ?? null,
            preferred_executor_id: previous?.executor_id ?? previous?.preferred_executor_id ?? policy?.preferred_executor_id ?? this.bot.default_executor_id,
            executor_id: previous?.executor_id ?? null,
            codex_thread_id: previous?.codex_thread_id ?? null,
            executor_home_ref: previous?.executor_home_ref ?? null,
            executor_profile: previous?.executor_profile ?? null,
            executor_config_fingerprint: previous?.executor_config_fingerprint ?? null,
            codex_version: previous?.codex_version ?? null,
            lease_token_hash: null,
            lease_expires_at: null,
            summary: null,
            completed_at: null,
            updated_at: new Date()
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        createdTaskId = task.id;
      }
      const nextSeq = conversation.room_seq + 1;
      await trx.updateTable("conversations").set({ room_seq: nextSeq, active: true, thread_id: null, updated_at: new Date() }).where("id", "=", conversation.id).execute();
      await trx
        .insertInto("signals")
        .values({
          bot_id: this.bot.id,
          conversation_id: conversation.id,
          task_id: task.id,
          event_id: event.event_id,
          seq: nextSeq,
          message_id: event.message_id,
          sender_id: event.sender_id,
          sender_role: event.sender_id === this.bot.owner_open_id ? "owner" : "member",
          message_type: event.message_type,
          content: event.content,
          preview: event.content.slice(0, 500),
          priority: explicitlyActivated ? 90 : 50,
          decision: "pending",
          decision_rationale: null,
          decided_at: null
        })
        .execute();
    });

    void createdTaskId;
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
