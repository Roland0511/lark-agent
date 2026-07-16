import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { authorizationFromMessage } from "./policy.js";
import type { BotRow } from "./bot-types.js";
import type { StoredAttachment } from "../lark/attachments.js";
import { attachmentSummary } from "../lark/attachments.js";

const activeTaskStates = ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"] as const;

function messagePreview(content: string, attachments: StoredAttachment[]): string {
  const summary = attachmentSummary(attachments);
  return (summary && !content.includes(summary) ? `${content}\n${summary}` : content).trim().slice(0, 500);
}

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
  attachments?: StoredAttachment[];
  explicitlyActivated: boolean;
  receivedAt?: Date;
  decisionRationale?: string | null;
}

export interface RoutedMessageResult {
  taskId: string | null;
  signalId: string | null;
  status: "routed" | "duplicate" | "inactive" | "unbound";
  chatContextId?: string;
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
      await sql`select pg_advisory_xact_lock(hashtext(${`${bot.id}:${message.chatId}`}))`.execute(trx);
      const duplicateSignal = await trx.selectFrom("signals").select(["id", "task_id"])
        .where("bot_id", "=", bot.id).where("message_id", "=", message.messageId).executeTakeFirst();
      if (duplicateSignal) return { taskId: duplicateSignal.task_id, signalId: duplicateSignal.id, status: "duplicate" };

      let chatContext = await trx.selectFrom("chat_contexts").selectAll()
        .where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId).forUpdate().executeTakeFirst();

      let task = chatContext
        ? await trx.selectFrom("tasks")
            .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
            .selectAll("tasks")
            .where("conversations.chat_context_id", "=", chatContext.id)
            .where("tasks.state", "in", [...activeTaskStates])
            .orderBy("tasks.created_at", "desc")
            .forUpdate()
            .executeTakeFirst()
        : undefined;
      let conversation = task
        ? await trx.selectFrom("conversations").selectAll().where("id", "=", task.conversation_id).forUpdate().executeTakeFirstOrThrow()
        : message.chatType === "group"
          ? await trx.selectFrom("conversations").selectAll().where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId)
              .where("chat_type", "=", "group").where("active", "=", true).orderBy("created_at", "desc").forUpdate().executeTakeFirst()
          : await trx.selectFrom("conversations").selectAll().where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId)
              .where("root_message_id", "=", message.rootMessageId).forUpdate().executeTakeFirst();

      if (conversation?.followup_expires_at && new Date(conversation.followup_expires_at).getTime() <= Date.now()) {
        if (!task) {
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

      const now = new Date();
      if (!chatContext) {
        chatContext = await trx.insertInto("chat_contexts").values({
          bot_id: bot.id,
          chat_id: message.chatId,
          chat_type: message.chatType,
          peer_open_id: message.chatType === "p2p" && message.senderType === "user" ? message.senderId : null,
          peer_display_name: message.chatType === "p2p" && message.senderType === "user" ? message.senderDisplayName : null,
          peer_identity_checked_at: message.chatType === "p2p" && message.senderType === "user" && message.senderDisplayName ? now : null,
          codex_thread_id: null,
          executor_id: null,
          executor_home_ref: null,
          executor_profile: null,
          executor_config_fingerprint: null,
          executor_workspace_mapping_fingerprint: null,
          codex_version: null,
          workspace_root_alias: null,
          state: "uninitialized",
          blocked_reason: null,
          last_activity_at: now,
          last_compacted_at: null,
          updated_at: now
        }).onConflict((conflict) => conflict.columns(["bot_id", "chat_id"]).doUpdateSet({
          last_activity_at: now,
          updated_at: now
        })).returningAll().executeTakeFirstOrThrow();
      } else {
        const peerIdentity = message.chatType === "p2p" && message.senderType === "user"
          ? {
              peer_open_id: chatContext.peer_open_id ?? message.senderId,
              ...(message.senderDisplayName ? { peer_display_name: message.senderDisplayName, peer_identity_checked_at: now } : {})
            }
          : {};
        await trx.updateTable("chat_contexts").set({ ...peerIdentity, last_activity_at: now, updated_at: now }).where("id", "=", chatContext.id).execute();
      }

      if (!conversation) {
        conversation = await trx.insertInto("conversations").values({
          bot_id: bot.id,
          chat_context_id: chatContext.id,
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
          updated_at: now
        }).returningAll().executeTakeFirstOrThrow();
      }

      task ??= await trx.selectFrom("tasks").selectAll().where("conversation_id", "=", conversation.id)
        .where("state", "in", [...activeTaskStates]).orderBy("created_at", "desc").forUpdate().executeTakeFirst();
      let createdTask = false;
      if (!task) {
        const policy = await trx.selectFrom("bot_chat_bindings").selectAll().where("bot_id", "=", bot.id).where("chat_id", "=", message.chatId).executeTakeFirst();
        const previous = await trx.selectFrom("tasks").selectAll().where("conversation_id", "=", conversation.id).orderBy("turn_index", "desc").executeTakeFirst();
        if (previous && !conversation.active) return { taskId: null, signalId: null, status: "inactive" };
        const requestedWorkspaceAlias = chatContext.workspace_root_alias ?? policy?.workspace_alias ?? bot.default_workspace_alias;
        let preferredExecutorId = chatContext.executor_id ?? policy?.preferred_executor_id ?? bot.default_executor_id;
        let routeAmbiguous = false;
        let routeBlocked = chatContext.state === "blocked";
        let routeBlockedReason = chatContext.blocked_reason;
        const scopedBindings = await trx.selectFrom("bot_skill_bindings").select(["id", "namespace", "slug", "chat_context_id"])
          .where("bot_id", "=", bot.id).where("deleted_at", "is", null)
          .where((eb) => eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", chatContext.id)])).execute();
        const effectiveBindings = new Map<string, typeof scopedBindings[number]>();
        for (const binding of scopedBindings.sort((left, right) => Number(Boolean(left.chat_context_id)) - Number(Boolean(right.chat_context_id)))) {
          effectiveBindings.set(`${binding.namespace}/${binding.slug}`, binding);
        }
        const bindingIds = [...effectiveBindings.values()].map((binding) => binding.id);
        let requiresRuntimeConfig = false;
        if (bindingIds.length) {
          const [environment, files] = await Promise.all([
            trx.selectFrom("skill_runtime_environment_revisions").select("id").where("binding_id", "in", bindingIds).where("superseded_at", "is", null)
              .where((eb) => eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", chatContext.id)])).limit(1).executeTakeFirst(),
            trx.selectFrom("skill_runtime_file_revisions").select("id").where("binding_id", "in", bindingIds).where("superseded_at", "is", null)
              .where((eb) => eb.or([eb("chat_context_id", "is", null), eb("chat_context_id", "=", chatContext.id)])).limit(1).executeTakeFirst()
          ]);
          requiresRuntimeConfig = Boolean(environment || files);
        }
        const requiredCapabilities = ["chat_context_v1", ...(bindingIds.length ? ["skillhub_skills_v1", "user_skills_inventory_v1", "workspace_mapping_v1"] : []), ...(requiresRuntimeConfig ? ["skill_runtime_config_v1"] : [])];
        const missingCapabilities = (capabilities: string[]) => requiredCapabilities.filter((capability) => !capabilities.includes(capability));
        if (chatContext.codex_thread_id && chatContext.executor_id) {
          const fixedWorker = await trx.selectFrom("workers").selectAll().where("executor_id", "=", chatContext.executor_id).executeTakeFirst();
          const aliases = Array.isArray(fixedWorker?.workspace_aliases) ? fixedWorker.workspace_aliases.map(String) : [];
          const capabilities = Array.isArray(fixedWorker?.capabilities) ? fixedWorker.capabilities.map(String) : [];
          const missing = missingCapabilities(capabilities);
          const environmentMatches = Boolean(
            fixedWorker && !fixedWorker.deleted_at && fixedWorker.operational_mode === "enabled" &&
            missing.length === 0 &&
            (!bindingIds.length || fixedWorker.workspace_mapping_fingerprint !== null) &&
            fixedWorker.home_ref === chatContext.executor_home_ref &&
            fixedWorker.codex_profile === chatContext.executor_profile &&
            fixedWorker.config_fingerprint === chatContext.executor_config_fingerprint &&
            fixedWorker.workspace_mapping_fingerprint === chatContext.executor_workspace_mapping_fingerprint &&
            chatContext.workspace_root_alias && aliases.includes(chatContext.workspace_root_alias)
          );
          if (!environmentMatches) {
            routeBlocked = true;
            routeBlockedReason = missing.length
              ? `聊天绑定的执行器缺少当前技能配置所需能力：${missing.join("、")}`
              : "聊天绑定的执行器、CODEX_HOME、Profile、配置指纹或工作区别名已不匹配";
            await trx.updateTable("chat_contexts").set({ state: "blocked", blocked_reason: routeBlockedReason, updated_at: now }).where("id", "=", chatContext.id).execute();
          }
        } else if (chatContext.codex_thread_id) {
          routeBlocked = true;
          routeBlockedReason = "历史 Thread 缺少完整的固定执行环境，无法安全恢复";
          await trx.updateTable("chat_contexts").set({ state: "blocked", blocked_reason: routeBlockedReason, updated_at: now }).where("id", "=", chatContext.id).execute();
        } else if (preferredExecutorId) {
          const preferredWorker = await trx.selectFrom("workers").select(["capabilities", "operational_mode", "workspace_mapping_fingerprint"])
            .where("executor_id", "=", preferredExecutorId).where("deleted_at", "is", null).executeTakeFirst();
          const capabilities = Array.isArray(preferredWorker?.capabilities) ? preferredWorker.capabilities.map(String) : [];
          const missing = missingCapabilities(capabilities);
          if (!preferredWorker || preferredWorker.operational_mode !== "enabled" || missing.length || (bindingIds.length > 0 && preferredWorker.workspace_mapping_fingerprint === null)) {
            routeBlocked = true;
            routeBlockedReason = missing.length
              ? missing.length === 1 && missing[0] === "chat_context_v1"
                ? "指定执行器尚未升级，不支持永久聊天记忆"
                : `指定执行器缺少当前技能配置所需能力：${missing.join("、")}`
              : "指定执行器当前不可用";
          }
        } else if (!preferredExecutorId) {
          const workers = await trx.selectFrom("workers").select(["executor_id", "workspace_aliases", "capabilities", "workspace_mapping_fingerprint"])
            .where("deleted_at", "is", null).where("operational_mode", "=", "enabled").execute();
          const eligible = workers.filter((worker) => {
            const aliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
            const capabilities = Array.isArray(worker.capabilities) ? worker.capabilities.map(String) : [];
            return missingCapabilities(capabilities).length === 0 && (!bindingIds.length || worker.workspace_mapping_fingerprint !== null) &&
              (requestedWorkspaceAlias ? aliases.includes(requestedWorkspaceAlias) : aliases.length === 1);
          });
          if (eligible.length === 1) preferredExecutorId = eligible[0]!.executor_id;
          else if (eligible.length > 1) routeAmbiguous = true;
        }
        task = await trx.insertInto("tasks").values({
          bot_id: bot.id,
          conversation_id: conversation.id,
          state: routeBlocked || routeAmbiguous ? "waiting_input" : chatContext.executor_id || previous ? "waiting_worker" : "queued",
          turn_index: (previous?.turn_index ?? 0) + 1,
          trigger_message_id: message.messageId,
          conversation_disposition: null,
          disposition_reason: null,
          requester_id: message.senderId,
          requester_role: message.senderRole,
          authorization_grant: JSON.stringify(authorizationFromMessage(message.content, message.senderRole === "owner")),
          requested_workspace_alias: requestedWorkspaceAlias,
          resolved_workspace_alias: chatContext.workspace_root_alias,
          preferred_executor_id: preferredExecutorId,
          executor_id: chatContext.executor_id,
          codex_thread_id: chatContext.codex_thread_id,
          executor_home_ref: chatContext.executor_home_ref,
          executor_profile: chatContext.executor_profile,
          executor_config_fingerprint: chatContext.executor_config_fingerprint,
          executor_workspace_mapping_fingerprint: chatContext.executor_workspace_mapping_fingerprint,
          codex_version: chatContext.codex_version,
          lease_token_hash: null,
          lease_expires_at: null,
          summary: routeBlocked ? routeBlockedReason : routeAmbiguous ? "存在多个可用执行器，请先为机器人或群绑定默认执行器" : null,
          completed_at: null,
          updated_at: new Date()
        }).returningAll().executeTakeFirstOrThrow();
        createdTask = true;
        await trx.insertInto("task_events").values({
          task_id: task.id,
          event_type: "task.created",
          summary: routeBlocked ? "任务已创建，但聊天上下文已阻塞" : routeAmbiguous ? "任务已创建，但执行器路由不明确" : "任务已创建",
          payload: JSON.stringify({ chatContextId: chatContext.id, preferredExecutorId, requestedWorkspaceAlias, routeAmbiguous, routeBlocked })
        }).execute();
      }

      const nextSeq = conversation.room_seq + 1;
      await trx.updateTable("conversations").set({ room_seq: nextSeq, active: true, thread_id: null, updated_at: now }).where("id", "=", conversation.id).execute();
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
        preview: messagePreview(message.content, message.attachments ?? []),
        attachments: JSON.stringify(message.attachments ?? []),
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
      return { taskId: task.id, signalId: signal.id, status: "routed", chatContextId: chatContext.id };
    });
  }
}
