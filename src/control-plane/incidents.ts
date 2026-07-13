import { sql, type Kysely } from "kysely";
import type { Database } from "../db/types.js";
import { sha256 } from "../shared/crypto.js";
import { errorMessage } from "../shared/errors.js";
import type { LarkGateway } from "../lark/gateway.js";
import type { ControlPlaneConfig } from "./config.js";
import type { RuntimeStatus } from "./runtime-status.js";
import { AdminEventBus } from "./admin-events.js";
import { BotGatewayRegistry } from "./bot-runtime.js";

interface Finding {
  fingerprint: string;
  kind: string;
  severity: "warning" | "critical";
  title: string;
  summary: string;
  relatedType: string | null;
  relatedId: string | null;
}

export class IncidentService {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly config: ControlPlaneConfig,
    private readonly lark: LarkGateway | BotGatewayRegistry,
    private readonly runtime: RuntimeStatus,
    private readonly events: AdminEventBus
  ) {}

  async evaluate(): Promise<void> {
    const findings = await this.findings();
    const active = new Set(findings.map((item) => item.fingerprint));
    for (const finding of findings) await this.upsert(finding);
    const managedKinds = ["worker_offline", "task_waiting", "task_claim_slow", "task_long_running", "attention_slow", "execution_slow", "lease_recovery_stopped", "worker_failures", "outbox_unknown", "output_unknown", "consumer_down", "config_changed"];
    const open = await this.db.selectFrom("incidents").selectAll().where("state", "!=", "resolved").where("kind", "in", managedKinds).execute();
    for (const incident of open) {
      if (active.has(incident.fingerprint)) continue;
      await this.db.updateTable("incidents").set({ state: "resolved", resolved_at: new Date(), updated_at: new Date() }).where("id", "=", incident.id).execute();
      if (incident.notification_message_id && this.config.alertsEnabled && this.config.larkEnabled) {
        const target = await this.systemTarget();
        await target?.gateway.updateCard(incident.notification_message_id, incidentCard(incident.title, "已恢复", "green")).catch(() => undefined);
      }
      this.events.publish("incident", incident.id);
    }
  }

  private async findings(): Promise<Finding[]> {
    const now = Date.now();
    const [workers, waiting, claimSlow, running, failures, unknown, outputUnknown, changed, bots, slowEvents, leaseStops, activeByWorker] = await Promise.all([
      this.db.selectFrom("workers").selectAll().where("operational_mode", "=", "enabled").where("deleted_at", "is", null).execute(),
      this.db.selectFrom("tasks").select(["id", "state", "created_at", "executor_id"]).where("state", "in", ["queued", "waiting_worker"]).where("created_at", "<", new Date(now - 5 * 60_000)).execute(),
      this.db.selectFrom("tasks").select(["id", "state", "created_at", "preferred_executor_id"]).where("state", "in", ["queued", "waiting_worker"]).where("created_at", "<", new Date(now - 3_000)).execute(),
      this.db.selectFrom("tasks").select(["id", "created_at", "executor_id"]).where("state", "=", "running").where("created_at", "<", new Date(now - 60 * 60_000)).execute(),
      this.db.selectFrom("tasks").select(["executor_id", sql<number>`count(*)::int`.as("count")]).where("state", "=", "failed").where("updated_at", ">", new Date(now - 15 * 60_000)).where("executor_id", "is not", null).groupBy("executor_id").having(sql`count(*)`, ">=", 3).execute(),
      this.db.selectFrom("outbox_messages").select(["id", "task_id", "last_error"]).where("state", "=", "unknown").execute(),
      this.db.selectFrom("task_outputs").select(["task_id", "last_error"]).where("state", "=", "unknown").execute(),
      this.db.selectFrom("tasks").select(["id", "executor_id"]).where("state", "=", "waiting_input").where("summary", "like", "%配置指纹%").execute(),
      this.db.selectFrom("bots").select(["id", "display_name", "is_system"]).where("enabled", "=", true).where("deleted_at", "is", null).execute(),
      this.db.selectFrom("task_events").innerJoin("tasks", "tasks.id", "task_events.task_id").select(["task_events.task_id", "task_events.event_type", "task_events.created_at"]).where("tasks.state", "=", "running").where("task_events.event_type", "in", ["attention.slow", "execution.slow"]).execute(),
      this.db.selectFrom("task_events").innerJoin("tasks", "tasks.id", "task_events.task_id").select(["task_events.task_id", "task_events.created_at"]).where("tasks.state", "=", "waiting_input").where("task_events.event_type", "=", "task.lease_recovery_stopped").execute(),
      this.db.selectFrom("tasks").select(["executor_id", sql<number>`count(*)::int`.as("count")]).where("state", "=", "running").where("executor_id", "is not", null).groupBy("executor_id").execute()
    ]);
    const result: Finding[] = [];
    for (const worker of workers) if (now - new Date(worker.last_seen_at).getTime() > 90_000) result.push(finding("worker_offline", worker.executor_id, "critical", "执行器已离线", `${worker.display_name} 超过 90 秒没有心跳`, "worker", worker.executor_id));
    for (const task of waiting) result.push(finding("task_waiting", task.id, "warning", "任务等待执行器", `任务已等待超过 5 分钟（${task.state}）`, "task", task.id));
    const activeCounts = new Map(activeByWorker.map((row) => [row.executor_id, row.count]));
    for (const task of claimSlow) {
      if (!task.preferred_executor_id) continue;
      const worker = workers.find((candidate) => candidate.executor_id === task.preferred_executor_id);
      if (!worker || now - new Date(worker.last_seen_at).getTime() > 45_000 || (activeCounts.get(worker.executor_id) ?? 0) >= worker.capacity) continue;
      result.push(finding("task_claim_slow", task.id, "warning", "空闲执行器未及时领取", `任务超过 3 秒未被 ${worker.display_name} 领取，检查 Worker 长轮询和契约`, "task", task.id));
    }
    for (const task of running) result.push(finding("task_long_running", task.id, "warning", "任务运行时间过长", "任务已运行超过 60 分钟", "task", task.id));
    for (const event of slowEvents) result.push(finding(event.event_type === "attention.slow" ? "attention_slow" : "execution_slow", event.task_id, "warning", event.event_type === "attention.slow" ? "注意力判断响应缓慢" : "模型响应缓慢", event.event_type === "attention.slow" ? "注意力判断已超过 15 秒" : "正式执行已超过 60 秒没有 App Server 事件；任务仍继续运行", "task", event.task_id));
    for (const event of leaseStops) result.push(finding("lease_recovery_stopped", event.task_id, "critical", "任务启动契约持续失败", "任务在建立 Codex thread 前连续三次租约过期，已停止自动重领", "task", event.task_id));
    for (const row of failures) if (row.executor_id) result.push(finding("worker_failures", row.executor_id, "critical", "执行器连续失败", `15 分钟内失败 ${row.count} 次`, "worker", row.executor_id));
    for (const row of unknown) result.push(finding("outbox_unknown", row.id, "critical", "飞书发送结果不确定", row.last_error?.slice(0, 180) ?? "需要人工核查", "outbox", row.id));
    for (const row of outputUnknown) result.push(finding("output_unknown", row.task_id, "critical", "流式回复状态不确定", row.last_error?.slice(0, 180) ?? "禁止自动创建第二条消息，需要人工核查", "task", row.task_id));
    for (const row of changed) result.push(finding("config_changed", row.id, "critical", "执行器配置发生变化", "旧线程已安全暂停，等待主人确认", "task", row.id));
    const consumers = this.runtime.snapshot();
    if (this.config.larkEnabled && now - this.runtime.startedAt.getTime() > 60_000) {
      for (const [key, status] of Object.entries(consumers)) {
        if (!status.enabled || status.ready) continue;
        const botId = key.split(":")[0] ?? "";
        const bot = bots.find((item) => item.id === botId);
        const messageConsumer = key === "im.message.receive_v1" || key.endsWith(":message");
        const critical = messageConsumer && (bot ? bot.is_system : status.required);
        const botPrefix = bot ? `${bot.display_name} ` : "飞书";
        result.push(finding(
          "consumer_down",
          key,
          critical ? "critical" : "warning",
          messageConsumer ? `${botPrefix}消息接入未就绪` : `${botPrefix}卡片操作不可用`,
          status.lastError ?? (messageConsumer ? `${key} 未 ready` : `${key} 未 ready，仅影响卡片按钮`),
          "consumer",
          key
        ));
      }
    }
    return result;
  }

  private async upsert(finding: Finding): Promise<void> {
    const existing = await this.db.selectFrom("incidents").selectAll().where("fingerprint", "=", finding.fingerprint).executeTakeFirst();
    const now = new Date();
    const incident = existing
      ? await this.db.updateTable("incidents").set({
          kind: finding.kind, severity: finding.severity, title: finding.title, summary: finding.summary,
          state: existing.state === "resolved" ? "open" : existing.state, related_type: finding.relatedType, related_id: finding.relatedId,
          occurrence_count: existing.state === "resolved" ? existing.occurrence_count + 1 : existing.occurrence_count, last_seen_at: now, resolved_at: null, updated_at: now
        }).where("id", "=", existing.id).returningAll().executeTakeFirstOrThrow()
      : await this.db.insertInto("incidents").values({
          fingerprint: finding.fingerprint, kind: finding.kind, severity: finding.severity, title: finding.title, summary: finding.summary,
          state: "open", related_type: finding.relatedType, related_id: finding.relatedId, first_seen_at: now, last_seen_at: now,
          acknowledged_by: null, acknowledged_at: null, resolved_at: null, notification_message_id: null, last_notified_at: null,
          last_notification_error: null, updated_at: now
        }).returningAll().executeTakeFirstOrThrow();
    const shouldNotify = this.config.alertsEnabled && this.config.larkEnabled && (!incident.last_notified_at || now.getTime() - new Date(incident.last_notified_at).getTime() >= 60 * 60_000);
    if (shouldNotify) {
      try {
        const target = await this.systemTarget();
        if (!target?.ownerOpenId) return;
        const card = incidentCard(finding.title, finding.summary, finding.severity === "critical" ? "red" : "orange");
        const messageId = incident.notification_message_id
          ? (await target.gateway.updateCard(incident.notification_message_id, card), incident.notification_message_id)
          : await target.gateway.sendCardToOpenId(target.ownerOpenId, card, `incident-${sha256(finding.fingerprint).slice(0, 24)}`);
        await this.db.updateTable("incidents").set({ notification_message_id: messageId, last_notified_at: now, last_notification_error: null, updated_at: now }).where("id", "=", incident.id).execute();
      } catch (error) {
        await this.db.updateTable("incidents").set({ last_notification_error: errorMessage(error).slice(0, 500), updated_at: now }).where("id", "=", incident.id).execute();
      }
    }
    this.events.publish("incident", incident.id);
  }

  private async systemTarget(): Promise<{ gateway: LarkGateway; ownerOpenId: string | null } | null> {
    if (this.lark instanceof BotGatewayRegistry) {
      const target = await this.lark.system();
      return target ? { gateway: target.gateway, ownerOpenId: target.bot.owner_open_id } : null;
    }
    return { gateway: this.lark, ownerOpenId: this.config.ownerOpenId };
  }
}

function finding(kind: string, key: string, severity: Finding["severity"], title: string, summary: string, relatedType: string, relatedId: string): Finding {
  return { fingerprint: `${kind}:${key}`, kind, severity, title, summary, relatedType, relatedId };
}

function incidentCard(title: string, summary: string, template: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: { tag: "plain_text", content: `Lark Agent 运维 · ${title}` } },
    elements: [{ tag: "div", text: { tag: "lark_md", content: summary } }]
  };
}
