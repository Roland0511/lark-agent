import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { authorizationFromMessage } from "./policy.js";
import type { BotRow } from "./bot-types.js";

const activeTaskStates = ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"] as const;

export interface RoutableMessage {
  eventId: string;
  eventType: string;
  messageId: string;
  chatId: string;
  chatType: "p2p" | "group";
  rootMessageId: string;
  senderId: string;
  senderRole: "owner" | "member";
  senderType: "user" | "bot";
  senderBotId: string | null;
  senderDisplayName: string | null;
  ingressSource: "lark" | "internal" | "history";
  originMessageId: string;
  botDialogueDepth: number;
  messageType: string;
  content: string;
  explicitlyActivated: boolean;
  receivedAt?: Date;
  decisionRationale?: string | null;
}

export interface RoutedMessageResult {
  taskId: string | null;
  signalId: string | null;
  status: "routed" | "duplicate" | "inactive" | "unbound";
}

export class MessageRouter {
  constructor(private readonly db: Kysely<Database>) {}

  async route(bot: BotRow, message: RoutableMessage): Promise<RoutedMessageResult> {
    if (message.chatType === "group") {
      const binding = await this.db.selectFrom("bot_chat_bindings").select("bot_id")
        .where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId).where("enabled", "=", true).executeTakeFirst();
      if (!binding) return { taskId: null, signalId: null, status: "unbound" };
    }

    return this.db.transaction().execute(async (trx) => {
      if (message.chatType === "group") {
        await sql`select pg_advisory_xact_lock(hashtext(${`${bot.id}:${message.chatId}`}))`.execute(trx);
      }
      const duplicateSignal = await trx.selectFrom("signals").select(["id", "task_id"])
        .where("bot_id", "=", bot.id).where("message_id", "=", message.messageId).executeTakeFirst();
      if (duplicateSignal) return { taskId: duplicateSignal.task_id, signalId: duplicateSignal.id, status: "duplicate" };

      let conversation = message.chatType === "group"
        ? await trx.selectFrom("conversations").selectAll().where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId)
            .where("chat_type", "=", "group").where("active", "=", true).orderBy("created_at", "desc").forUpdate().executeTakeFirst()
        : await trx.selectFrom("conversations").selectAll().where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId)
            .where("root_message_id", "=", message.rootMessageId).forUpdate().executeTakeFirst();

      if (conversation?.followup_expires_at && new Date(conversation.followup_expires_at).getTime() <= Date.now()) {
        const activeTask = await trx.selectFrom("tasks").select("id").where("conversation_id", "=", conversation.id)
          .where("state", "in", [...activeTaskStates]).executeTakeFirst();
        if (!activeTask) {
          await trx.updateTable("conversations").set({ active: false, followup_expires_at: null, updated_at: new Date() }).where("id", "=", conversation.id).execute();
          conversation = undefined;
        }
      }
      if (!conversation && !message.explicitlyActivated) return { taskId: null, signalId: null, status: "inactive" };

      const marker = await trx.insertInto("processed_events").values({
        bot_id: bot.id,
        event_id: message.eventId,
        event_type: message.eventType,
        status: "processed",
        processed_at: new Date()
      }).onConflict((conflict) => conflict.columns(["bot_id", "event_id"]).doNothing()).returning("event_id").executeTakeFirst();
      if (!marker) return { taskId: null, signalId: null, status: "duplicate" };

      if (!conversation) {
        conversation = await trx.insertInto("conversations").values({
          bot_id: bot.id,
          bot_config_revision: bot.config_revision,
          role_instructions_snapshot: bot.role_instructions,
          attention_model_snapshot: bot.attention_model,
          attention_reasoning_effort_snapshot: bot.attention_reasoning_effort,
          execution_model_snapshot: bot.execution_model,
          execution_reasoning_effort_snapshot: bot.execution_reasoning_effort,
          chat_id: message.chatId,
          chat_type: message.chatType,
          root_message_id: message.rootMessageId,
          thread_id: null,
          room_seq: 0,
          active: true,
          response_message_id: null,
          followup_expires_at: null,
          updated_at: new Date()
        }).returningAll().executeTakeFirstOrThrow();
      }

      let task = await trx.selectFrom("tasks").selectAll().where("conversation_id", "=", conversation.id)
        .where("state", "in", [...activeTaskStates]).orderBy("created_at", "desc").executeTakeFirst();
      let createdTask = false;
      if (!task) {
        const policy = await trx.selectFrom("bot_chat_bindings").selectAll().where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId).executeTakeFirst();
        const previous = await trx.selectFrom("tasks").selectAll().where("conversation_id", "=", conversation.id).orderBy("turn_index", "desc").executeTakeFirst();
        if (previous && !conversation.active) return { taskId: null, signalId: null, status: "inactive" };
        const requestedWorkspaceAlias = previous?.requested_workspace_alias ?? policy?.workspace_alias ?? bot.default_workspace_alias;
        let preferredExecutorId = previous?.executor_id ?? previous?.preferred_executor_id ?? policy?.preferred_executor_id ?? bot.default_executor_id;
        let routeAmbiguous = false;
        if (!preferredExecutorId) {
          const workers = await trx.selectFrom("workers").select(["executor_id", "workspace_aliases"])
            .where("deleted_at", "is", null).where("operational_mode", "=", "enabled").execute();
          const eligible = workers.filter((worker) => {
            const aliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
            return requestedWorkspaceAlias ? aliases.includes(requestedWorkspaceAlias) : aliases.length === 1;
          });
          if (eligible.length === 1) preferredExecutorId = eligible[0]!.executor_id;
          else if (eligible.length > 1) routeAmbiguous = true;
        }
        task = await trx.insertInto("tasks").values({
          bot_id: bot.id,
          conversation_id: conversation.id,
          state: routeAmbiguous ? "waiting_input" : previous ? "waiting_worker" : "queued",
          turn_index: (previous?.turn_index ?? 0) + 1,
          trigger_message_id: message.messageId,
          conversation_disposition: null,
          disposition_reason: null,
          requester_id: message.senderId,
          requester_role: message.senderRole,
          authorization_grant: JSON.stringify(authorizationFromMessage(message.content, message.senderRole === "owner")),
          requested_workspace_alias: requestedWorkspaceAlias,
          resolved_workspace_alias: previous?.resolved_workspace_alias ?? null,
          preferred_executor_id: preferredExecutorId,
          executor_id: previous?.executor_id ?? null,
          codex_thread_id: previous?.codex_thread_id ?? null,
          executor_home_ref: previous?.executor_home_ref ?? null,
          executor_profile: previous?.executor_profile ?? null,
          executor_config_fingerprint: previous?.executor_config_fingerprint ?? null,
          codex_version: previous?.codex_version ?? null,
          lease_token_hash: null,
          lease_expires_at: null,
          summary: routeAmbiguous ? "存在多个可用执行器，请先为机器人或群绑定默认执行器" : null,
          completed_at: null,
          updated_at: new Date()
        }).returningAll().executeTakeFirstOrThrow();
        createdTask = true;
        await trx.insertInto("task_events").values({
          task_id: task.id,
          event_type: "task.created",
          summary: routeAmbiguous ? "任务已创建，但执行器路由不明确" : "任务已创建",
          payload: JSON.stringify({ preferredExecutorId, requestedWorkspaceAlias, routeAmbiguous })
        }).execute();
      }

      const nextSeq = conversation.room_seq + 1;
      await trx.updateTable("conversations").set({ room_seq: nextSeq, active: true, thread_id: null, updated_at: new Date() }).where("id", "=", conversation.id).execute();
      const signal = await trx.insertInto("signals").values({
        bot_id: bot.id,
        conversation_id: conversation.id,
        task_id: task.id,
        event_id: message.eventId,
        seq: nextSeq,
        message_id: message.messageId,
        sender_id: message.senderId,
        sender_role: message.senderRole,
        sender_type: message.senderType,
        sender_bot_id: message.senderBotId,
        sender_display_name: message.senderDisplayName,
        ingress_source: message.ingressSource,
        origin_message_id: message.originMessageId,
        bot_dialogue_depth: message.botDialogueDepth,
        message_type: message.messageType,
        content: message.content,
        preview: message.content.slice(0, 500),
        priority: message.explicitlyActivated ? 90 : 50,
        decision: "pending",
        decision_rationale: message.decisionRationale ?? null,
        decided_at: null
      }).returning("id").executeTakeFirstOrThrow();
      await trx.insertInto("task_events").values({
        task_id: task.id,
        event_type: "event.received",
        summary: message.senderType === "bot" ? `机器人 ${message.senderDisplayName ?? message.senderId} 的消息已进入收件箱` : "飞书事件已进入任务收件箱",
        payload: JSON.stringify({
          eventId: message.eventId,
          messageId: message.messageId,
          seq: nextSeq,
          senderType: message.senderType,
          senderBotId: message.senderBotId,
          ingressSource: message.ingressSource,
          originMessageId: message.originMessageId,
          botDialogueDepth: message.botDialogueDepth,
          createdTask
        }),
        created_at: message.receivedAt ?? new Date()
      }).execute();
      return { taskId: task.id, signalId: signal.id, status: "routed" };
    });
  }
}
