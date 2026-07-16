import type { FastifyInstance, FastifyRequest } from "fastify";
import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import {
  adminDeviceCommandSchema,
  deviceCommandResultSchema,
  deviceManagerHeartbeatSchema,
  type AdminDeviceCommand
} from "../shared/contracts.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import { readDeviceBearer, verifyDeviceCredential } from "./auth.js";
import { requireAdmin, requireCsrf } from "./admin-auth.js";
import type { AdminEventBus } from "./admin-events.js";
import type { ControlPlaneConfig } from "./config.js";
import { lockExecutorClaim } from "./executor-claim-lock.js";

const commandLeaseSchema = z.object({ leaseToken: z.string().min(32).max(256) });
const commandFailureSchema = commandLeaseSchema.extend({
  error: z.string().min(1).max(2_000),
  rollbackSucceeded: z.boolean().default(true)
});
const migrationContextProgressSchema = commandLeaseSchema.extend({
  chatContextId: z.string().uuid(),
  targetThreadId: z.string().min(1).max(256),
  migrationSummary: z.string().min(1).max(12_000)
});
const managerOnlineMs = 45_000;
const leaseMs = 60_000;

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function parameters(command: AdminDeviceCommand): Record<string, unknown> {
  if (command.type === "logs") return { lines: command.lines };
  if (command.type === "switch_profile") return { targetProfile: command.targetProfile };
  return {};
}

function publicCommand(row: {
  id: string; executor_id: string; command_type: string; parameters: unknown; state: string; result: unknown;
  last_error: string | null; requested_at: Date | string; started_at: Date | string | null;
  completed_at: Date | string | null; expires_at: Date | string; updated_at: Date | string;
}) {
  return {
    id: row.id,
    executorId: row.executor_id,
    type: row.command_type,
    parameters: row.parameters,
    state: row.state,
    result: row.result,
    error: row.last_error,
    requestedAt: iso(row.requested_at),
    startedAt: iso(row.started_at),
    completedAt: iso(row.completed_at),
    expiresAt: iso(row.expires_at),
    updatedAt: iso(row.updated_at)
  };
}

async function requireManager(db: Kysely<Database>, request: FastifyRequest, executorId: string): Promise<void> {
  await verifyDeviceCredential(db, executorId, readDeviceBearer(request));
  await db.updateTable("workers").set({ manager_last_seen_at: new Date(), updated_at: new Date() })
    .where("executor_id", "=", executorId).where("deleted_at", "is", null).execute();
}

function visibleText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(visibleText).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  for (const key of ["text", "content", "reply", "output", "result", "prompt"]) {
    const found = visibleText(record[key]);
    if (found) return found;
  }
  return "";
}

export function redactMigrationText(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk|pat|xox[baprs]|ghp|glpat)-[A-Za-z0-9_\-]{12,}\b/gu, "[REDACTED TOKEN]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/giu, "$1[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
}

function takeCharacters(value: string, max: number): string {
  const characters = [...value];
  return characters.length <= max ? value : `${characters.slice(0, max - 1).join("")}…`;
}

async function migrationSummary(trx: Transaction<Database>, snapshotJobId: string, sourceThreadId: string): Promise<string> {
  const [turns, items] = await Promise.all([
    trx.selectFrom("chat_thread_snapshot_turns").select(["turn_index", "summary", "status"])
      .where("job_id", "=", snapshotJobId).orderBy("turn_index").execute(),
    trx.selectFrom("chat_thread_snapshot_items").select(["item_type", "raw_item", "ordinal"])
      .where("job_id", "=", snapshotJobId)
      .where("item_type", "in", ["userMessage", "agentMessage", "collabAgentToolCall"])
      .orderBy("ordinal").execute()
  ]);
  const turnOutline = turns.map((turn) => `- ${turn.turn_index + 1}. ${turn.summary ?? `回合状态：${turn.status}`}`);
  const visible = items.flatMap((item) => {
    const raw = item.raw_item && typeof item.raw_item === "object" ? item.raw_item as Record<string, unknown> : {};
    let text = visibleText(raw);
    if (item.item_type === "agentMessage") {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        text = visibleText(parsed.reply ?? parsed.output ?? parsed.text) || text;
      } catch { /* plain text */ }
    }
    text = redactMigrationText(text);
    if (!text) return [];
    const speaker = item.item_type === "userMessage" ? "用户" : item.item_type === "agentMessage" ? "Agent" : "协作 Agent";
    return [`- ${speaker}：${takeCharacters(text, 1_200)}`];
  });
  const recent = visible.slice(-24);
  const summary = [
    "# Profile 迁移上下文",
    `来源 Thread：${sourceThreadId}`,
    `生成时间：${new Date().toISOString()}`,
    "",
    "## 使用说明",
    "这是旧 Profile 会话的结构化迁移摘要。延续其中已确认的目标、约束、决定和未完成事项；若与新消息冲突，以新消息为准。",
    "",
    "## 历史回合索引",
    ...(turnOutline.length ? turnOutline : ["- 没有可用的回合摘要"]),
    "",
    "## 最近可见对话与执行结论",
    ...(recent.length ? recent : ["- 没有可用的可见消息"])
  ].join("\n");
  if ([...summary].length <= 12_000) return summary;
  const fixed = summary.slice(0, summary.indexOf("## 最近可见对话与执行结论"));
  const budget = Math.max(1_000, 12_000 - [...fixed].length - 80);
  return `${fixed}## 最近可见对话与执行结论\n${takeCharacters(recent.join("\n"), budget)}`;
}

async function lockedCommand(
  trx: Transaction<Database>, executorId: string, commandId: string, leaseToken: string
) {
  const command = await trx.selectFrom("device_commands").selectAll()
    .where("id", "=", commandId).where("executor_id", "=", executorId).forUpdate().executeTakeFirst();
  if (!command || command.state !== "running" || command.lease_token_hash !== sha256(leaseToken)
    || !command.lease_expires_at || new Date(command.lease_expires_at).getTime() <= Date.now()) {
    throw new AppError("设备指令租约无效或已过期", 409, "invalid_device_command_lease");
  }
  return command;
}

async function expireStaleRunningCommands(
  trx: Transaction<Database>, executorId: string, now: Date
): Promise<string[]> {
  const stale = await trx.selectFrom("device_commands").select(["id", "command_type"])
    .where("executor_id", "=", executorId).where("state", "=", "running")
    .where("lease_expires_at", "<=", now).forUpdate().execute();
  if (!stale.length) return [];
  const ids = stale.map((command) => command.id);
  await trx.updateTable("device_commands").set({
    state: "expired",
    lease_token_hash: null,
    lease_expires_at: null,
    completed_at: now,
    updated_at: now,
    last_error: "设备指令租约已过期；为避免并发操作，执行器保持当前维护状态"
  }).where("id", "in", ids).where("state", "=", "running").execute();
  const profileIds = stale.filter((command) => command.command_type === "switch_profile").map((command) => command.id);
  if (profileIds.length) {
    await trx.updateTable("profile_switch_migrations").set({
      state: "failed",
      last_error: "设备指令租约已过期；需要根据已记录的新旧 Thread 映射检查设备并人工恢复",
      completed_at: now,
      updated_at: now
    }).where("command_id", "in", profileIds).where("state", "not in", ["succeeded", "rolled_back"]).execute();
  }
  return ids;
}

export function registerDeviceCommandRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  events: AdminEventBus
): void {
  app.get<{ Params: { id: string } }>("/v1/admin/workers/:id/profiles", async (request) => {
    await requireAdmin(db, config, request);
    const worker = await db.selectFrom("workers").select([
      "executor_id", "codex_profile", "available_profiles", "manager_version", "manager_last_seen_at"
    ]).where("executor_id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!worker) throw new AppError("执行器不存在", 404, "not_found");
    const managerOnline = Boolean(worker.manager_last_seen_at && Date.now() - new Date(worker.manager_last_seen_at).getTime() <= managerOnlineMs);
    const bound = await db.selectFrom("chat_contexts").select(sql<number>`count(*)::int`.as("count"))
      .where("executor_id", "=", worker.executor_id).where("codex_thread_id", "is not", null).executeTakeFirstOrThrow();
    return {
      activeProfile: worker.codex_profile,
      profiles: Array.isArray(worker.available_profiles) ? worker.available_profiles : [],
      managerVersion: worker.manager_version,
      managerOnline,
      managerLastSeenAt: iso(worker.manager_last_seen_at),
      boundContextCount: bound.count
    };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/workers/:id/device-commands", async (request) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const body = adminDeviceCommandSchema.parse(request.body);
    const now = new Date();
    const created = await db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, request.params.id);
      const worker = await trx.selectFrom("workers").selectAll()
        .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      if (!worker) throw new AppError("执行器不存在", 404, "not_found");
      if (!worker.manager_last_seen_at || now.getTime() - new Date(worker.manager_last_seen_at).getTime() > managerOnlineMs) {
        throw new AppError("设备管理进程离线，请先升级或检查设备", 409, "device_manager_offline");
      }
      const existing = await trx.selectFrom("device_commands").select("id")
        .where("executor_id", "=", worker.executor_id).where("state", "in", ["queued", "running"]).executeTakeFirst();
      if (existing) throw new AppError("该设备已有管理指令正在执行", 409, "device_command_active");
      if (body.type === "switch_profile") {
        if (body.targetProfile === worker.codex_profile) throw new AppError("目标 Profile 已经生效", 409, "profile_already_active");
        const profiles = Array.isArray(worker.available_profiles) ? worker.available_profiles as Array<Record<string, unknown>> : [];
        if (!profiles.some((profile) => profile.name === body.targetProfile)) {
          throw new AppError("目标 Profile 不存在或尚未由设备上报", 409, "profile_unavailable");
        }
      }
      const drains = ["stop", "restart", "switch_profile"].includes(body.type);
      const command = await trx.insertInto("device_commands").values({
        executor_id: worker.executor_id,
        command_type: body.type,
        parameters: json(parameters(body)),
        requested_by: principal.openId,
        previous_operational_mode: drains ? worker.operational_mode : null,
        state: "queued",
        lease_token_hash: null,
        lease_expires_at: null,
        result: null,
        last_error: null,
        started_at: null,
        completed_at: null,
        expires_at: new Date(now.getTime() + 15 * 60_000),
        updated_at: now
      }).returningAll().executeTakeFirstOrThrow();
      if (drains) {
        await trx.updateTable("workers").set({ operational_mode: "maintenance", updated_at: now })
          .where("executor_id", "=", worker.executor_id).execute();
      }
      if (body.type === "switch_profile") {
        await trx.insertInto("profile_switch_migrations").values({
          command_id: command.id,
          executor_id: worker.executor_id,
          source_profile: worker.codex_profile,
          source_config_fingerprint: worker.config_fingerprint,
          target_profile: body.targetProfile,
          target_config_fingerprint: null,
          state: "preparing",
          context_count: 0,
          last_error: null,
          completed_at: null,
          updated_at: now
        }).execute();
      }
      return command;
    });
    events.publish("worker", request.params.id);
    return publicCommand(created);
  });

  app.get<{ Params: { id: string; commandId: string } }>("/v1/admin/workers/:id/device-commands/:commandId", async (request) => {
    await requireAdmin(db, config, request);
    await db.transaction().execute((trx) => expireStaleRunningCommands(trx, request.params.id, new Date()));
    const command = await db.selectFrom("device_commands").selectAll()
      .where("id", "=", request.params.commandId).where("executor_id", "=", request.params.id).executeTakeFirst();
    if (!command) throw new AppError("设备指令不存在", 404, "not_found");
    const migration = command.command_type === "switch_profile"
      ? await db.selectFrom("profile_switch_migrations").select(["id", "state", "context_count", "last_error"])
        .where("command_id", "=", command.id).executeTakeFirst()
      : null;
    return { ...publicCommand(command), migration };
  });

  app.put<{ Params: { id: string } }>("/v1/runner/device-manager/:id/heartbeat", async (request) => {
    await requireManager(db, request, request.params.id);
    const body = deviceManagerHeartbeatSchema.parse(request.body);
    const updated = await db.updateTable("workers").set({
      manager_version: body.version,
      manager_last_seen_at: new Date(),
      available_profiles: json(body.profiles),
      updated_at: new Date()
    }).where("executor_id", "=", request.params.id).where("deleted_at", "is", null).returning("executor_id").executeTakeFirst();
    if (!updated) throw new AppError("执行器不存在", 404, "not_found");
    events.publish("worker", request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/runner/device-manager/:id/commands/claim", async (request, reply) => {
    await requireManager(db, request, request.params.id);
    const now = new Date();
    const leaseToken = randomToken(48);
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const command = await db.transaction().execute(async (trx) => {
      await expireStaleRunningCommands(trx, request.params.id, now);
      await trx.updateTable("device_commands").set({ state: "expired", completed_at: now, updated_at: now, last_error: "设备管理进程未在有效期内领取指令" })
        .where("executor_id", "=", request.params.id).where("state", "=", "queued").where("expires_at", "<=", now).execute();
      const result = await sql<{ id: string }>`
        WITH candidate AS (
          SELECT id FROM device_commands
          WHERE executor_id = ${request.params.id} AND state = 'queued' AND expires_at > ${now}
          ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1
        )
        UPDATE device_commands command
        SET state = 'running', lease_token_hash = ${sha256(leaseToken)}, lease_expires_at = ${leaseExpiresAt},
            attempt = attempt + 1, started_at = COALESCE(started_at, ${now}), updated_at = ${now}
        FROM candidate WHERE command.id = candidate.id RETURNING command.id
      `.execute(trx);
      const id = result.rows[0]?.id;
      return id ? trx.selectFrom("device_commands").selectAll().where("id", "=", id).executeTakeFirstOrThrow() : null;
    });
    if (!command) return reply.status(204).send();
    const migration = command.command_type === "switch_profile"
      ? await db.selectFrom("profile_switch_migrations").select("id").where("command_id", "=", command.id).executeTakeFirstOrThrow()
      : null;
    events.publish("worker", request.params.id);
    return {
      id: command.id,
      type: command.command_type,
      parameters: command.parameters,
      leaseToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      migrationId: migration?.id ?? null
    };
  });

  app.post<{ Params: { id: string; commandId: string } }>("/v1/runner/device-manager/:id/commands/:commandId/heartbeat", async (request) => {
    await requireManager(db, request, request.params.id);
    const body = commandLeaseSchema.parse(request.body);
    const leaseExpiresAt = new Date(Date.now() + leaseMs);
    const updated = await db.updateTable("device_commands").set({ lease_expires_at: leaseExpiresAt, updated_at: new Date() })
      .where("id", "=", request.params.commandId).where("executor_id", "=", request.params.id)
      .where("state", "=", "running").where("lease_token_hash", "=", sha256(body.leaseToken))
      .where("lease_expires_at", ">", new Date()).returning("id").executeTakeFirst();
    if (!updated) throw new AppError("设备指令租约无效或已过期", 409, "invalid_device_command_lease");
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  });

  app.post<{ Params: { id: string; commandId: string } }>("/v1/runner/device-manager/:id/commands/:commandId/profile-prepare", async (request) => {
    await requireManager(db, request, request.params.id);
    const body = commandLeaseSchema.parse(request.body);
    const response = await db.transaction().execute(async (trx) => {
      const command = await lockedCommand(trx, request.params.id, request.params.commandId, body.leaseToken);
      if (command.command_type !== "switch_profile") throw new AppError("该指令不是 Profile 切换", 409, "invalid_device_command");
      const migration = await trx.selectFrom("profile_switch_migrations").selectAll()
        .where("command_id", "=", command.id).forUpdate().executeTakeFirstOrThrow();
      let contexts = await trx.selectFrom("profile_switch_contexts").selectAll().where("migration_id", "=", migration.id).execute();
      if (!contexts.length && migration.context_count === 0) {
        const bound = await trx.selectFrom("chat_contexts")
          .innerJoin("bots", "bots.id", "chat_contexts.bot_id")
          .select([
            "chat_contexts.id", "chat_contexts.codex_thread_id", "chat_contexts.workspace_root_alias",
            "bots.app_id as bot_app_id"
          ])
          .where("chat_contexts.executor_id", "=", request.params.id)
          .where("chat_contexts.executor_profile", "=", migration.source_profile)
          .where("chat_contexts.executor_config_fingerprint", "=", migration.source_config_fingerprint)
          .where("chat_contexts.codex_thread_id", "is not", null).execute();
        await trx.updateTable("profile_switch_migrations").set({ context_count: bound.length, updated_at: new Date() })
          .where("id", "=", migration.id).execute();
        for (const context of bound) {
          const active = await trx.selectFrom("chat_thread_snapshot_jobs").select(["id", "state"])
            .where("chat_context_id", "=", context.id).where("state", "in", ["queued", "running"]).executeTakeFirst();
          const snapshot = active ?? await trx.insertInto("chat_thread_snapshot_jobs").values({
            chat_context_id: context.id,
            executor_id: request.params.id,
            codex_thread_id: context.codex_thread_id as string,
            requested_by: `profile-switch:${migration.id}`,
            state: "queued",
            lease_token_hash: null,
            lease_expires_at: null,
            protocol_source: null,
            thread_metadata: null,
            last_error: null,
            started_at: null,
            completed_at: null,
            updated_at: new Date()
          }).returning(["id", "state"]).executeTakeFirstOrThrow();
          await trx.insertInto("profile_switch_contexts").values({
            migration_id: migration.id,
            chat_context_id: context.id,
            bot_app_id: context.bot_app_id,
            workspace_root_alias: context.workspace_root_alias,
            source_thread_id: context.codex_thread_id as string,
            target_thread_id: null,
            snapshot_job_id: snapshot.id,
            migration_summary: null,
            summary_sha256: null,
            state: "snapshotting",
            last_error: null,
            updated_at: new Date()
          }).execute();
        }
        contexts = await trx.selectFrom("profile_switch_contexts").selectAll().where("migration_id", "=", migration.id).execute();
      }
      if (!contexts.length) {
        await trx.updateTable("profile_switch_migrations").set({ state: "ready", updated_at: new Date() }).where("id", "=", migration.id).execute();
        return { state: "ready", migrationId: migration.id, contexts: [] };
      }
      const jobs = await trx.selectFrom("chat_thread_snapshot_jobs").select(["id", "state", "last_error"])
        .where("id", "in", contexts.map((context) => context.snapshot_job_id as string)).execute();
      const failed = jobs.find((job) => job.state === "failed" || job.state === "superseded");
      if (failed) throw new AppError(`Profile 迁移快照失败：${failed.last_error ?? failed.state}`, 409, "profile_snapshot_failed");
      if (jobs.some((job) => job.state !== "completed")) return { state: "snapshotting", migrationId: migration.id, contexts: [] };
      for (const context of contexts) {
        if (context.state === "ready" && context.migration_summary) continue;
        const summary = await migrationSummary(trx, context.snapshot_job_id as string, context.source_thread_id);
        await trx.updateTable("profile_switch_contexts").set({
          migration_summary: summary,
          summary_sha256: sha256(summary),
          state: "ready",
          updated_at: new Date()
        }).where("migration_id", "=", migration.id).where("chat_context_id", "=", context.chat_context_id).execute();
      }
      await trx.updateTable("profile_switch_migrations").set({ state: "ready", updated_at: new Date() }).where("id", "=", migration.id).execute();
      const ready = await trx.selectFrom("profile_switch_contexts").select([
        "chat_context_id", "bot_app_id", "workspace_root_alias", "source_thread_id", "migration_summary"
      ]).where("migration_id", "=", migration.id).orderBy("chat_context_id").execute();
      return {
        state: "ready",
        migrationId: migration.id,
        contexts: ready.map((context) => ({
          chatContextId: context.chat_context_id,
          botAppId: context.bot_app_id,
          workspaceRootAlias: context.workspace_root_alias,
          sourceThreadId: context.source_thread_id,
          summary: context.migration_summary as string
        }))
      };
    });
    events.publish("worker", request.params.id);
    return response;
  });

  app.post<{ Params: { id: string; commandId: string } }>("/v1/runner/device-manager/:id/commands/:commandId/profile-context", async (request) => {
    await requireManager(db, request, request.params.id);
    const body = migrationContextProgressSchema.parse(request.body);
    await db.transaction().execute(async (trx) => {
      const command = await lockedCommand(trx, request.params.id, request.params.commandId, body.leaseToken);
      if (command.command_type !== "switch_profile") throw new AppError("该指令不是 Profile 切换", 409, "invalid_device_command");
      const migration = await trx.selectFrom("profile_switch_migrations").select("id")
        .where("command_id", "=", command.id).executeTakeFirstOrThrow();
      const updated = await trx.updateTable("profile_switch_contexts").set({
        target_thread_id: body.targetThreadId,
        migration_summary: body.migrationSummary,
        summary_sha256: sha256(body.migrationSummary),
        updated_at: new Date()
      }).where("migration_id", "=", migration.id).where("chat_context_id", "=", body.chatContextId)
        .where("state", "=", "ready").returning("chat_context_id").executeTakeFirst();
      if (!updated) throw new AppError("Profile 迁移聊天不存在或尚未准备完成", 409, "profile_context_not_ready");
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string; commandId: string } }>("/v1/runner/device-manager/:id/commands/:commandId/complete", async (request) => {
    await requireManager(db, request, request.params.id);
    const raw = commandLeaseSchema.and(deviceCommandResultSchema).parse(request.body);
    const now = new Date();
    const state = await db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, request.params.id);
      const existing = await trx.selectFrom("device_commands").select(["state", "executor_id"])
        .where("id", "=", request.params.commandId).forUpdate().executeTakeFirst();
      if (existing?.executor_id === request.params.id && existing.state === "succeeded") return "succeeded";
      const command = await lockedCommand(trx, request.params.id, request.params.commandId, raw.leaseToken);
      if (command.command_type === "switch_profile") {
        const migration = await trx.selectFrom("profile_switch_migrations").selectAll()
          .where("command_id", "=", command.id).forUpdate().executeTakeFirstOrThrow();
        if (!raw.targetProfile || raw.targetProfile !== migration.target_profile || !raw.targetConfigFingerprint
          || !raw.targetCodexVersion || !raw.targetHomeRef || !raw.targetWorkspaceMappingFingerprint) {
          throw new AppError("Profile 切换结果缺少目标配置身份", 400, "invalid_profile_switch_result");
        }
        const worker = await trx.selectFrom("workers").selectAll().where("executor_id", "=", request.params.id).forUpdate().executeTakeFirstOrThrow();
        if (worker.codex_profile !== raw.targetProfile || worker.config_fingerprint !== raw.targetConfigFingerprint) {
          throw new AppError("目标 Worker 尚未以新 Profile 完成注册", 409, "target_profile_not_online");
        }
        const contexts = await trx.selectFrom("profile_switch_contexts").selectAll().where("migration_id", "=", migration.id).orderBy("chat_context_id").execute();
        const mappings = new Map((raw.contexts ?? []).map((context) => [context.chatContextId, context]));
        if (mappings.size !== contexts.length || contexts.some((context) => !mappings.has(context.chat_context_id))) {
          throw new AppError("Profile 切换没有返回全部聊天的新 Thread", 409, "profile_contexts_incomplete");
        }
        for (const context of contexts) {
          const mapping = mappings.get(context.chat_context_id);
          const targetThreadId = mapping?.targetThreadId as string;
          if (context.target_thread_id && context.target_thread_id !== targetThreadId) {
            throw new AppError("Profile 迁移返回的新 Thread 与已记录进度不一致", 409, "profile_context_thread_mismatch");
          }
          const rebound = await trx.updateTable("chat_contexts").set({
            codex_thread_id: targetThreadId,
            executor_home_ref: raw.targetHomeRef,
            executor_profile: raw.targetProfile,
            executor_config_fingerprint: raw.targetConfigFingerprint,
            executor_workspace_mapping_fingerprint: raw.targetWorkspaceMappingFingerprint,
            codex_version: raw.targetCodexVersion,
            state: "ready",
            blocked_reason: null,
            updated_at: now
          }).where("id", "=", context.chat_context_id)
            .where("codex_thread_id", "=", context.source_thread_id)
            .where("executor_profile", "=", migration.source_profile)
            .where("executor_config_fingerprint", "=", migration.source_config_fingerprint)
            .returning("id").executeTakeFirst();
          if (!rebound) throw new AppError("聊天绑定在迁移期间发生变化，已拒绝部分提交", 409, "profile_context_changed");
          await trx.updateTable("profile_switch_contexts").set({
            target_thread_id: targetThreadId,
            ...(mapping?.migrationSummary ? {
              migration_summary: mapping.migrationSummary,
              summary_sha256: sha256(mapping.migrationSummary)
            } : {}),
            state: "imported",
            updated_at: now
          })
            .where("migration_id", "=", migration.id).where("chat_context_id", "=", context.chat_context_id).execute();
          await trx.updateTable("tasks").set({
            codex_thread_id: targetThreadId,
            executor_home_ref: raw.targetHomeRef,
            executor_profile: raw.targetProfile,
            executor_config_fingerprint: raw.targetConfigFingerprint,
            executor_workspace_mapping_fingerprint: raw.targetWorkspaceMappingFingerprint,
            codex_version: raw.targetCodexVersion,
            updated_at: now
          }).where("conversation_id", "in", trx.selectFrom("conversations").select("id").where("chat_context_id", "=", context.chat_context_id))
            .where("state", "in", ["queued", "waiting_worker"]).execute();
        }
        await trx.updateTable("profile_switch_migrations").set({
          target_config_fingerprint: raw.targetConfigFingerprint,
          state: "succeeded",
          completed_at: now,
          updated_at: now
        }).where("id", "=", migration.id).execute();
      }
      const restoreMode = command.command_type === "stop" ? "maintenance" : command.previous_operational_mode;
      if (restoreMode) await trx.updateTable("workers").set({ operational_mode: restoreMode, updated_at: now }).where("executor_id", "=", request.params.id).execute();
      await trx.updateTable("device_commands").set({
        state: "succeeded",
        result: json(raw.result),
        last_error: null,
        lease_token_hash: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now
      }).where("id", "=", command.id).execute();
      return "succeeded";
    });
    events.publish("worker", request.params.id);
    return { ok: true, state };
  });

  app.post<{ Params: { id: string; commandId: string } }>("/v1/runner/device-manager/:id/commands/:commandId/fail", async (request) => {
    await requireManager(db, request, request.params.id);
    const body = commandFailureSchema.parse(request.body);
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, request.params.id);
      const command = await lockedCommand(trx, request.params.id, request.params.commandId, body.leaseToken);
      if (command.command_type === "switch_profile") {
        await trx.updateTable("profile_switch_migrations").set({
          state: body.rollbackSucceeded ? "rolled_back" : "failed",
          last_error: body.error,
          completed_at: now,
          updated_at: now
        }).where("command_id", "=", command.id).execute();
      }
      if (body.rollbackSucceeded && command.previous_operational_mode) {
        await trx.updateTable("workers").set({ operational_mode: command.previous_operational_mode, updated_at: now })
          .where("executor_id", "=", request.params.id).execute();
      }
      await trx.updateTable("device_commands").set({
        state: "failed",
        last_error: body.error,
        lease_token_hash: null,
        lease_expires_at: null,
        completed_at: now,
        updated_at: now
      }).where("id", "=", command.id).execute();
    });
    events.publish("worker", request.params.id);
    return { ok: true, state: "failed" };
  });
}
