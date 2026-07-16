import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { Database, Task } from "../db/types.js";
import { AppError, errorMessage } from "../shared/errors.js";
import type { LarkGateway } from "../lark/gateway.js";
import type { ControlPlaneConfig } from "./config.js";
import { requireAdmin, requireCsrf, setNoStore } from "./admin-auth.js";
import type { ControlPlaneRepository } from "./repository.js";
import { AdminEventBus } from "./admin-events.js";
import type { RuntimeStatus } from "./runtime-status.js";
import type { BotGatewayRegistry } from "./bot-runtime.js";
import { publicAttachments } from "../lark/attachments.js";
import { effectiveWorkerDisplayName, publicWorkerDisplayName } from "./worker-display-name.js";
import { lockExecutorClaim } from "./executor-claim-lock.js";
import { chatDisplayName } from "./chat-display-name.js";

const commandSchema = z.object({
  command: z.enum(["retry", "cancel", "handoff", "return_agent", "mark_completed"]),
  expectedRevision: z.number().int().nonnegative()
});

const workerCommandSchema = z.object({
  command: z.enum(["enable", "maintenance", "disable", "revoke_credentials"])
});

const workerDisplayAliasSchema = z.object({
  displayAlias: z.union([
    z.string().trim().min(1).max(64).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value), "别名不能包含控制字符"),
    z.null()
  ])
}).strict();

const decisionSchema = z.object({ approved: z.boolean() });
const outboxCommandSchema = z.object({ command: z.enum(["retry", "mark_sent", "discard"]) });
const botDialogueSettingsSchema = z.object({ maxConsecutiveDepth: z.number().int().min(1).max(200) });

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function masked(value: string): string {
  if (value.length <= 8) return "••••";
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function parseJsonArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function availability(lastSeen: Date | string): "online" | "stale" | "offline" {
  const age = Date.now() - new Date(lastSeen).getTime();
  return age <= 45_000 ? "online" : age <= 90_000 ? "stale" : "offline";
}

function assertTaskCommand(
  task: Task,
  command: z.infer<typeof commandSchema>["command"],
  capabilities: string[],
  chatContextState: "uninitialized" | "ready" | "blocked"
): void {
  if (command === "retry" && !["failed", "waiting_input"].includes(task.state)) throw new AppError("当前状态不能重试", 409, "invalid_task_state");
  if (command === "retry" && chatContextState === "blocked") {
    throw new AppError("聊天记忆已阻塞；请先恢复固定执行环境，普通重试不会解除长期绑定", 409, "chat_context_blocked");
  }
  if (command === "cancel" && ["completed", "failed", "cancelled"].includes(task.state)) throw new AppError("任务已经结束", 409, "invalid_task_state");
  if (command === "handoff" && (task.state !== "running" || !capabilities.includes("app_handoff"))) throw new AppError("当前任务不能由本机接手", 409, "handoff_unavailable");
  if (command === "return_agent" && task.state !== "human_owned") throw new AppError("任务当前不由人工接管", 409, "invalid_task_state");
  if (command === "mark_completed" && task.state !== "human_owned") throw new AppError("只有人工接管任务可标记完成", 409, "invalid_task_state");
}

export function registerAdminRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  dependencies: { repository: ControlPlaneRepository; lark: LarkGateway; gateways: BotGatewayRegistry; events: AdminEventBus; runtime: RuntimeStatus }
): void {
  const { repository, gateways, events, runtime } = dependencies;
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/v1/admin")) setNoStore(reply);
    return payload;
  });

  app.get("/v1/admin/me", async (request, reply) => {
    const principal = await requireAdmin(db, config, request);
    setNoStore(reply);
    return { openId: masked(principal.openId), displayName: principal.displayName, role: principal.role, csrfToken: principal.csrfToken, agentDisplayName: config.agentDisplayName };
  });

  app.get("/v1/admin/settings/bot-dialogue", async (request) => {
    await requireAdmin(db, config, request);
    const row = await db.selectFrom("bot_dialogue_settings").selectAll().where("id", "=", 1).executeTakeFirstOrThrow();
    return {
      maxConsecutiveDepth: row.max_consecutive_depth,
      registeredBotsOnly: true,
      finalRepliesOnly: true,
      guardAction: "notify_and_wait_human",
      updatedAt: iso(row.updated_at)
    };
  });

  app.patch("/v1/admin/settings/bot-dialogue", async (request) => {
    const principal = await requireAdmin(db, config, request, true);
    requireCsrf(request, principal);
    const body = botDialogueSettingsSchema.parse(request.body);
    const row = await db.updateTable("bot_dialogue_settings").set({ max_consecutive_depth: body.maxConsecutiveDepth, updated_at: new Date() })
      .where("id", "=", 1).returningAll().executeTakeFirstOrThrow();
    events.publish("settings", "bot-dialogue");
    return { maxConsecutiveDepth: row.max_consecutive_depth, updatedAt: iso(row.updated_at) };
  });

  app.get<{ Querystring: { window?: string } }>("/v1/admin/overview", async (request) => {
    await requireAdmin(db, config, request);
    const hours = request.query.window === "7d" ? 168 : 24;
    const since = new Date(Date.now() - hours * 3_600_000);
    const [taskStates, workers, workerCredentials, pendingApprovals, outboxUnknown, outputUnknown, heldDrafts, duration, incidents, throughput, awaitingFollowup, bots] = await Promise.all([
      db.selectFrom("tasks").select(["state", sql<number>`count(*)::int`.as("count")]).groupBy("state").execute(),
      db.selectFrom("workers").selectAll().where("deleted_at", "is", null).orderBy(sql`coalesce(display_alias, display_name)`).execute(),
      db.selectFrom("worker_device_credentials")
        .select(["executor_id", sql<number>`count(*) filter (where revoked_at is null)::int`.as("active_count")])
        .groupBy("executor_id").execute(),
      db.selectFrom("approvals").select(sql<number>`count(*)::int`.as("count")).where("state", "=", "pending").executeTakeFirstOrThrow(),
      db.selectFrom("outbox_messages").select(sql<number>`count(*)::int`.as("count")).where("state", "=", "unknown").executeTakeFirstOrThrow(),
      db.selectFrom("task_outputs").select(sql<number>`count(*)::int`.as("count")).where("state", "=", "unknown").executeTakeFirstOrThrow(),
      db.selectFrom("drafts").select(sql<number>`count(*)::int`.as("count")).where("state", "=", "held").executeTakeFirstOrThrow(),
      db.selectFrom("tasks").select(sql<number | null>`avg(extract(epoch from (completed_at - created_at)))`.as("avg_seconds"))
        .where("completed_at", "is not", null).where("created_at", ">", since).executeTakeFirstOrThrow(),
      db.selectFrom("incidents").selectAll().where("state", "!=", "resolved").orderBy("severity", "asc").orderBy("last_seen_at", "desc").limit(8).execute(),
      db.selectFrom("tasks").select([sql<string>`date_trunc('hour', created_at)::text`.as("bucket"), sql<number>`count(*)::int`.as("count")])
        .where("created_at", ">", since).groupBy(sql`date_trunc('hour', created_at)`).orderBy(sql`date_trunc('hour', created_at)`).execute(),
      db.selectFrom("conversations").select(sql<number>`count(*)::int`.as("count")).where("active", "=", true).where("followup_expires_at", "is not", null).executeTakeFirstOrThrow(),
      db.selectFrom("bots").select(["id", "display_name", "enabled", "is_system", "credential_state", "permission_state"]).where("deleted_at", "is", null).orderBy("display_name").execute()
    ]);
    const completed = taskStates.find((item) => item.state === "completed")?.count ?? 0;
    const failed = taskStates.find((item) => item.state === "failed")?.count ?? 0;
    return {
      taskStates: Object.fromEntries(taskStates.map((item) => [item.state, item.count])),
      pendingApprovals: pendingApprovals.count,
      outboxUnknown: outboxUnknown.count + outputUnknown.count,
      heldDrafts: heldDrafts.count,
      awaitingFollowup: awaitingFollowup.count,
      successRate: completed + failed ? completed / (completed + failed) : null,
      averageDurationSeconds: duration.avg_seconds === null ? null : Number(duration.avg_seconds),
      workers: workers.map((worker) => ({
        executorId: worker.executor_id, displayName: effectiveWorkerDisplayName(worker), displayAlias: worker.display_alias,
        reportedDisplayName: worker.display_name, availability: availability(worker.last_seen_at),
        operationalMode: worker.operational_mode, lastSeenAt: iso(worker.last_seen_at), profile: worker.codex_profile,
        credentialActive: (workerCredentials.find((item) => item.executor_id === worker.executor_id)?.active_count ?? 0) > 0
      })),
      consumers: runtime.snapshot(),
      bots: bots.map((bot) => ({ id: bot.id, displayName: bot.display_name, enabled: bot.enabled, isSystem: bot.is_system, credentialState: bot.credential_state, permissionState: bot.permission_state, message: runtime.snapshot([`${bot.id}:message`])[`${bot.id}:message`] })),
      incidents: incidents.map((item) => ({ ...item, first_seen_at: iso(item.first_seen_at), last_seen_at: iso(item.last_seen_at) })),
      throughput
    };
  });

  app.get<{ Querystring: { state?: string; bot?: string; executor?: string; workspace?: string; chatContextId?: string; q?: string; limit?: string; before?: string } }>("/v1/admin/tasks", async (request) => {
    await requireAdmin(db, config, request);
    const limit = Math.min(Math.max(Number(request.query.limit ?? 30), 1), 100);
    let query = db.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id").innerJoin("bots", "bots.id", "tasks.bot_id")
      .leftJoin("chat_contexts", "chat_contexts.id", "conversations.chat_context_id")
      .leftJoin("bot_chat_bindings as task_chat_bindings", (join) => join.onRef("task_chat_bindings.bot_id", "=", "tasks.bot_id").onRef("task_chat_bindings.chat_id", "=", "conversations.chat_id"))
      .leftJoin("workers as task_workers", "task_workers.executor_id", "tasks.executor_id").select([
      "tasks.id", "tasks.state", "tasks.revision", "tasks.executor_id", "tasks.requested_workspace_alias", "tasks.resolved_workspace_alias", "tasks.requester_id",
      "tasks.requester_role", "tasks.attempt", "tasks.summary", "tasks.created_at", "tasks.updated_at", "tasks.completed_at", "tasks.conversation_id",
      "tasks.turn_index", "tasks.conversation_disposition", "tasks.bot_id", "bots.app_id as bot_app_id", "bots.display_name as bot_display_name",
      "conversations.chat_context_id", "conversations.chat_id", "conversations.chat_type", "conversations.room_seq",
      "task_chat_bindings.chat_name", "chat_contexts.peer_open_id", "chat_contexts.peer_display_name",
      sql<string | null>`coalesce(task_workers.display_alias, task_workers.display_name)`.as("executor_display_name"),
      sql<string | null>`(select signals.content from signals where signals.task_id = tasks.id order by signals.seq desc limit 1)`.as("latest_signal_content")
    ]).orderBy("tasks.created_at", "desc").orderBy("tasks.id", "desc").limit(limit + 1);
    if (request.query.state) query = query.where("tasks.state", "=", request.query.state as Task["state"]);
    if (request.query.bot) query = query.where("tasks.bot_id", "=", request.query.bot);
    if (request.query.executor) query = query.where("tasks.executor_id", "=", request.query.executor);
    if (request.query.chatContextId) {
      const chatContextId = z.string().uuid().safeParse(request.query.chatContextId);
      if (!chatContextId.success) throw new AppError("聊天记忆筛选条件格式无效", 400, "invalid_chat_context_filter");
      query = query.where("conversations.chat_context_id", "=", chatContextId.data);
    }
    if (request.query.workspace) query = query.where((eb) => eb.or([
      eb("tasks.resolved_workspace_alias", "=", request.query.workspace as string),
      eb.and([eb("tasks.resolved_workspace_alias", "is", null), eb("tasks.requested_workspace_alias", "=", request.query.workspace as string)])
    ]));
    if (request.query.q) {
      const prefix = `${request.query.q.replace(/[%_]/g, "")}%`;
      const contains = `%${request.query.q.replace(/[%_]/g, "")}%`;
      query = query.where(sql<boolean>`(tasks.id::text ILIKE ${prefix} OR tasks.conversation_id::text ILIKE ${prefix}
        OR COALESCE(tasks.codex_thread_id, '') ILIKE ${contains}
        OR conversations.chat_id ILIKE ${contains}
        OR COALESCE(task_chat_bindings.chat_name, '') ILIKE ${contains}
        OR COALESCE(chat_contexts.peer_display_name, '') ILIKE ${contains}
        OR COALESCE(chat_contexts.peer_open_id, '') ILIKE ${contains})`);
    }
    if (request.query.before) query = query.where("tasks.created_at", "<", new Date(request.query.before));
    const rows = await query.execute();
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map((task) => ({
        ...task,
        chat_display_name: chatDisplayName({ chatType: task.chat_type, chatName: task.chat_name, peerOpenId: task.peer_open_id, peerDisplayName: task.peer_display_name }),
        requester_id: masked(task.requester_id), created_at: iso(task.created_at), updated_at: iso(task.updated_at), completed_at: iso(task.completed_at), summaryAvailable: true
      })),
      nextCursor: hasMore ? iso(page.at(-1)?.created_at ?? null) : null
    };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/tasks/:id", async (request) => {
    await requireAdmin(db, config, request);
    const task = await db.selectFrom("tasks")
      .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
      .innerJoin("bots", "bots.id", "tasks.bot_id")
      .leftJoin("chat_contexts", "chat_contexts.id", "conversations.chat_context_id")
      .leftJoin("bot_chat_bindings as task_chat_bindings", (join) => join.onRef("task_chat_bindings.bot_id", "=", "tasks.bot_id").onRef("task_chat_bindings.chat_id", "=", "conversations.chat_id"))
      .selectAll("tasks")
      .select([
        "bots.app_id as bot_app_id", "bots.display_name as bot_display_name", "bots.default_executor_id as bot_default_executor_id",
        "conversations.chat_context_id", "conversations.chat_id", "conversations.chat_type", "conversations.room_seq", "conversations.thread_id",
        "conversations.followup_expires_at", "conversations.attention_model_snapshot", "conversations.attention_reasoning_effort_snapshot",
        "conversations.execution_model_snapshot", "conversations.execution_reasoning_effort_snapshot",
        "chat_contexts.codex_thread_id as chat_context_thread_id", "chat_contexts.state as chat_context_state",
        "chat_contexts.peer_open_id", "chat_contexts.peer_display_name", "task_chat_bindings.chat_name as stored_chat_name"
      ])
      .where("tasks.id", "=", request.params.id).executeTakeFirst();
    if (!task) throw new AppError("任务不存在", 404, "not_found");
    const worker = task.executor_id ? await db.selectFrom("workers").select(["display_name", "display_alias", "capabilities", "last_seen_at", "operational_mode"]).where("executor_id", "=", task.executor_id).executeTakeFirst() : null;
    const chatName = config.larkEnabled && task.chat_type === "group" ? await (await gateways.gateway(task.bot_id)).getChatName(task.chat_id).catch(() => task.stored_chat_name) : task.stored_chat_name;
    const conversationTurns = await db.selectFrom("tasks").select(["id", "turn_index", "state", "conversation_disposition", "created_at", "completed_at"])
      .where("conversation_id", "=", task.conversation_id).orderBy("turn_index").execute();
    return {
      ...task, requester_id: masked(task.requester_id), summary: undefined, authorization_grant: undefined,
      chat_name: chatName,
      chat_display_name: chatDisplayName({ chatType: task.chat_type, chatName, peerOpenId: task.peer_open_id, peerDisplayName: task.peer_display_name }),
      created_at: iso(task.created_at), updated_at: iso(task.updated_at), completed_at: iso(task.completed_at), lease_expires_at: iso(task.lease_expires_at),
      followup_expires_at: iso(task.followup_expires_at),
      executor_display_name: worker ? effectiveWorkerDisplayName(worker) : null,
      route_mismatch: Boolean(task.bot_default_executor_id && task.executor_id && task.bot_default_executor_id !== task.executor_id),
      conversation_turns: conversationTurns.map((turn) => ({ ...turn, created_at: iso(turn.created_at), completed_at: iso(turn.completed_at) })),
      worker: worker ? { ...worker, ...publicWorkerDisplayName(worker), capabilities: parseJsonArray(worker.capabilities), last_seen_at: iso(worker.last_seen_at), availability: availability(worker.last_seen_at) } : null
    };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/tasks/:id/timeline", async (request) => {
    await requireAdmin(db, config, request);
    const [signals, taskEvents, drafts, approvals, outbox, actions, output, outputUpdates] = await Promise.all([
      db.selectFrom("signals").select(["id", "seq", "sender_role", "sender_type", "sender_bot_id", "sender_display_name", "ingress_source", "origin_message_id", "bot_dialogue_depth", "message_type", "attachments", "decision", "priority", "created_at", "decided_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("task_events").select(["id", "event_type", "summary", "created_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("drafts").select(["id", "state", "base_room_seq", "observed_room_seq", "hold_count", "created_at", "sent_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("approvals").select(["id", "method", "state", "created_at", "decided_at", "expires_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("outbox_messages").select(["id", "state", "attempt", "last_error", "created_at", "sent_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("action_receipts").select(["id", "action_type", "request_digest", "created_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("task_outputs").select(["task_id", "transport", "state", "visible_phase", "sequence", "message_id", "created_at", "opened_at", "closed_at"]).where("task_id", "=", request.params.id).execute(),
      db.selectFrom("task_output_updates").select(["id", "operation", "sequence", "state", "attempt", "last_error", "created_at", "sent_at"]).where("task_id", "=", request.params.id).execute()
    ]);
    const items = [
      ...signals.map((x) => ({ type: "signal", ...x, attachments: publicAttachments(x.attachments) })), ...taskEvents.map((x) => ({ type: "event", ...x })),
      ...drafts.map((x) => ({ type: "draft", ...x })), ...approvals.map((x) => ({ type: "approval", ...x })),
      ...outbox.map((x) => ({ type: "outbox", ...x })), ...actions.map((x) => ({ type: "action", ...x })),
      ...output.map((x) => ({ type: "output", ...x })), ...outputUpdates.map((x) => ({ type: "output_update", ...x }))
    ].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    return { items: items.map((item) => ({ ...item, created_at: iso(item.created_at) })) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/tasks/:id/commands", async (request) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const body = commandSchema.parse(request.body);
    const result = await db.transaction().execute(async (trx) => {
      const identity = await trx.selectFrom("tasks")
        .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
        .select(["tasks.id", "tasks.conversation_id", "conversations.bot_id", "conversations.chat_id", "conversations.chat_context_id"])
        .where("tasks.id", "=", request.params.id)
        .executeTakeFirst();
      if (!identity) throw new AppError("任务不存在", 404, "not_found");

      await sql`select pg_advisory_xact_lock(hashtext(${`${identity.bot_id}:${identity.chat_id}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").select(["id", "state"])
        .where("id", "=", identity.chat_context_id).forUpdate().executeTakeFirst();
      if (!context) throw new AppError("聊天记忆不存在", 409, "chat_context_not_found");
      const task = await trx.selectFrom("tasks").selectAll().where("id", "=", identity.id).forUpdate().executeTakeFirst();
      if (!task) throw new AppError("任务不存在", 404, "not_found");
      await trx.selectFrom("conversations").select("id").where("id", "=", identity.conversation_id).forUpdate().executeTakeFirstOrThrow();
      if (task.revision !== body.expectedRevision) throw new AppError("任务状态已变化，请刷新后重试", 409, "revision_conflict");

      const capabilities = task.executor_id
        ? parseJsonArray((await trx.selectFrom("workers").select("capabilities").where("executor_id", "=", task.executor_id).executeTakeFirst())?.capabilities)
        : [];
      assertTaskCommand(task, body.command, capabilities, context.state);
      const now = new Date();
      const nextState = body.command === "retry" ? "waiting_worker" : body.command === "cancel" ? "cancelled" : body.command === "handoff" ? "human_owned" : body.command === "return_agent" ? "waiting_worker" : "completed";
      const updated = await trx.updateTable("tasks").set({
        state: nextState, revision: task.revision + 1, summary: `后台操作：${body.command}`,
        preferred_executor_id: body.command === "retry" || body.command === "return_agent" ? task.executor_id : task.preferred_executor_id,
        lease_token_hash: body.command === "retry" || body.command === "return_agent" || body.command === "cancel" || body.command === "mark_completed" ? null : task.lease_token_hash,
        lease_expires_at: body.command === "retry" || body.command === "return_agent" || body.command === "cancel" || body.command === "mark_completed" ? null : task.lease_expires_at,
        completed_at: body.command === "cancel" || body.command === "mark_completed" ? now : null, updated_at: now
      }).where("id", "=", task.id).where("revision", "=", body.expectedRevision).returningAll().executeTakeFirst();
      if (!updated) throw new AppError("任务状态已变化，请刷新后重试", 409, "revision_conflict");
      await trx.updateTable("conversations").set({
        active: nextState !== "completed" && nextState !== "cancelled",
        updated_at: now
      }).where("id", "=", task.conversation_id).execute();
      return { taskId: task.id, state: nextState, revision: updated.revision };
    });
    events.publish("task", result.taskId);
    return { ok: true, state: result.state, revision: result.revision };
  });

  app.get("/v1/admin/workers", async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.selectFrom("workers").selectAll().where("deleted_at", "is", null).orderBy(sql`coalesce(display_alias, display_name)`).execute();
    const active = await db.selectFrom("tasks").select(["executor_id", sql<number>`count(*)::int`.as("count")]).where("state", "=", "running").where("executor_id", "is not", null).groupBy("executor_id").execute();
    const credentials = await db.selectFrom("worker_device_credentials")
      .select(["executor_id", sql<number>`count(*) filter (where revoked_at is null)::int`.as("active_count"), sql<Date | null>`max(last_used_at)`.as("last_used_at")])
      .groupBy("executor_id").execute();
    return { items: rows.map((worker) => ({
      ...worker, ...publicWorkerDisplayName(worker), workspace_aliases: parseJsonArray(worker.workspace_aliases), capabilities: parseJsonArray(worker.capabilities),
      available_profiles: Array.isArray(worker.available_profiles) ? worker.available_profiles : [],
      model_catalog: Array.isArray(worker.model_catalog) ? worker.model_catalog : [],
      model_catalog_updated_at: iso(worker.model_catalog_updated_at),
      manager_last_seen_at: iso(worker.manager_last_seen_at),
      manager_online: Boolean(worker.manager_last_seen_at && Date.now() - new Date(worker.manager_last_seen_at).getTime() <= 45_000),
      last_seen_at: iso(worker.last_seen_at), availability: availability(worker.last_seen_at), activeTasks: active.find((x) => x.executor_id === worker.executor_id)?.count ?? 0,
      credentialActive: (credentials.find((x) => x.executor_id === worker.executor_id)?.active_count ?? 0) > 0,
      credentialLastUsedAt: iso(credentials.find((x) => x.executor_id === worker.executor_id)?.last_used_at ?? null)
    })) };
  });

  app.patch<{ Params: { id: string } }>("/v1/admin/workers/:id/display-alias", async (request) => {
    const principal = await requireAdmin(db, config, request, true);
    requireCsrf(request, principal);
    const parsed = workerDisplayAliasSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError("别名去除首尾空格后须为 1–64 个字符，且不能包含控制字符", 400, "invalid_worker_display_alias");
    const body = parsed.data;
    const worker = await db.updateTable("workers")
      .set({ display_alias: body.displayAlias, updated_at: new Date() })
      .where("executor_id", "=", request.params.id)
      .where("deleted_at", "is", null)
      .returning(["display_name", "display_alias"])
      .executeTakeFirst();
    if (!worker) throw new AppError("执行器不存在", 404, "not_found");
    events.publish("worker", request.params.id);
    return {
      ok: true,
      displayAlias: worker.display_alias,
      reportedDisplayName: worker.display_name,
      displayName: effectiveWorkerDisplayName(worker)
    };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/workers/:id/commands", async (request) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const body = workerCommandSchema.parse(request.body);
    if (body.command === "revoke_credentials") {
      await db.transaction().execute(async (trx) => {
        await lockExecutorClaim(trx, request.params.id);
        const worker = await trx.selectFrom("workers").select("executor_id")
          .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
        if (!worker) throw new AppError("执行器不存在", 404, "not_found");
        const result = await trx.updateTable("worker_device_credentials").set({ revoked_at: new Date() })
          .where("executor_id", "=", request.params.id).where("revoked_at", "is", null).executeTakeFirst();
        if (!result.numUpdatedRows) throw new AppError("执行器没有可撤销的设备凭据", 409, "credential_not_active");
        await trx.updateTable("workers").set({
          operational_mode: "disabled", status: "offline", upgrade_drain_token_hash: null, upgrade_drain_previous_mode: null, updated_at: new Date()
        }).where("executor_id", "=", request.params.id).execute();
      });
      events.publish("worker", request.params.id);
      return { ok: true, operationalMode: "disabled", credentialsRevoked: true };
    }
    const mode = body.command === "enable" ? "enabled" : body.command === "disable" ? "disabled" : "maintenance";
    const updated = await db.updateTable("workers").set({
      operational_mode: mode, upgrade_drain_token_hash: null, upgrade_drain_previous_mode: null, updated_at: new Date()
    })
      .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).returning("executor_id").executeTakeFirst();
    if (!updated) throw new AppError("执行器不存在", 404, "not_found");
    events.publish("worker", request.params.id);
    return { ok: true, operationalMode: mode };
  });

  app.delete<{ Params: { id: string } }>("/v1/admin/workers/:id", async (request) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, request.params.id);
      const worker = await trx.selectFrom("workers").select(["executor_id", "operational_mode"])
        .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      if (!worker) throw new AppError("执行器不存在", 404, "not_found");
      if (worker.operational_mode !== "disabled") throw new AppError("只有已停用的执行器可以删除", 409, "worker_not_disabled");
      const unfinished = await trx.selectFrom("tasks").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "not in", ["completed", "failed", "cancelled"])
        .executeTakeFirstOrThrow();
      if (unfinished.count > 0) throw new AppError("执行器仍有关联的未结束任务，不能删除", 409, "worker_has_active_tasks");
      const unfinishedRuntimeSync = await trx.selectFrom("skill_file_sync_jobs").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "in", ["queued", "running"]).executeTakeFirstOrThrow();
      if (unfinishedRuntimeSync.count > 0) throw new AppError("执行器仍有关联的未结束技能同步任务，不能删除", 409, "worker_has_active_runtime_sync");
      await trx.updateTable("worker_device_credentials").set({ revoked_at: now })
        .where("executor_id", "=", request.params.id).where("revoked_at", "is", null).execute();
      await trx.updateTable("workers").set({ deleted_at: now, status: "offline", updated_at: now })
        .where("executor_id", "=", request.params.id).execute();
    });
    events.publish("worker", request.params.id);
    return { ok: true };
  });

  app.get("/v1/admin/approvals", async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.selectFrom("approvals").select(["id", "task_id", "method", "state", "expires_at", "created_at"]).orderBy("created_at", "desc").limit(100).execute();
    return { items: rows.map((row) => ({ ...row, expires_at: iso(row.expires_at), created_at: iso(row.created_at) })) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/approvals/:id/decision", async (request) => {
    const principal = await requireAdmin(db, config, request, true);
    requireCsrf(request, principal);
    const body = decisionSchema.parse(request.body);
    const taskId = await repository.decideApproval(request.params.id, principal.openId, body.approved);
    events.publish("approval", request.params.id); events.publish("task", taskId);
    return { ok: true, taskId };
  });

  app.get("/v1/admin/outbox", async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.selectFrom("outbox_messages").select(["id", "task_id", "state", "attempt", "last_error", "platform_message_id", "created_at", "updated_at"]).orderBy("created_at", "desc").limit(100).execute();
    return { items: rows.map((row) => ({ ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) })) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/outbox/:id/commands", async (request) => {
    const principal = await requireAdmin(db, config, request, true);
    requireCsrf(request, principal);
    const body = outboxCommandSchema.parse(request.body);
    const row = await db
      .selectFrom("outbox_messages")
      .innerJoin("tasks", "tasks.id", "outbox_messages.task_id")
      .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
      .leftJoin("task_outputs", "task_outputs.task_id", "tasks.id")
      .leftJoin("drafts", "drafts.id", "outbox_messages.draft_id")
      .selectAll("outbox_messages")
      .select(["conversations.chat_id", "conversations.chat_type", "tasks.bot_id", "task_outputs.message_id as output_message_id", "task_outputs.transport", "drafts.base_room_seq"])
      .where("outbox_messages.id", "=", request.params.id)
      .executeTakeFirst();
    if (!row || row.state !== "unknown") throw new AppError("只有发送结果不确定的消息可以处置", 409, "invalid_outbox_state");
    let state = row.state;
    let platformMessageId = row.platform_message_id;
    if (body.command === "retry") {
      if (!["message_send", "bot_dialogue_guard"].includes(row.operation_kind)) throw new AppError("流式回复结果不确定，禁止降级为新消息；请先核查任务输出记录", 409, "stream_output_unknown");
      try {
        platformMessageId = await (await gateways.gateway(row.bot_id)).sendMarkdownToChat(row.chat_id, row.content, row.idempotency_key);
        state = "sent";
      } catch (error) {
        await db.updateTable("outbox_messages").set({ last_error: errorMessage(error), updated_at: new Date(), attempt: row.attempt + 1 }).where("id", "=", row.id).execute();
        throw error;
      }
    } else state = body.command === "mark_sent" ? "sent" : "discarded";
    await db.updateTable("outbox_messages").set({ state, platform_message_id: platformMessageId, updated_at: new Date(), sent_at: state === "sent" ? new Date() : row.sent_at, attempt: body.command === "retry" ? row.attempt + 1 : row.attempt }).where("id", "=", row.id).execute();
    events.publish("outbox", row.id);
    return { ok: true, state };
  });

  app.get("/v1/admin/incidents", async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.selectFrom("incidents").selectAll().orderBy("state").orderBy("last_seen_at", "desc").limit(200).execute();
    return { items: rows.map((row) => ({ ...row, first_seen_at: iso(row.first_seen_at), last_seen_at: iso(row.last_seen_at), resolved_at: iso(row.resolved_at), acknowledged_at: iso(row.acknowledged_at) })) };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/incidents/:id/acknowledge", async (request) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const updated = await db.updateTable("incidents").set({ state: "acknowledged", acknowledged_by: principal.openId, acknowledged_at: new Date(), updated_at: new Date() }).where("id", "=", request.params.id).where("state", "!=", "resolved").returning("id").executeTakeFirst();
    if (!updated) throw new AppError("故障不存在或已恢复", 409, "incident_not_open");
    events.publish("incident", request.params.id);
    return { ok: true };
  });

  app.get("/v1/admin/stream", async (request, reply) => {
    await requireAdmin(db, config, request);
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = (event: unknown) => reply.raw.write(`event: change\ndata: ${JSON.stringify(event)}\n\n`);
    const keepalive = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);
    events.on("change", send);
    request.raw.once("close", () => { clearInterval(keepalive); events.off("change", send); });
  });
}
