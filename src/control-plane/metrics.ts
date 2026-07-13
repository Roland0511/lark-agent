import type { FastifyInstance } from "fastify";
import { Gauge, Registry } from "prom-client";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import type { ControlPlaneConfig } from "./config.js";
import type { RuntimeStatus } from "./runtime-status.js";
import { AppError } from "../shared/errors.js";

export function registerMetrics(app: FastifyInstance, db: Kysely<Database>, config: ControlPlaneConfig, runtime: RuntimeStatus): void {
  const registry = new Registry();
  const tasks = new Gauge({ name: "lark_agent_tasks", help: "Current tasks by state", labelNames: ["state"], registers: [registry] });
  const workers = new Gauge({ name: "lark_agent_worker_online", help: "Worker online state", labelNames: ["executor_id"], registers: [registry] });
  const queueOldest = new Gauge({ name: "lark_agent_queue_oldest_seconds", help: "Age of the oldest queued task", registers: [registry] });
  const approvals = new Gauge({ name: "lark_agent_approvals_pending", help: "Pending approvals", registers: [registry] });
  const drafts = new Gauge({ name: "lark_agent_drafts_held", help: "Held drafts", registers: [registry] });
  const outbox = new Gauge({ name: "lark_agent_outbox", help: "Outbox messages by state", labelNames: ["state"], registers: [registry] });
  const outputs = new Gauge({ name: "lark_agent_outputs", help: "Task reply outputs by state", labelNames: ["state"], registers: [registry] });
  const incidents = new Gauge({ name: "lark_agent_incidents_open", help: "Open incidents by severity", labelNames: ["severity"], registers: [registry] });
  const consumers = new Gauge({ name: "lark_agent_consumer_ready", help: "Lark event consumer readiness", labelNames: ["event_key"], registers: [registry] });
  const consumersEnabled = new Gauge({ name: "lark_agent_consumer_enabled", help: "Lark event consumer enabled state", labelNames: ["event_key"], registers: [registry] });
  const consumersRequired = new Gauge({ name: "lark_agent_consumer_required", help: "Whether a Lark event consumer is required for core readiness", labelNames: ["event_key"], registers: [registry] });
  const awaitingFollowup = new Gauge({ name: "lark_agent_conversations_awaiting_followup", help: "Group conversations waiting for another message", registers: [registry] });
  const followupExpired = new Gauge({ name: "lark_agent_followup_expired_total", help: "Total follow-up conversations expired", registers: [registry] });
  const conversationTurns = new Gauge({ name: "lark_agent_conversation_turns_total", help: "Total group conversation turns created", registers: [registry] });

  app.get("/metrics", async (request, reply) => {
    const authorization = request.headers.authorization;
    if (!config.metricsBearerToken || authorization !== `Bearer ${config.metricsBearerToken}`) throw new AppError("unauthorized", 401, "metrics_unauthorized");
    tasks.reset(); workers.reset(); outbox.reset(); outputs.reset(); incidents.reset(); consumers.reset(); consumersEnabled.reset(); consumersRequired.reset();
    const [taskRows, workerRows, oldest, approvalRow, draftRow, outboxRows, outputRows, incidentRows, awaitingRow, expiredRow, turnsRow] = await Promise.all([
      db.selectFrom("tasks").select(["state", sql<number>`count(*)::int`.as("count")]).groupBy("state").execute(),
      db.selectFrom("workers").select(["executor_id", "last_seen_at", "operational_mode"]).where("deleted_at", "is", null).execute(),
      db.selectFrom("tasks").select(sql<number | null>`extract(epoch from (now() - min(created_at)))`.as("seconds")).where("state", "in", ["queued", "waiting_worker"]).executeTakeFirstOrThrow(),
      db.selectFrom("approvals").select(sql<number>`count(*)::int`.as("count")).where("state", "=", "pending").executeTakeFirstOrThrow(),
      db.selectFrom("drafts").select(sql<number>`count(*)::int`.as("count")).where("state", "=", "held").executeTakeFirstOrThrow(),
      db.selectFrom("outbox_messages").select(["state", sql<number>`count(*)::int`.as("count")]).groupBy("state").execute(),
      db.selectFrom("task_outputs").select(["state", sql<number>`count(*)::int`.as("count")]).groupBy("state").execute(),
      db.selectFrom("incidents").select(["severity", sql<number>`count(*)::int`.as("count")]).where("state", "!=", "resolved").groupBy("severity").execute(),
      db.selectFrom("conversations").select(sql<number>`count(*)::int`.as("count")).where("active", "=", true).where("followup_expires_at", "is not", null).executeTakeFirstOrThrow(),
      db.selectFrom("task_events").select(sql<number>`count(*)::int`.as("count")).where("event_type", "=", "conversation.followup_expired").executeTakeFirstOrThrow(),
      db.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id").select(sql<number>`count(*)::int`.as("count")).where("conversations.chat_type", "=", "group").executeTakeFirstOrThrow()
    ]);
    taskRows.forEach((row) => tasks.set({ state: row.state }, row.count));
    workerRows.forEach((row) => workers.set({ executor_id: row.executor_id }, row.operational_mode === "enabled" && Date.now() - new Date(row.last_seen_at).getTime() <= 90_000 ? 1 : 0));
    queueOldest.set(Number(oldest.seconds ?? 0)); approvals.set(approvalRow.count); drafts.set(draftRow.count);
    outboxRows.forEach((row) => outbox.set({ state: row.state }, row.count));
    outputRows.forEach((row) => outputs.set({ state: row.state }, row.count));
    incidentRows.forEach((row) => incidents.set({ severity: row.severity }, row.count));
    awaitingFollowup.set(awaitingRow.count); followupExpired.set(expiredRow.count); conversationTurns.set(turnsRow.count);
    const status = runtime.snapshot();
    Object.entries(status).forEach(([eventKey, value]) => {
      consumers.set({ event_key: eventKey }, value.ready ? 1 : 0);
      consumersEnabled.set({ event_key: eventKey }, value.enabled ? 1 : 0);
      consumersRequired.set({ event_key: eventKey }, value.required ? 1 : 0);
    });
    reply.header("content-type", registry.contentType);
    return registry.metrics();
  });
}
