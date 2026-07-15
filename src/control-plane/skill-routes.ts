import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import { sha256 } from "../shared/crypto.js";
import { taskRuntimeSnapshotSchema, workerUserSkillsReportSchema, workspaceRuntimeSyncResultSchema } from "../shared/contracts.js";
import { AppError } from "../shared/errors.js";
import { workerUserSkillsFingerprint } from "../shared/user-skills.js";
import { requireWorkerSession } from "./auth.js";
import { requireAdmin, requireCsrf, setNoStore } from "./admin-auth.js";
import type { AdminEventBus } from "./admin-events.js";
import type { ControlPlaneConfig } from "./config.js";
import type { ControlPlaneRepository } from "./repository.js";
import { SkillRuntimeService } from "./skill-runtime-service.js";

const bindingSchema = z.object({ coordinate: z.string(), scope: z.enum(["bot", "chat_context"]), chatContextId: z.string().uuid().nullable().optional() }).strict();
const contextQuery = z.object({ chatContextId: z.string().uuid().nullable().optional() });
const environmentPutSchema = z.object({ chatContextId: z.string().uuid().nullable().optional(), value: z.string().max(65_536).optional(), mode: z.enum(["replace", "disabled"]).optional() }).strict();
const removeSchema = z.object({ chatContextId: z.string().uuid().nullable().optional(), restoreInheritance: z.boolean().default(false) }).default({ restoreInheritance: false });
const jsonFileSchema = z.object({ targetPath: z.string(), chatContextId: z.string().uuid().nullable().optional(), contentBase64: z.string().max(1_500_000) }).strict();
const forceSchema = z.object({ chatContextId: z.string().uuid() }).strict();
const runtimeFailureSchema = z.object({
  skillSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/), runtimeConfigFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  code: z.string().min(1).max(128), summary: z.string().min(1).max(2_000), targetPath: z.string().min(1).max(512).nullable().optional()
}).strict();

function leaseToken(request: FastifyRequest): string {
  const value = request.headers["x-lease-token"];
  if (typeof value !== "string" || !value) throw new AppError("missing X-Lease-Token", 401, "missing_lease");
  return value;
}

function syncLeaseToken(request: FastifyRequest): string {
  const value = request.headers["x-sync-lease-token"];
  if (typeof value !== "string" || !value) throw new AppError("missing X-Sync-Lease-Token", 401, "missing_sync_lease");
  return value;
}

async function upload(request: FastifyRequest): Promise<{ targetPath: string; chatContextId: string | null; content: Buffer }> {
  if (request.isMultipart()) {
    let targetPath = ""; let chatContextId: string | null = null; let content: Buffer | null = null;
    try {
      for await (const part of request.parts({ limits: { files: 1, fileSize: 1_048_576, fields: 10 } })) {
        if (part.type === "file") {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of part.file) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 1_048_576) throw new AppError("配置文件超过 1 MiB", 413, "runtime_file_too_large"); chunks.push(bytes); }
          if (part.file.truncated) throw new AppError("配置文件超过 1 MiB", 413, "runtime_file_too_large");
          content = Buffer.concat(chunks, size);
        } else if (part.fieldname === "targetPath") targetPath = String(part.value);
        else if (part.fieldname === "chatContextId") chatContextId = String(part.value) || null;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      if (code.includes("FILE_TOO_LARGE") || code.includes("FILES_LIMIT") || code.includes("PARTS_LIMIT")) throw new AppError("配置文件上传超过安全限制", 413, "runtime_file_too_large");
      throw error;
    }
    if (!targetPath || !content) throw new AppError("上传必须包含 targetPath 和 file", 400, "invalid_runtime_file_upload");
    if (chatContextId && !z.string().uuid().safeParse(chatContextId).success) throw new AppError("Chat Context ID 格式无效", 400, "invalid_chat_context_id");
    return { targetPath, chatContextId, content };
  }
  const body = jsonFileSchema.parse(request.body);
  const content = Buffer.from(body.contentBase64, "base64");
  if (content.toString("base64").replace(/=+$/, "") !== body.contentBase64.replace(/=+$/, "")) throw new AppError("contentBase64 格式无效", 400, "invalid_runtime_file_upload");
  return { targetPath: body.targetPath, chatContextId: body.chatContextId ?? null, content };
}

function publicBinding(binding: { id: string; bot_id: string; chat_context_id: string | null; namespace: string; slug: string; package_id: string }) {
  return { id: binding.id, botId: binding.bot_id, chatContextId: binding.chat_context_id, scope: binding.chat_context_id ? "chat_context" : "bot", coordinate: `@${binding.namespace}/${binding.slug}`, packageId: binding.package_id };
}

export function registerSkillRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  repository: ControlPlaneRepository,
  events: AdminEventBus,
  runtime = new SkillRuntimeService(db, config, events)
): SkillRuntimeService {
  app.get("/v1/admin/skillhub/status", async (request, reply) => {
    await requireAdmin(db, config, request); setNoStore(reply);
    return { ...runtime.hub.status(), encryptionAvailable: runtime.secrets.available };
  });
  app.get<{ Querystring: { q?: string; limit?: string } }>("/v1/admin/skillhub/search", async (request, reply) => {
    await requireAdmin(db, config, request); setNoStore(reply);
    return { items: await runtime.hub.search(String(request.query.q ?? "").slice(0, 256), Number(request.query.limit ?? 20)) };
  });
  app.get<{ Params: { id: string } }>("/v1/admin/bots/:id/skills", async (request, reply) => {
    await requireAdmin(db, config, request); setNoStore(reply);
    return { items: await runtime.listBindings(request.params.id) };
  });
  app.post<{ Params: { id: string } }>("/v1/admin/bots/:id/skills", async (request, reply) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal);
    const body = bindingSchema.parse(request.body); const contextId = body.scope === "chat_context" ? body.chatContextId ?? null : null;
    if (body.scope === "chat_context" && !contextId) throw new AppError("Thread 作用域必须指定聊天记忆", 400, "chat_context_required");
    return reply.code(201).send(publicBinding(await runtime.addBinding(request.params.id, body.coordinate, contextId, principal.openId)));
  });
  app.post<{ Params: { id: string; bindingId: string } }>("/v1/admin/bots/:id/skills/:bindingId/update", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal);
    const result = await runtime.updateBinding(request.params.id, request.params.bindingId, principal.openId);
    return { ...publicBinding(result.binding), updated: result.updated };
  });
  app.delete<{ Params: { id: string; bindingId: string } }>("/v1/admin/bots/:id/skills/:bindingId", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal);
    await runtime.deleteBinding(request.params.id, request.params.bindingId, principal.openId); return { ok: true };
  });
  app.get<{ Params: { id: string; bindingId: string }; Querystring: { chatContextId?: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config", async (request, reply) => {
    await requireAdmin(db, config, request); setNoStore(reply); const query = contextQuery.parse(request.query);
    return runtime.listRuntimeConfig(request.params.id, request.params.bindingId, query.chatContextId ?? null);
  });
  app.put<{ Params: { id: string; bindingId: string; name: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config/env/:name", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal); const body = environmentPutSchema.parse(request.body);
    if (body.mode !== "disabled" && body.value === undefined) throw new AppError("环境变量值不能为空", 400, "runtime_environment_value_required");
    return runtime.putEnvironment(request.params.id, request.params.bindingId, request.params.name, body.chatContextId ?? null, body.mode === "disabled" ? null : body.value ?? "", principal.openId);
  });
  app.delete<{ Params: { id: string; bindingId: string; name: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config/env/:name", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal); const body = removeSchema.parse(request.body);
    return runtime.deleteEnvironment(request.params.id, request.params.bindingId, request.params.name, body.chatContextId ?? null, body.restoreInheritance, principal.openId);
  });
  const filePut = async (request: FastifyRequest<{ Params: { id: string; bindingId: string } }>, reply: import("fastify").FastifyReply, expectedFileId?: string) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal); const body = await upload(request);
    return reply.code(201).send(await runtime.putFile(request.params.id, request.params.bindingId, body.targetPath, body.chatContextId, body.content, principal.openId, expectedFileId));
  };
  app.post<{ Params: { id: string; bindingId: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config/files", filePut);
  app.put<{ Params: { id: string; bindingId: string; fileId: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config/files/:fileId", async (request, reply) => filePut(request, reply, request.params.fileId));
  app.delete<{ Params: { id: string; bindingId: string; fileId: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config/files/:fileId", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal); const body = removeSchema.parse(request.body);
    return runtime.deleteFile(request.params.id, request.params.bindingId, request.params.fileId, body.chatContextId ?? null, body.restoreInheritance, principal.openId);
  });
  app.post<{ Params: { id: string; bindingId: string; fileId: string } }>("/v1/admin/bots/:id/skills/:bindingId/runtime-config/files/:fileId/force-apply", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal); const body = forceSchema.parse(request.body);
    await runtime.forceFile(request.params.id, request.params.bindingId, request.params.fileId, body.chatContextId); return { ok: true };
  });
  app.post<{ Params: { id: string } }>("/v1/admin/chat-contexts/:id/skill-runtime/retry", async (request) => {
    const principal = await requireAdmin(db, config, request, true); requireCsrf(request, principal);
    const queued = await runtime.enqueueLatestForContext(request.params.id, { forceRetry: true, actor: principal.openId });
    if (!queued) throw new AppError("聊天记忆尚未绑定可用执行器和工作区", 409, "chat_context_executor_unavailable");
    return { ok: true, queued: true };
  });
  app.get<{ Params: { id: string } }>("/v1/admin/workers/:id/user-skills", async (request, reply) => {
    await requireAdmin(db, config, request); setNoStore(reply);
    const worker = await db.selectFrom("workers").select(["executor_id", "user_skills", "user_skills_fingerprint", "user_skills_scan_status", "user_skills_truncated", "user_skills_scanned_at", "user_skills_scan_error", "last_seen_at"])
      .where("executor_id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!worker) throw new AppError("执行器不存在", 404, "worker_not_found");
    return { executorId: worker.executor_id, skills: Array.isArray(worker.user_skills) ? worker.user_skills : [], fingerprint: worker.user_skills_fingerprint, status: worker.user_skills_scan_status, truncated: worker.user_skills_truncated, scannedAt: worker.user_skills_scanned_at ? new Date(worker.user_skills_scanned_at).toISOString() : null, error: worker.user_skills_scan_error, scanError: worker.user_skills_scan_error, lastSeenAt: new Date(worker.last_seen_at).toISOString(), readOnly: true };
  });

  app.put("/v1/workers/user-skills", async (request) => {
    const principal = await requireWorkerSession(db, config, request); const body = workerUserSkillsReportSchema.parse(request.body);
    const fingerprint = workerUserSkillsFingerprint(body.skills);
    if (body.fingerprint !== fingerprint) throw new AppError("用户级技能清单指纹无效", 400, "user_skills_fingerprint_mismatch");
    let update = db.updateTable("workers").set({ user_skills: JSON.stringify(body.skills), user_skills_fingerprint: fingerprint, user_skills_scan_status: body.status, user_skills_truncated: body.truncated, user_skills_scanned_at: new Date(body.scannedAt), user_skills_scan_error: body.errors.join("；").slice(0, 2_000) || null, updated_at: new Date() })
      .where("executor_id", "=", principal.executorId).where("deleted_at", "is", null)
      .where("home_ref", "=", principal.homeRef).where("codex_profile", "=", principal.codexProfile)
      .where("config_fingerprint", "=", principal.configFingerprint);
    if (principal.workspaceMappingFingerprint) {
      update = update.where("workspace_mapping_fingerprint", "=", principal.workspaceMappingFingerprint);
    }
    const updated = await update.returning("executor_id").executeTakeFirst();
    if (!updated) throw new AppError("Runner 会话对应的执行环境已变化，请重新建立会话", 409, "stale_worker_session");
    events.publish("worker", principal.executorId); return { ok: true };
  });
  app.get<{ Params: { taskId: string; packageId: string } }>("/v1/tasks/:taskId/skills/:packageId/download", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request); await repository.assertLease(request.params.taskId, principal.executorId, leaseToken(request));
    const task = await db.selectFrom("tasks").select("skill_set_snapshot").where("id", "=", request.params.taskId).executeTakeFirstOrThrow();
    if (!Array.isArray(task.skill_set_snapshot) || !task.skill_set_snapshot.some((item) => item && typeof item === "object" && (item as { packageId?: string }).packageId === request.params.packageId)) throw new AppError("技能包不在任务快照中", 404, "skill_package_not_in_snapshot");
    const pkg = await runtime.hub.verifyCachedPackage(request.params.packageId); const info = await stat(pkg.archive_path);
    reply.header("content-type", "application/zip").header("cache-control", "private, no-store").header("content-length", String(info.size)).header("x-archive-sha256", pkg.archive_sha256);
    return reply.send(createReadStream(pkg.archive_path));
  });
  app.get<{ Params: { taskId: string } }>("/v1/tasks/:taskId/runtime-config/environment", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request); await repository.assertLease(request.params.taskId, principal.executorId, leaseToken(request)); setNoStore(reply);
    const task = await db.selectFrom("tasks").select("runtime_config_fingerprint").where("id", "=", request.params.taskId).executeTakeFirstOrThrow();
    return { fingerprint: task.runtime_config_fingerprint ?? "0".repeat(64), variables: await runtime.taskEnvironment(request.params.taskId) };
  });
  app.get<{ Params: { taskId: string; fileId: string } }>("/v1/tasks/:taskId/runtime-config/files/:fileId/download", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request); await repository.assertLease(request.params.taskId, principal.executorId, leaseToken(request));
    const file = await runtime.taskFile(request.params.taskId, request.params.fileId); reply.header("content-type", "application/octet-stream").header("cache-control", "private, no-store").header("content-length", String(file.size)).header("x-content-sha256", file.sha256).header("x-target-path", encodeURIComponent(file.targetPath)); return reply.send(file.content);
  });
  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/runtime-snapshot", async (request) => {
    const principal = await requireWorkerSession(db, config, request); await repository.assertLease(request.params.taskId, principal.executorId, leaseToken(request)); const body = taskRuntimeSnapshotSchema.parse(request.body);
    await runtime.recordRuntimeSnapshot(request.params.taskId, principal.executorId, body); return { ok: true };
  });
  app.post<{ Params: { taskId: string } }>("/v1/tasks/:taskId/runtime-snapshot/failure", async (request) => {
    const principal = await requireWorkerSession(db, config, request); await repository.assertLease(request.params.taskId, principal.executorId, leaseToken(request));
    await runtime.recordRuntimeFailure(request.params.taskId, principal.executorId, runtimeFailureSchema.parse(request.body)); return { ok: true };
  });
  app.post("/v1/workers/runtime-sync-jobs/claim", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request); const job = await runtime.claimSyncJob(principal, config.leaseSeconds); return job ? reply.send(job) : reply.code(204).send();
  });
  app.post<{ Params: { jobId: string } }>("/v1/workers/runtime-sync-jobs/:jobId/heartbeat", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    return runtime.heartbeatSyncJob(principal.executorId, request.params.jobId, syncLeaseToken(request), config.leaseSeconds);
  });
  app.get<{ Params: { jobId: string; fileId: string } }>("/v1/workers/runtime-sync-jobs/:jobId/files/:fileId/download", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request); const file = await runtime.syncJobFile(principal.executorId, request.params.jobId, syncLeaseToken(request), request.params.fileId);
    reply.header("content-type", "application/octet-stream").header("cache-control", "private, no-store").header("content-length", String(file.size)).header("x-content-sha256", file.sha256).header("x-target-path", encodeURIComponent(file.targetPath)); return reply.send(file.content);
  });
  app.get<{ Params: { jobId: string; packageId: string } }>("/v1/workers/runtime-sync-jobs/:jobId/skills/:packageId/download", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request); const token = syncLeaseToken(request);
    const job = await db.selectFrom("skill_file_sync_jobs").select("leased_payload").where("id", "=", request.params.jobId).where("executor_id", "=", principal.executorId)
      .where("state", "=", "running").where("lease_token_hash", "=", sha256(token)).where("lease_expires_at", ">", new Date()).executeTakeFirst();
    const payload = job?.leased_payload && typeof job.leased_payload === "object" ? job.leased_payload as { skills?: Array<{ packageId?: string }> } : {};
    if (!job || !Array.isArray(payload.skills) || !payload.skills.some((skill) => skill.packageId === request.params.packageId)) throw new AppError("技能包不在同步作业快照中", 404, "skill_package_not_in_snapshot");
    const pkg = await runtime.hub.verifyCachedPackage(request.params.packageId); const info = await stat(pkg.archive_path);
    reply.header("content-type", "application/zip").header("cache-control", "private, no-store").header("content-length", String(info.size)).header("x-archive-sha256", pkg.archive_sha256);
    return reply.send(createReadStream(pkg.archive_path));
  });
  app.post<{ Params: { jobId: string } }>("/v1/workers/runtime-sync-jobs/:jobId/result", async (request) => {
    const principal = await requireWorkerSession(db, config, request); const body = workspaceRuntimeSyncResultSchema.parse(request.body);
    await runtime.finishSyncJob(principal.executorId, request.params.jobId, syncLeaseToken(request), body); return { ok: true };
  });
  return runtime;
}
