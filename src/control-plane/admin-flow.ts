import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database, Task } from "../db/types.js";
import type { ControlPlaneConfig } from "./config.js";
import { requireAdmin } from "./admin-auth.js";
import type { RuntimeStatus } from "./runtime-status.js";
import { AppError } from "../shared/errors.js";
import { publicAttachments } from "../lark/attachments.js";
import { effectiveWorkerDisplayName } from "./worker-display-name.js";

const flowStages = ["message", "inbox", "attention", "routing", "codex", "draft", "outbox", "reply"] as const;
type FlowStage = (typeof flowStages)[number];

interface StageEvent {
  event_type: string;
  created_at: Date | string;
  payload?: unknown;
}

const latencyStageDefinitions = [
  { key: "event_to_task", label: "事件到任务创建", start: ["event.received"], end: ["task.created"] },
  { key: "event_to_claim", label: "事件到领取", start: ["event.received"], end: ["task.claimed"] },
  { key: "thread_ready", label: "Codex Thread 就绪", start: ["task.claimed"], end: ["codex.thread.ready", "codex.thread"] },
  { key: "attention", label: "注意力判断", start: ["attention.started"], end: ["attention.completed"] },
  { key: "execution", label: "正式执行", start: ["execution.started"], end: ["execution.completed"] },
  { key: "first_commentary", label: "首条 Commentary", start: ["execution.started"], end: ["execution.first_commentary"] },
  { key: "delivery", label: "草稿检查与发送", start: ["draft.checked"], end: ["card.finalized"] },
  { key: "total", label: "端到端", start: ["event.received"], end: ["task.completed"] }
] as const;

interface FlowQuery {
  view?: "flow" | "inbox" | "outbox";
  range?: "1h" | "24h" | "7d" | "all";
  stage?: FlowStage;
  state?: string;
  chat_type?: string;
  executor?: string;
  workspace?: string;
  bot?: string;
  q?: string;
  before?: string;
  limit?: string;
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

function since(range = "24h"): Date | null {
  const hours = range === "1h" ? 1 : range === "7d" ? 168 : range === "all" ? null : 24;
  return hours === null ? null : new Date(Date.now() - hours * 3_600_000);
}

function ageSeconds(value: Date | string | null | undefined): number | null {
  return value ? Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1_000)) : null;
}

function elapsed(start: Date | string | null | undefined, end: Date | string | null | undefined): number | null {
  if (!start || !end) return null;
  return Math.max(0, Math.round(new Date(end).getTime() - new Date(start).getTime()) / 1_000);
}

function buildStageTimings(events: StageEvent[]) {
  const find = (types: readonly string[], after?: Date | string | null) => events.find((event) => types.includes(event.event_type) && (!after || new Date(event.created_at) >= new Date(after)));
  const timings = latencyStageDefinitions.map((definition) => {
    const start = find(definition.start);
    const end = start ? find(definition.end, start.created_at) : undefined;
    const completedWithoutCommentary = definition.key === "first_commentary" && start && !end
      ? find(["execution.completed"], start.created_at)
      : undefined;
    const startPayload = start?.payload && typeof start.payload === "object" ? start.payload as Record<string, unknown> : {};
    const endPayload = end?.payload && typeof end.payload === "object" ? end.payload as Record<string, unknown> : {};
    return {
      key: definition.key,
      label: definition.label,
      startedAt: iso(start?.created_at),
      completedAt: iso(end?.created_at),
      durationSeconds: elapsed(start?.created_at, end?.created_at),
      state: !start ? "not_started" : end ? "completed" : completedWithoutCommentary ? "skipped" : "running",
      model: typeof startPayload.model === "string" ? startPayload.model : null,
      effort: typeof startPayload.effort === "string" ? startPayload.effort : null,
      tokenUsage: endPayload.tokenUsage && typeof endPayload.tokenUsage === "object" ? endPayload.tokenUsage : null
    };
  });
  const completed = timings.filter((timing) => timing.durationSeconds != null && timing.key !== "total");
  const slowest = completed.sort((left, right) => (right.durationSeconds ?? 0) - (left.durationSeconds ?? 0))[0] ?? null;
  const total = timings.find((timing) => timing.key === "total")?.durationSeconds ?? completed.reduce((sum, timing) => sum + (timing.durationSeconds ?? 0), 0);
  return {
    timings,
    bottleneck: slowest ? { ...slowest, share: total > 0 ? (slowest.durationSeconds ?? 0) / total : null } : null
  };
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))] ?? null;
}

function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    /(secret|password|access_token|refresh_token|session_token|device_token|lease_token|authorization)/i.test(key) ? "[已隐藏]" : redactSecrets(entry)
  ]));
}

function publicTask(task: Task) {
  const { lease_token_hash: _leaseTokenHash, authorization_grant: _authorizationGrant, ...safe } = task;
  return safe;
}

function flowHealth(task: Task, signalDecisions: string[], draftState?: string, approvalState?: string, outputState?: string, outboxState?: string) {
  if (task.state === "failed" || [outputState, outboxState].some((state) => state === "failed" || state === "unknown")) return "failed";
  if (task.state === "human_owned") return "human";
  if (["waiting_input", "waiting_approval", "held_draft"].includes(task.state) || draftState === "held" || approvalState === "pending" || signalDecisions.includes("defer")) return "warning";
  if (["queued", "waiting_worker", "running"].includes(task.state) || signalDecisions.includes("pending")) return "waiting";
  return "normal";
}

function currentStage(task: Task, signalDecisions: string[], draftState?: string, approvalState?: string, outputState?: string, outboxState?: string, chatContextState?: string | null): FlowStage {
  if (["unknown", "failed", "pending"].includes(outboxState ?? "") || ["pending", "streaming", "held", "unknown", "failed"].includes(outputState ?? "")) return "outbox";
  if (["drafted", "held"].includes(draftState ?? "") || approvalState === "pending") return "draft";
  if (chatContextState === "blocked") return "routing";
  if (["running", "waiting_input", "waiting_approval", "human_owned"].includes(task.state)) return "codex";
  if (["queued", "waiting_worker"].includes(task.state)) return "routing";
  if (signalDecisions.includes("pending") || signalDecisions.includes("defer") || (signalDecisions.length > 0 && signalDecisions.every((value) => value === "dismiss"))) return "attention";
  return "reply";
}

export function registerAdminFlowRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  runtime: RuntimeStatus
): void {
  app.get<{ Querystring: { range?: string } }>("/v1/admin/flow/summary", async (request) => {
    await requireAdmin(db, config, request);
    const start = since(request.query.range);
    const [signals, tasks, drafts, approvals, outputs, outbox, taskEvents] = await Promise.all([
      db.selectFrom("signals").selectAll().where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute(),
      db.selectFrom("tasks").selectAll().where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute(),
      db.selectFrom("drafts").selectAll().where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute(),
      db.selectFrom("approvals").selectAll().where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute(),
      db.selectFrom("task_outputs").selectAll().where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute(),
      db.selectFrom("outbox_messages").selectAll().where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute(),
      db.selectFrom("task_events").select(["task_id", "event_type", "created_at"]).where((eb) => start ? eb("created_at", ">=", start) : eb.val(true)).execute()
    ]);
    const oldest = (dates: Array<Date | string>) => dates.length ? ageSeconds(dates.sort((a, b) => +new Date(a) - +new Date(b))[0]) : null;
    const summaries = [
      { stage: "message", active: runtime.requiredReady() ? 0 : 1, passed: signals.length, warnings: 0, failed: runtime.requiredReady() ? 0 : 1, oldestWaitingSeconds: null, healthy: runtime.requiredReady() },
      { stage: "inbox", active: signals.filter((x) => x.decision === "pending" || x.decision === "defer").length, passed: signals.length, warnings: signals.filter((x) => x.decision === "defer").length, failed: 0, oldestWaitingSeconds: oldest(signals.filter((x) => x.decision === "pending" || x.decision === "defer").map((x) => x.created_at)), healthy: true },
      { stage: "attention", active: signals.filter((x) => x.decision === "pending").length, passed: signals.filter((x) => x.decision !== "pending").length, warnings: signals.filter((x) => x.decision === "defer").length, failed: 0, oldestWaitingSeconds: oldest(signals.filter((x) => x.decision === "pending").map((x) => x.created_at)), healthy: true },
      { stage: "routing", active: tasks.filter((x) => x.state === "queued" || x.state === "waiting_worker").length, passed: tasks.filter((x) => x.executor_id).length, warnings: tasks.filter((x) => x.state === "waiting_worker").length, failed: 0, oldestWaitingSeconds: oldest(tasks.filter((x) => x.state === "queued" || x.state === "waiting_worker").map((x) => x.created_at)), healthy: true },
      { stage: "codex", active: tasks.filter((x) => ["running", "waiting_input", "human_owned"].includes(x.state)).length, passed: tasks.filter((x) => x.codex_thread_id).length, warnings: tasks.filter((x) => ["waiting_input", "human_owned"].includes(x.state)).length, failed: tasks.filter((x) => x.state === "failed").length, oldestWaitingSeconds: oldest(tasks.filter((x) => ["running", "waiting_input", "human_owned"].includes(x.state)).map((x) => x.updated_at)), healthy: true },
      { stage: "draft", active: drafts.filter((x) => x.state === "drafted" || x.state === "held").length + approvals.filter((x) => x.state === "pending").length, passed: drafts.filter((x) => x.state === "sent").length, warnings: drafts.filter((x) => x.state === "held").length + approvals.filter((x) => x.state === "pending").length, failed: 0, oldestWaitingSeconds: oldest(drafts.filter((x) => x.state === "drafted" || x.state === "held").map((x) => x.created_at)), healthy: true },
      { stage: "outbox", active: outbox.filter((x) => x.state === "pending" || x.state === "unknown").length + outputs.filter((x) => ["pending", "streaming", "held", "unknown"].includes(x.state)).length, passed: outbox.filter((x) => x.state === "sent").length, warnings: outputs.filter((x) => x.state === "held").length, failed: outbox.filter((x) => x.state === "unknown").length + outputs.filter((x) => x.state === "failed" || x.state === "unknown").length, oldestWaitingSeconds: oldest(outbox.filter((x) => x.state === "pending" || x.state === "unknown").map((x) => x.created_at)), healthy: true },
      { stage: "reply", active: 0, passed: outbox.filter((x) => x.state === "sent" && x.platform_message_id).length, warnings: 0, failed: outbox.filter((x) => x.state === "sent" && !x.platform_message_id).length, oldestWaitingSeconds: null, healthy: true }
    ];
    const eventsByTask = new Map<string, StageEvent[]>();
    for (const event of taskEvents) eventsByTask.set(event.task_id, [...(eventsByTask.get(event.task_id) ?? []), event]);
    const durations = new Map<string, number[]>();
    for (const taskStageEvents of eventsByTask.values()) {
      for (const timing of buildStageTimings(taskStageEvents).timings) {
        if (timing.durationSeconds == null) continue;
        durations.set(timing.key, [...(durations.get(timing.key) ?? []), timing.durationSeconds]);
      }
    }
    const latencyStages = latencyStageDefinitions.map((definition) => {
      const values = durations.get(definition.key) ?? [];
      return { key: definition.key, label: definition.label, count: values.length, p50Seconds: percentile(values, 0.5), p95Seconds: percentile(values, 0.95) };
    });
    return { stages: summaries, latencyStages };
  });

  app.get<{ Querystring: FlowQuery }>("/v1/admin/flow/items", async (request) => {
    await requireAdmin(db, config, request);
    const view = request.query.view ?? "flow";
    const limit = Math.min(Math.max(Number(request.query.limit ?? 40), 1), 100);
    const start = since(request.query.range);
    if (view === "inbox") {
      let query = db.selectFrom("signals").innerJoin("tasks", "tasks.id", "signals.task_id").innerJoin("conversations", "conversations.id", "signals.conversation_id").innerJoin("bots", "bots.id", "signals.bot_id")
        .leftJoin("workers as task_workers", "task_workers.executor_id", "tasks.executor_id")
        .select(["signals.id", "signals.bot_id", "bots.app_id as bot_app_id", "bots.display_name as bot_display_name", "signals.conversation_id", "signals.task_id", "signals.event_id", "signals.seq", "signals.message_id", "signals.sender_id", "signals.sender_role", "signals.sender_type", "signals.sender_bot_id", "signals.sender_display_name", "signals.ingress_source", "signals.origin_message_id", "signals.bot_dialogue_depth", "signals.message_type", "signals.content", "signals.attachments", "signals.priority", "signals.decision", "signals.decision_rationale", "signals.created_at", "signals.decided_at", "tasks.turn_index", "tasks.state as task_state", "tasks.codex_thread_id", "tasks.executor_id", "tasks.resolved_workspace_alias", "conversations.chat_id", "conversations.chat_type", sql<string | null>`coalesce(task_workers.display_alias, task_workers.display_name)`.as("executor_display_name")])
        .orderBy(sql`CASE WHEN signals.decision IN ('pending','defer') THEN 0 ELSE 1 END`).orderBy("signals.created_at", "desc").limit(limit + 1);
      if (start) query = query.where("signals.created_at", ">=", start);
      if (request.query.state) query = query.where("signals.decision", "=", request.query.state);
      if (request.query.chat_type) query = query.where("conversations.chat_type", "=", request.query.chat_type);
      if (request.query.executor) query = query.where("tasks.executor_id", "=", request.query.executor);
      if (request.query.workspace) query = query.where("tasks.resolved_workspace_alias", "=", request.query.workspace);
      if (request.query.bot) query = query.where("signals.bot_id", "=", request.query.bot);
      if (request.query.q) query = query.where("signals.content", "ilike", `%${request.query.q.replace(/[%_]/g, "")}%`);
      if (request.query.before) query = query.where("signals.created_at", "<", new Date(request.query.before));
      const rows = await query.execute();
      return { items: rows.slice(0, limit).map((row) => ({ ...row, attachments: publicAttachments(row.attachments), created_at: iso(row.created_at), decided_at: iso(row.decided_at), decisionSeconds: elapsed(row.created_at, row.decided_at), enteredCodex: Boolean(row.codex_thread_id) })), nextCursor: rows.length > limit ? iso(rows[limit - 1]?.created_at) : null };
    }
    if (view === "outbox") {
      let query = db.selectFrom("outbox_messages").innerJoin("tasks", "tasks.id", "outbox_messages.task_id").innerJoin("conversations", "conversations.id", "tasks.conversation_id").innerJoin("bots", "bots.id", "tasks.bot_id")
        .leftJoin("workers as task_workers", "task_workers.executor_id", "tasks.executor_id")
        .leftJoin("drafts", "drafts.id", "outbox_messages.draft_id").leftJoin("task_outputs", "task_outputs.task_id", "tasks.id")
        .select(["outbox_messages.id", "outbox_messages.task_id", "outbox_messages.draft_id", "outbox_messages.target_message_id", "outbox_messages.content", "outbox_messages.idempotency_key", "outbox_messages.operation_kind", "outbox_messages.state", "outbox_messages.platform_message_id", "outbox_messages.attempt", "outbox_messages.last_error", "outbox_messages.created_at", "outbox_messages.updated_at", "outbox_messages.sent_at", "tasks.bot_id", "bots.app_id as bot_app_id", "bots.display_name as bot_display_name", "tasks.turn_index", "tasks.trigger_message_id", "tasks.state as task_state", "tasks.executor_id", "tasks.resolved_workspace_alias", "conversations.chat_id", "conversations.chat_type", "drafts.base_room_seq", "drafts.observed_room_seq", "drafts.hold_count", "task_outputs.transport", "task_outputs.state as output_state", "task_outputs.sequence", "task_outputs.card_id", "task_outputs.message_id as output_message_id", sql<string | null>`coalesce(task_workers.display_alias, task_workers.display_name)`.as("executor_display_name")])
        .orderBy(sql`CASE WHEN outbox_messages.state IN ('unknown','pending') THEN 0 ELSE 1 END`).orderBy("outbox_messages.created_at", "desc").limit(limit + 1);
      if (start) query = query.where("outbox_messages.created_at", ">=", start);
      if (request.query.state) query = query.where("outbox_messages.state", "=", request.query.state);
      if (request.query.chat_type) query = query.where("conversations.chat_type", "=", request.query.chat_type);
      if (request.query.executor) query = query.where("tasks.executor_id", "=", request.query.executor);
      if (request.query.workspace) query = query.where("tasks.resolved_workspace_alias", "=", request.query.workspace);
      if (request.query.bot) query = query.where("tasks.bot_id", "=", request.query.bot);
      if (request.query.q) query = query.where("outbox_messages.content", "ilike", `%${request.query.q.replace(/[%_]/g, "")}%`);
      if (request.query.before) query = query.where("outbox_messages.created_at", "<", new Date(request.query.before));
      const rows = await query.execute();
      return { items: rows.slice(0, limit).map((row) => ({ ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at), sent_at: iso(row.sent_at), deliverySeconds: elapsed(row.created_at, row.sent_at) })), nextCursor: rows.length > limit ? iso(rows[limit - 1]?.created_at) : null };
    }

    let query = db.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id").innerJoin("bots", "bots.id", "tasks.bot_id")
      .leftJoin("chat_contexts", "chat_contexts.id", "conversations.chat_context_id")
      .leftJoin("workers as task_workers", "task_workers.executor_id", "tasks.executor_id").selectAll("tasks")
      .select(["bots.app_id as bot_app_id", "bots.display_name as bot_display_name", "conversations.chat_id", "conversations.chat_type", "conversations.room_seq", "conversations.active as conversation_active", "conversations.followup_expires_at", "chat_contexts.state as chat_context_state", sql<string | null>`coalesce(task_workers.display_alias, task_workers.display_name)`.as("executor_display_name")])
      .orderBy(sql`CASE WHEN tasks.state IN ('completed','cancelled') THEN 1 ELSE 0 END`).orderBy("tasks.created_at", "desc").limit(limit + 1);
    if (start) query = query.where("tasks.created_at", ">=", start);
    if (request.query.state) query = query.where("tasks.state", "=", request.query.state as Task["state"]);
    if (request.query.chat_type) query = query.where("conversations.chat_type", "=", request.query.chat_type);
    if (request.query.executor) query = query.where("tasks.executor_id", "=", request.query.executor);
    if (request.query.workspace) query = query.where("tasks.resolved_workspace_alias", "=", request.query.workspace);
    if (request.query.bot) query = query.where("tasks.bot_id", "=", request.query.bot);
    if (request.query.q) {
      const prefix = `${request.query.q.replace(/[%_]/g, "")}%`;
      const contains = `%${request.query.q.replace(/[%_]/g, "")}%`;
      query = query.where(sql<boolean>`(tasks.id::text ILIKE ${prefix} OR tasks.conversation_id::text ILIKE ${prefix}
        OR EXISTS (SELECT 1 FROM signals flow_signal WHERE flow_signal.task_id = tasks.id AND flow_signal.content ILIKE ${contains})
        OR EXISTS (SELECT 1 FROM drafts flow_draft WHERE flow_draft.task_id = tasks.id AND flow_draft.content ILIKE ${contains})
        OR EXISTS (SELECT 1 FROM outbox_messages flow_outbox WHERE flow_outbox.task_id = tasks.id AND flow_outbox.content ILIKE ${contains}))`);
    }
    if (request.query.before) query = query.where("tasks.created_at", "<", new Date(request.query.before));
    const rows = await query.execute();
    const page = rows.slice(0, limit);
    const ids = page.map((row) => row.id);
    if (!ids.length) return { items: [], nextCursor: null };
    const [signals, events, drafts, approvals, outputs, outbox] = await Promise.all([
      db.selectFrom("signals").selectAll().where("task_id", "in", ids).orderBy("seq").execute(),
      db.selectFrom("task_events").selectAll().where("task_id", "in", ids).orderBy("created_at").execute(),
      db.selectFrom("drafts").selectAll().where("task_id", "in", ids).orderBy("created_at").execute(),
      db.selectFrom("approvals").selectAll().where("task_id", "in", ids).orderBy("created_at").execute(),
      db.selectFrom("task_outputs").selectAll().where("task_id", "in", ids).execute(),
      db.selectFrom("outbox_messages").selectAll().where("task_id", "in", ids).orderBy("created_at").execute()
    ]);
    const items = page.map((task) => {
      const taskSignals = signals.filter((x) => x.task_id === task.id);
      const taskEvents = events.filter((x) => x.task_id === task.id);
      const taskDraft = drafts.filter((x) => x.task_id === task.id).at(-1);
      const taskApproval = approvals.filter((x) => x.task_id === task.id).at(-1);
      const taskOutput = outputs.find((x) => x.task_id === task.id);
      const taskOutbox = outbox.filter((x) => x.task_id === task.id).at(-1);
      const decisions = taskSignals.map((x) => x.decision);
      const stage = currentStage(task, decisions, taskDraft?.state, taskApproval?.state, taskOutput?.state, taskOutbox?.state, task.chat_context_state);
      const latency = buildStageTimings(taskEvents);
      const codexEvent = taskEvents.find((event) => event.event_type === "codex.thread.ready" || event.event_type === "codex.thread");
      return {
        ...publicTask(task),
        executor_display_name: task.executor_display_name,
        created_at: iso(task.created_at), updated_at: iso(task.updated_at), completed_at: iso(task.completed_at), followup_expires_at: iso(task.followup_expires_at),
        currentStage: stage, health: flowHealth(task, decisions, taskDraft?.state, taskApproval?.state, taskOutput?.state, taskOutbox?.state),
        signal: taskSignals.at(-1) ? { ...taskSignals.at(-1), attachments: publicAttachments(taskSignals.at(-1)?.attachments), created_at: iso(taskSignals.at(-1)?.created_at), decided_at: iso(taskSignals.at(-1)?.decided_at) } : null,
        signalCount: taskSignals.length,
        codexEvent: codexEvent ? { ...codexEvent, created_at: iso(codexEvent.created_at) } : null,
        stageTimings: latency.timings,
        bottleneck: latency.bottleneck,
        draft: taskDraft ? { ...taskDraft, created_at: iso(taskDraft.created_at), sent_at: iso(taskDraft.sent_at) } : null,
        approval: taskApproval ? { ...taskApproval, created_at: iso(taskApproval.created_at), decided_at: iso(taskApproval.decided_at) } : null,
        output: taskOutput ? { ...taskOutput, created_at: iso(taskOutput.created_at), opened_at: iso(taskOutput.opened_at), closed_at: iso(taskOutput.closed_at) } : null,
        outbox: taskOutbox ? { ...taskOutbox, created_at: iso(taskOutbox.created_at), sent_at: iso(taskOutbox.sent_at) } : null
      };
    }).filter((item) => !request.query.stage || item.currentStage === request.query.stage);
    return { items, nextCursor: rows.length > limit ? iso(page.at(-1)?.created_at) : null };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/tasks/:id/trace", async (request) => {
    await requireAdmin(db, config, request);
    const task = await db.selectFrom("tasks").selectAll().where("id", "=", request.params.id).executeTakeFirst();
    if (!task) throw new AppError("任务不存在", 404, "not_found");
    const conversation = await db.selectFrom("conversations").selectAll().where("id", "=", task.conversation_id).executeTakeFirstOrThrow();
    const bot = await db.selectFrom("bots").select(["app_id", "display_name", "default_executor_id"]).where("id", "=", task.bot_id).executeTakeFirstOrThrow();
    const worker = task.executor_id ? await db.selectFrom("workers").select(["display_name", "display_alias"]).where("executor_id", "=", task.executor_id).executeTakeFirst() : null;
    const executorDisplayName = worker ? effectiveWorkerDisplayName(worker) : task.executor_id;
    const executorDescription = executorDisplayName && executorDisplayName !== task.executor_id ? `${executorDisplayName}（${task.executor_id}）` : task.executor_id;
    const [signals, events, drafts, approvals, output, updates, outbox, actions, latestTurn] = await Promise.all([
      db.selectFrom("signals").selectAll().where("task_id", "=", task.id).orderBy("seq").execute(),
      db.selectFrom("task_events").selectAll().where("task_id", "=", task.id).orderBy("created_at").execute(),
      db.selectFrom("drafts").selectAll().where("task_id", "=", task.id).orderBy("created_at").execute(),
      db.selectFrom("approvals").selectAll().where("task_id", "=", task.id).orderBy("created_at").execute(),
      db.selectFrom("task_outputs").selectAll().where("task_id", "=", task.id).executeTakeFirst(),
      db.selectFrom("task_output_updates").selectAll().where("task_id", "=", task.id).orderBy("created_at").execute(),
      db.selectFrom("outbox_messages").selectAll().where("task_id", "=", task.id).orderBy("created_at").execute(),
      db.selectFrom("action_receipts").selectAll().where("task_id", "=", task.id).orderBy("created_at").execute(),
      db.selectFrom("tasks").select(["turn_index"]).where("conversation_id", "=", task.conversation_id).orderBy("turn_index", "desc").executeTakeFirstOrThrow()
    ]);
    const processedEvents = signals.length ? await db.selectFrom("processed_events").selectAll().where("bot_id", "=", task.bot_id).where("event_id", "in", signals.map((signal) => signal.event_id)).execute() : [];
    const numericalSequences = updates.map((x) => x.sequence).filter((value): value is number => typeof value === "number");
    const monotonic = numericalSequences.every((value, index) => index === 0 || value > numericalSequences[index - 1]!);
    const latestDraft = drafts.at(-1);
    const latestOutbox = outbox.at(-1);
    const consumed = signals.some((x) => x.decision === "consume" || x.decision === "merge");
    const silent = signals.length > 0 && signals.every((x) => x.decision === "dismiss");
    const isLatest = task.turn_index === latestTurn.turn_index;
    const firstSignal = signals[0];
    const lastSignal = signals.at(-1);
    const codexEvent = events.find((event) => event.event_type.includes("codex"));
    const latency = buildStageTimings(events);
    const firstUpdate = updates[0];
    const lastUpdate = updates.at(-1);
    const checks = [
      check("event", signals.length > 0 && processedEvents.length === new Set(signals.map((signal) => signal.event_id)).size, "错误", processedEvents.length ? `去重账本已记录 ${processedEvents.length} 个飞书事件` : "任务没有对应的 processed_events 接收证据", firstSignal?.created_at, processedEvents.at(-1)?.processed_at, processedEvents.map((x) => x.event_id)),
      check("signal", signals.every((x) => x.task_id === task.id && x.conversation_id === task.conversation_id), "错误", "Signal 与任务、会话关联一致", firstSignal?.created_at, lastSignal?.created_at, signals.map((x) => x.id)),
      check("attention", !signals.some((x) => x.decision === "pending") || !["completed", "failed"].includes(task.state), "警告", signals.some((x) => x.decision === "pending") ? "仍有待判断 Signal" : "注意力判断已完成", firstSignal?.created_at, lastSignal?.decided_at, signals.map((x) => x.id)),
      check("executor", !consumed || Boolean(task.executor_id && task.resolved_workspace_alias), "错误", task.executor_id ? `执行器 ${executorDescription} · ${task.resolved_workspace_alias ? `${task.resolved_workspace_alias}/${bot.app_id}` : "总工作区缺失"}` : "已消费任务没有绑定执行器", task.created_at, task.executor_id ? task.updated_at : null, [task.executor_id, task.resolved_workspace_alias, bot.app_id].filter(Boolean) as string[]),
      check("codex", !consumed || Boolean(task.codex_thread_id), "错误", task.codex_thread_id ? `Codex thread ${task.codex_thread_id}` : "已消费任务缺少 Codex thread", codexEvent?.created_at ?? task.updated_at, task.codex_thread_id ? task.updated_at : null, [task.codex_thread_id].filter(Boolean) as string[]),
      check("draft", !latestDraft || latestDraft.observed_room_seq >= latestDraft.base_room_seq, "错误", latestDraft ? `草稿版本 ${latestDraft.base_room_seq} → ${latestDraft.observed_room_seq}` : silent ? "静默任务无需草稿" : "尚无草稿", latestDraft?.created_at, latestDraft?.sent_at ?? latestDraft?.updated_at, latestDraft ? [latestDraft.id] : []),
      check("sequence", monotonic, "错误", monotonic ? `输出 sequence 单调递增（${numericalSequences.join(", ") || "无更新"}）` : "输出 sequence 重复或倒退", firstUpdate?.created_at, lastUpdate?.sent_at ?? lastUpdate?.updated_at, updates.map((x) => x.id)),
      check("outbox", !(task.state === "completed" && !silent) || Boolean(latestOutbox), "错误", latestOutbox ? `Outbox ${latestOutbox.state}` : silent ? "静默任务无需发件箱" : "完成任务缺少 Outbox", latestOutbox?.created_at, latestOutbox?.sent_at ?? latestOutbox?.updated_at, latestOutbox ? [latestOutbox.id] : []),
      check("platform", !latestOutbox || latestOutbox.state !== "sent" || Boolean(latestOutbox.platform_message_id), "错误", latestOutbox?.platform_message_id ? `平台消息 ${latestOutbox.platform_message_id}` : "已发送记录缺少平台 message ID", latestOutbox?.created_at, latestOutbox?.sent_at, [latestOutbox?.platform_message_id].filter(Boolean) as string[]),
      check("lifecycle", !isLatest || lifecycleConsistent(task, conversation.active, conversation.followup_expires_at), "错误", `Conversation active=${conversation.active} · disposition=${task.conversation_disposition ?? "未判断"}`, task.created_at, task.completed_at, [task.conversation_id, task.id])
    ];
    return redactSecrets({
      task: { ...publicTask(task), executor_display_name: executorDisplayName, bot_app_id: bot.app_id, bot_display_name: bot.display_name, bot_default_executor_id: bot.default_executor_id, route_mismatch: Boolean(bot.default_executor_id && task.executor_id && bot.default_executor_id !== task.executor_id), created_at: iso(task.created_at), updated_at: iso(task.updated_at), completed_at: iso(task.completed_at) },
      conversation: { ...conversation, created_at: iso(conversation.created_at), updated_at: iso(conversation.updated_at), followup_expires_at: iso(conversation.followup_expires_at) },
      processed_events: processedEvents.map((x) => ({ ...x, received_at: iso(x.received_at), processed_at: iso(x.processed_at) })),
      signals: signals.map((x) => ({ ...x, attachments: publicAttachments(x.attachments), created_at: iso(x.created_at), decided_at: iso(x.decided_at) })),
      events: events.map((x) => ({ ...x, created_at: iso(x.created_at) })),
      drafts: drafts.map((x) => ({ ...x, created_at: iso(x.created_at), updated_at: iso(x.updated_at), sent_at: iso(x.sent_at) })),
      approvals: approvals.map((x) => ({ ...x, created_at: iso(x.created_at), decided_at: iso(x.decided_at), expires_at: iso(x.expires_at) })),
      output: output ? { ...output, created_at: iso(output.created_at), updated_at: iso(output.updated_at), opened_at: iso(output.opened_at), closed_at: iso(output.closed_at) } : null,
      updates: updates.map((x) => ({ ...x, created_at: iso(x.created_at), updated_at: iso(x.updated_at), sent_at: iso(x.sent_at) })),
      outbox: outbox.map((x) => ({ ...x, created_at: iso(x.created_at), updated_at: iso(x.updated_at), sent_at: iso(x.sent_at) })),
      actions: actions.map((x) => ({ ...x, created_at: iso(x.created_at) })),
      checks,
      stageTimings: latency.timings,
      bottleneck: latency.bottleneck
    });
  });
}

function check(key: string, ok: boolean, failureLevel: "警告" | "错误", detail: string, startedAt?: Date | string | null, completedAt?: Date | string | null, relatedIds: string[] = []) {
  return { key, state: ok ? "正常" : failureLevel, detail, startedAt: iso(startedAt), completedAt: iso(completedAt), durationSeconds: elapsed(startedAt, completedAt), relatedIds };
}

function lifecycleConsistent(task: Task, active: boolean, expiresAt: Date | string | null): boolean {
  if (task.conversation_disposition === "complete") return !active;
  if (task.conversation_disposition === "awaiting_followup") return active && Boolean(expiresAt);
  return true;
}
