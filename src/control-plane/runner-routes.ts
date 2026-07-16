import type { FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { runnerEnrollmentSchema } from "../shared/contracts.js";
import { AppError } from "../shared/errors.js";
import type { ControlPlaneConfig } from "./config.js";
import { requireAdmin, requireCsrf } from "./admin-auth.js";
import type { AdminEventBus } from "./admin-events.js";
import { executorActiveTaskStates, lockExecutorClaim } from "./executor-claim-lock.js";
import { upsertWorkerRegistration } from "./repository.js";

const artifactPathSchema = z.string().min(1).refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "artifact path must be relative");

const manifestSchema = z.object({
  version: z.string().min(1),
  publishedAt: z.string().datetime(),
  worker: z.object({ path: artifactPathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  manager: z.object({ path: artifactPathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  node: z.object({
    arm64: z.object({ path: artifactPathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
    x64: z.object({ path: artifactPathSchema, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  })
});

type RunnerManifest = z.infer<typeof manifestSchema>;

export class RunnerReleaseService {
  private cached: { manifest: RunnerManifest; fetchedAt: number } | null = null;
  private lastError: string | null = null;

  constructor(private readonly config: ControlPlaneConfig) {}

  installUrl(): string {
    return `${this.config.runnerArtifactPublicBaseUrl}/runner/install.sh`;
  }

  manifestUrl(): string {
    return `${this.config.runnerArtifactPublicBaseUrl}/runner/manifest.json`;
  }

  async current(force = false): Promise<{ manifest: RunnerManifest | null; source: "fresh" | "cache" | "unavailable"; error: string | null }> {
    const maxAge = this.config.runnerManifestRefreshSeconds * 1_000;
    if (!force && this.cached && Date.now() - this.cached.fetchedAt < maxAge) {
      return { manifest: this.cached.manifest, source: "cache", error: this.lastError };
    }
    try {
      const response = await fetch(this.manifestUrl(), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error(`CDN manifest returned ${response.status}`);
      const manifest = manifestSchema.parse(await response.json());
      this.cached = { manifest, fetchedAt: Date.now() };
      this.lastError = null;
      return { manifest, source: "fresh", error: null };
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.cached
        ? { manifest: this.cached.manifest, source: "cache", error: this.lastError }
        : { manifest: null, source: "unavailable", error: this.lastError };
    }
  }
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function registrationCommand(config: ControlPlaneConfig, releases: RunnerReleaseService, token: string): string {
  return `curl -fsSL '${releases.installUrl()}' | /bin/zsh -s -- --artifact-base '${config.runnerArtifactPublicBaseUrl}' --server '${config.adminOrigin}' --token '${token}'`;
}

function deviceCredentialHash(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) throw new AppError("missing device credential", 401, "unauthorized");
  return sha256(authorization.slice(7));
}

async function requireDeviceCredential(db: Kysely<Database>, executorId: string, authorization: string | undefined): Promise<string> {
  const credentialHash = deviceCredentialHash(authorization);
  const credential = await db.selectFrom("worker_device_credentials").select("id")
    .where("executor_id", "=", executorId).where("credential_hash", "=", credentialHash)
    .where("revoked_at", "is", null).executeTakeFirst();
  if (!credential) throw new AppError("invalid device credential", 401, "unauthorized");
  return credentialHash;
}

export function registerRunnerRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  releases: RunnerReleaseService,
  events?: AdminEventBus
): void {
  app.post("/v1/admin/worker-enrollments", async (request, reply) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const release = await releases.current();
    if (!release.manifest) throw new AppError("Runner CDN manifest 当前不可用", 503, "runner_release_unavailable");
    reply.header("cache-control", "no-store");
    const token = randomToken(48);
    const expiresAt = new Date(Date.now() + 10 * 60_000);
    const row = await db.insertInto("worker_enrollment_tokens").values({
      token_hash: sha256(token), expires_at: expiresAt, used_at: null, revoked_at: null, executor_id: null
    }).returning(["id", "created_at"]).executeTakeFirstOrThrow();
    return {
      id: row.id,
      command: registrationCommand(config, releases, token),
      expiresAt: expiresAt.toISOString(),
      createdAt: iso(row.created_at)
    };
  });

  app.get("/v1/admin/worker-enrollments", async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.selectFrom("worker_enrollment_tokens").selectAll().orderBy("created_at", "desc").limit(50).execute();
    return { items: rows.map((row) => ({
      id: row.id,
      executorId: row.executor_id,
      state: row.revoked_at ? "revoked" : row.used_at ? "used" : new Date(row.expires_at).getTime() <= Date.now() ? "expired" : "pending",
      expiresAt: iso(row.expires_at), usedAt: iso(row.used_at), createdAt: iso(row.created_at)
    })) };
  });

  app.delete<{ Params: { id: string } }>("/v1/admin/worker-enrollments/:id", async (request, reply) => {
    const principal = await requireAdmin(db, config, request);
    requireCsrf(request, principal);
    const updated = await db.updateTable("worker_enrollment_tokens").set({ revoked_at: new Date() })
      .where("id", "=", request.params.id).where("used_at", "is", null).where("revoked_at", "is", null)
      .returning("id").executeTakeFirst();
    if (!updated) throw new AppError("注册指令已使用、已撤销或不存在", 409, "invalid_enrollment");
    return reply.status(204).send();
  });

  app.get("/v1/admin/runner-release", async (request) => {
    await requireAdmin(db, config, request);
    const current = await releases.current();
    return {
      publicBaseUrl: config.runnerArtifactPublicBaseUrl,
      installUrl: releases.installUrl(),
      manifestUrl: releases.manifestUrl(),
      recommendedVersion: current.manifest?.version ?? null,
      publishedAt: current.manifest?.publishedAt ?? null,
      source: current.source,
      error: current.error
    };
  });

  app.post("/v1/runner/enroll", async (request) => {
    const body = runnerEnrollmentSchema.parse(request.body);
    const tokenHash = sha256(body.token);
    const credential = randomToken(48);
    const credentialHash = sha256(credential);
    const now = new Date();
    await db.transaction().execute(async (trx) => {
      const enrollment = await trx.selectFrom("worker_enrollment_tokens").selectAll().where("token_hash", "=", tokenHash).forUpdate().executeTakeFirst();
      if (!enrollment || enrollment.used_at || enrollment.revoked_at || new Date(enrollment.expires_at).getTime() <= now.getTime()) {
        throw new AppError("注册指令无效、已使用或已过期", 401, "invalid_enrollment");
      }
      const registration = body.registration;
      await lockExecutorClaim(trx, registration.executorId);
      await upsertWorkerRegistration(trx, registration, { statusOnInsert: "offline", restoreDeleted: true });
      await trx.updateTable("worker_device_credentials").set({ revoked_at: now })
        .where("executor_id", "=", registration.executorId).where("revoked_at", "is", null).execute();
      await trx.insertInto("worker_device_credentials").values({
        executor_id: registration.executorId, credential_hash: credentialHash, last_used_at: null, revoked_at: null
      }).execute();
      const used = await trx.updateTable("worker_enrollment_tokens").set({ used_at: now, executor_id: registration.executorId })
        .where("id", "=", enrollment.id).where("used_at", "is", null).returning("id").executeTakeFirst();
      if (!used) throw new AppError("注册指令已被使用", 409, "enrollment_consumed");
    });
    return { deviceToken: credential, executorId: body.registration.executorId, enrolledAt: now.toISOString() };
  });

  app.get<{ Params: { id: string } }>("/v1/runner/status/:id", async (request) => {
    const header = request.headers.authorization;
    await requireDeviceCredential(db, request.params.id, header);
    const worker = await db.selectFrom("workers").select(["status", "last_seen_at", "runner_version", "operational_mode", "workspace_aliases", "upgrade_drain_token_hash"])
      .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!worker) throw new AppError("执行器不存在", 404, "not_found");
    const now = new Date();
    const [active, activeRuntimeSync, activeThreadSnapshots] = await Promise.all([
      db.selectFrom("tasks").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "in", [...executorActiveTaskStates]).executeTakeFirstOrThrow(),
      db.selectFrom("skill_file_sync_jobs").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "=", "running")
        .where("lease_expires_at", ">", now).executeTakeFirstOrThrow(),
      db.selectFrom("chat_thread_snapshot_jobs").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "=", "running")
        .where("lease_expires_at", ">", now).executeTakeFirstOrThrow()
    ]);
    const age = Date.now() - new Date(worker.last_seen_at).getTime();
    const workspaceAliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
    const presentedDrainToken = request.headers["x-upgrade-drain-token"];
    return {
      executorId: request.params.id,
      online: worker.status === "online" && age <= 45_000,
      lastSeenAt: iso(worker.last_seen_at),
      runnerVersion: worker.runner_version,
      operationalMode: worker.operational_mode,
      activeTasks: active.count,
      activeRuntimeSyncJobs: activeRuntimeSync.count,
      activeThreadSnapshotJobs: activeThreadSnapshots.count,
      upgradeDraining: worker.upgrade_drain_token_hash !== null,
      upgradeDrainOwned: typeof presentedDrainToken === "string" && worker.upgrade_drain_token_hash === sha256(presentedDrainToken),
      workspaceAliases,
      workspaceAliasesText: workspaceAliases.join("、")
    };
  });

  app.post<{ Params: { id: string } }>("/v1/runner/upgrade-drain/:id", async (request) => {
    const credentialHash = await requireDeviceCredential(db, request.params.id, request.headers.authorization);
    const drainToken = randomToken(48);
    const now = new Date();
    const previousMode = await db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, request.params.id);
      const credential = await trx.selectFrom("worker_device_credentials").select("id")
        .where("executor_id", "=", request.params.id).where("credential_hash", "=", credentialHash)
        .where("revoked_at", "is", null).executeTakeFirst();
      if (!credential) throw new AppError("invalid device credential", 401, "unauthorized");
      const worker = await trx.selectFrom("workers")
        .select(["operational_mode", "upgrade_drain_token_hash"])
        .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      if (!worker) throw new AppError("执行器不存在", 404, "not_found");
      if (worker.upgrade_drain_token_hash) throw new AppError("执行器已经处于升级排空状态", 409, "upgrade_drain_active");
      await trx.updateTable("workers").set({
        operational_mode: "maintenance", upgrade_drain_token_hash: sha256(drainToken),
        upgrade_drain_previous_mode: worker.operational_mode, updated_at: now
      }).where("executor_id", "=", request.params.id).execute();
      const active = await trx.selectFrom("tasks").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "in", [...executorActiveTaskStates]).executeTakeFirstOrThrow();
      if (active.count > 0) throw new AppError("执行器仍有活跃任务，不能进入升级排空", 409, "worker_has_active_tasks");
      const activeRuntimeSync = await trx.selectFrom("skill_file_sync_jobs").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "=", "running")
        .where("lease_expires_at", ">", now).executeTakeFirstOrThrow();
      if (activeRuntimeSync.count > 0) throw new AppError("执行器仍有活跃技能同步任务，不能进入升级排空", 409, "worker_has_active_runtime_sync");
      const activeThreadSnapshots = await trx.selectFrom("chat_thread_snapshot_jobs").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", request.params.id).where("state", "=", "running")
        .where("lease_expires_at", ">", now).executeTakeFirstOrThrow();
      if (activeThreadSnapshots.count > 0) {
        throw new AppError("执行器仍有活跃 Thread 快照任务，不能进入升级排空", 409, "worker_has_active_thread_snapshot");
      }
      return worker.operational_mode;
    });
    events?.publish("worker", request.params.id);
    return { drainToken, operationalMode: "maintenance", previousOperationalMode: previousMode };
  });

  app.delete<{ Params: { id: string } }>("/v1/runner/upgrade-drain/:id", async (request) => {
    const credentialHash = await requireDeviceCredential(db, request.params.id, request.headers.authorization);
    const drainToken = request.headers["x-upgrade-drain-token"];
    if (typeof drainToken !== "string" || !drainToken) throw new AppError("missing upgrade drain token", 401, "unauthorized");
    const operationalMode = await db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, request.params.id);
      const credential = await trx.selectFrom("worker_device_credentials").select("id")
        .where("executor_id", "=", request.params.id).where("credential_hash", "=", credentialHash)
        .where("revoked_at", "is", null).executeTakeFirst();
      if (!credential) throw new AppError("invalid device credential", 401, "unauthorized");
      const worker = await trx.selectFrom("workers")
        .select(["operational_mode", "upgrade_drain_token_hash", "upgrade_drain_previous_mode"])
        .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).forUpdate().executeTakeFirst();
      if (!worker) throw new AppError("执行器不存在", 404, "not_found");
      if (!worker.upgrade_drain_token_hash || worker.upgrade_drain_token_hash !== sha256(drainToken) || !worker.upgrade_drain_previous_mode) {
        throw new AppError("升级排空凭据无效或已被管理员处置", 409, "upgrade_drain_invalid");
      }
      const restoredMode = worker.operational_mode === "maintenance" ? worker.upgrade_drain_previous_mode : worker.operational_mode;
      await trx.updateTable("workers").set({
        operational_mode: restoredMode, upgrade_drain_token_hash: null, upgrade_drain_previous_mode: null, updated_at: new Date()
      }).where("executor_id", "=", request.params.id).execute();
      return restoredMode;
    });
    events?.publish("worker", request.params.id);
    return { ok: true, operationalMode };
  });

  app.delete("/v1/runner/credentials/current", async (request, reply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) throw new AppError("missing device credential", 401, "unauthorized");
    const now = new Date();
    const executorId = await db.transaction().execute(async (trx) => {
      const candidate = await trx.selectFrom("worker_device_credentials").select(["id", "executor_id"])
        .where("credential_hash", "=", sha256(header.slice(7))).where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!candidate) throw new AppError("invalid device credential", 401, "unauthorized");
      await lockExecutorClaim(trx, candidate.executor_id);
      const credential = await trx.selectFrom("worker_device_credentials").select(["id", "executor_id"])
        .where("id", "=", candidate.id).where("revoked_at", "is", null).forUpdate().executeTakeFirst();
      if (!credential) throw new AppError("invalid device credential", 401, "unauthorized");
      const active = await trx.selectFrom("tasks").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", credential.executor_id).where("state", "in", [...executorActiveTaskStates]).executeTakeFirstOrThrow();
      if (active.count > 0) throw new AppError("执行器仍有活跃任务，不能卸载", 409, "worker_has_active_tasks");
      const activeRuntimeSync = await trx.selectFrom("skill_file_sync_jobs").select(sql<number>`count(*)::int`.as("count"))
        .where("executor_id", "=", credential.executor_id).where("state", "=", "running")
        .where("lease_expires_at", ">", now).executeTakeFirstOrThrow();
      if (activeRuntimeSync.count > 0) throw new AppError("执行器仍有活跃技能同步任务，不能卸载", 409, "worker_has_active_runtime_sync");
      await trx.updateTable("worker_device_credentials").set({ revoked_at: now }).where("id", "=", credential.id).execute();
      await trx.updateTable("workers").set({
        operational_mode: "disabled", status: "offline", upgrade_drain_token_hash: null, upgrade_drain_previous_mode: null, updated_at: now
      })
        .where("executor_id", "=", credential.executor_id).execute();
      return credential.executor_id;
    });
    events?.publish("worker", executorId);
    return reply.status(204).send();
  });
}
