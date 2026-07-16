import {
  attentionResultSchema,
  claimedTaskSchema,
  signalSchema,
  taskRuntimeEnvironmentResponseSchema,
  taskRuntimeSnapshotSchema,
  threadSnapshotChunkSchema,
  threadSnapshotCompleteSchema,
  threadSnapshotFailureSchema,
  threadSnapshotJobSchema,
  workerUserSkillsReportSchema,
  workerSessionResponseSchema,
  workspaceRuntimeSyncJobSchema,
  workspaceRuntimeSyncResultSchema,
  type AttentionResult,
  type ClaimedTask,
  type InboxDecision,
  type Signal,
  type TaskRuntimeEnvironmentResponse,
  type TaskRuntimeFile,
  type TaskRuntimeSnapshot,
  type TaskSkillPackage,
  type ThreadSnapshotChunk,
  type ThreadSnapshotComplete,
  type ThreadSnapshotJob,
  type WorkerRegistration,
  type WorkerModelCatalogEntry,
  type WorkerUserSkillsReport,
  type WorkspaceRuntimeSyncJob,
  type WorkspaceRuntimeSyncResult
} from "../shared/contracts.js";
import type { ResolvedWorkerConfig } from "./config.js";
import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export class ControlPlaneClient {
  private sessionToken: string | null = null;

  constructor(private readonly config: ResolvedWorkerConfig) {}

  async createSession(): Promise<void> {
    const registration: WorkerRegistration = {
      executorId: this.config.executorId,
      displayName: this.config.displayName,
      homeRef: this.config.homeRef,
      codexProfile: this.config.codexProfile,
      configFingerprint: this.config.configFingerprint,
      workspaceMappingFingerprint: this.config.workspaceMappingFingerprint,
      codexVersion: this.config.codexVersion,
      capacity: this.config.capacity,
      workspaceAliases: this.config.workspaceRoots.map((root) => root.alias),
      capabilities: this.config.capabilities,
      runnerVersion: this.config.runnerVersion,
      architecture: this.config.architecture,
      registrationSource: "quick_install"
    };
    const response = await fetch(`${this.config.controlPlaneUrl}/v1/worker-sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.config.deviceToken}`, "content-type": "application/json" },
      body: JSON.stringify(registration)
    });
    const data = workerSessionResponseSchema.parse(await jsonResponse(response));
    this.sessionToken = data.sessionToken;
  }

  async claim(): Promise<ClaimedTask | null> {
    const response = await this.authorizedFetch("/v1/tasks/claim", { method: "POST" });
    if (response.status === 204) return null;
    const payload = await jsonResponse(response);
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    return claimedTaskSchema.parse({
      ...record,
      attachmentPolicy: record.attachmentPolicy ?? {
        maxBytes: this.config.attachmentMaxBytes,
        taskMaxBytes: this.config.attachmentTaskMaxBytes,
        retentionDays: this.config.attachmentRetentionDays
      }
    });
  }

  async reportModelCatalog(models: WorkerModelCatalogEntry[]): Promise<void> {
    await this.authorizedFetch("/v1/workers/model-catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models })
    }).then(jsonResponse);
  }

  async reportUserSkills(report: WorkerUserSkillsReport): Promise<void> {
    workerUserSkillsReportSchema.parse(report);
    await this.authorizedFetch("/v1/workers/user-skills", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report)
    }).then(jsonResponse);
  }

  async runtimeEnvironment(task: ClaimedTask): Promise<TaskRuntimeEnvironmentResponse> {
    const response = await this.authorizedFetch(`/v1/tasks/${task.id}/runtime-config/environment`, {
      headers: leaseHeaders(task.leaseToken)
    });
    return taskRuntimeEnvironmentResponseSchema.parse(await jsonResponse(response));
  }

  async reportRuntimeSnapshot(task: ClaimedTask, snapshot: TaskRuntimeSnapshot): Promise<void> {
    taskRuntimeSnapshotSchema.parse(snapshot);
    await this.authorizedFetch(`/v1/tasks/${task.id}/runtime-snapshot`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify(snapshot)
    }).then(jsonResponse);
  }

  async reportRuntimeFailure(task: ClaimedTask, failure: {
    skillSetFingerprint: string;
    runtimeConfigFingerprint: string;
    code: string;
    summary: string;
    targetPath?: string | null;
  }): Promise<void> {
    await this.authorizedFetch(`/v1/tasks/${task.id}/runtime-snapshot/failure`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify(failure)
    }).then(jsonResponse);
  }

  async downloadSkillPackage(task: ClaimedTask, skill: TaskSkillPackage, target: string): Promise<{ path: string; size: number; sha256: string }> {
    const response = await this.authorizedFetch(`/v1/tasks/${task.id}/skills/${skill.packageId}/download`, {
      headers: leaseHeaders(task.leaseToken)
    });
    return downloadBoundedResponse(response, target, 104_857_600, skill.archiveSha256, "skill package");
  }

  async downloadRuntimeFile(task: ClaimedTask, file: TaskRuntimeFile, target: string): Promise<{ path: string; size: number; sha256: string }> {
    const params = new URLSearchParams({ revision: String(file.revision) });
    const response = await this.authorizedFetch(`/v1/tasks/${task.id}/runtime-config/files/${file.id}/download?${params}`, {
      headers: leaseHeaders(task.leaseToken)
    });
    return downloadBoundedResponse(response, target, Math.min(file.size, 1_048_576), file.sha256, "runtime file");
  }

  async claimWorkspaceRuntimeSync(): Promise<WorkspaceRuntimeSyncJob | null> {
    const response = await this.authorizedFetch("/v1/workers/runtime-sync-jobs/claim", { method: "POST" });
    if (response.status === 204) return null;
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return workspaceRuntimeSyncJobSchema.parse(await jsonResponse(response));
  }

  async claimThreadSnapshot(): Promise<ThreadSnapshotJob | null> {
    const response = await this.authorizedFetch("/v1/workers/thread-snapshot-jobs/claim", { method: "POST" });
    if (response.status === 204) return null;
    if (response.status === 404 || response.status === 405) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
    return threadSnapshotJobSchema.parse(await jsonResponse(response));
  }

  async heartbeatThreadSnapshot(job: ThreadSnapshotJob): Promise<{ leaseExpiresAt: string }> {
    const response = await this.authorizedFetch(`/v1/workers/thread-snapshot-jobs/${job.id}/heartbeat`, {
      method: "POST", headers: snapshotLeaseHeaders(job.leaseToken)
    });
    const body = (await jsonResponse(response)) as { leaseExpiresAt?: unknown };
    if (typeof body.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(body.leaseExpiresAt))) {
      throw new Error("thread snapshot heartbeat response is invalid");
    }
    return { leaseExpiresAt: body.leaseExpiresAt };
  }

  async uploadThreadSnapshotChunk(job: ThreadSnapshotJob, chunk: ThreadSnapshotChunk): Promise<void> {
    threadSnapshotChunkSchema.parse(chunk);
    await this.authorizedFetch(`/v1/workers/thread-snapshot-jobs/${job.id}/chunks`, {
      method: "POST", headers: { ...snapshotLeaseHeaders(job.leaseToken), "content-type": "application/json" },
      body: JSON.stringify(chunk)
    }).then(jsonResponse);
  }

  async completeThreadSnapshot(job: ThreadSnapshotJob, result: ThreadSnapshotComplete): Promise<void> {
    threadSnapshotCompleteSchema.parse(result);
    await this.authorizedFetch(`/v1/workers/thread-snapshot-jobs/${job.id}/complete`, {
      method: "POST", headers: { ...snapshotLeaseHeaders(job.leaseToken), "content-type": "application/json" },
      body: JSON.stringify(result)
    }).then(jsonResponse);
  }

  async failThreadSnapshot(job: ThreadSnapshotJob, summary: string): Promise<void> {
    const body = threadSnapshotFailureSchema.parse({ summary });
    await this.authorizedFetch(`/v1/workers/thread-snapshot-jobs/${job.id}/fail`, {
      method: "POST", headers: { ...snapshotLeaseHeaders(job.leaseToken), "content-type": "application/json" },
      body: JSON.stringify(body)
    }).then(jsonResponse);
  }

  async downloadWorkspaceRuntimeFile(job: WorkspaceRuntimeSyncJob, file: TaskRuntimeFile, target: string): Promise<{ path: string; size: number; sha256: string }> {
    const params = new URLSearchParams({ revision: String(file.revision) });
    const response = await this.authorizedFetch(`/v1/workers/runtime-sync-jobs/${job.id}/files/${file.id}/download?${params}`, {
      headers: syncLeaseHeaders(job.leaseToken)
    });
    return downloadBoundedResponse(response, target, Math.min(file.size, 1_048_576), file.sha256, "runtime file");
  }

  async downloadWorkspaceSkillPackage(job: WorkspaceRuntimeSyncJob, skill: TaskSkillPackage, target: string): Promise<{ path: string; size: number; sha256: string }> {
    const response = await this.authorizedFetch(`/v1/workers/runtime-sync-jobs/${job.id}/skills/${skill.packageId}/download`, {
      headers: syncLeaseHeaders(job.leaseToken)
    });
    return downloadBoundedResponse(response, target, 104_857_600, skill.archiveSha256, "skill package");
  }

  async completeWorkspaceRuntimeSync(job: WorkspaceRuntimeSyncJob, result: WorkspaceRuntimeSyncResult): Promise<void> {
    workspaceRuntimeSyncResultSchema.parse(result);
    await this.authorizedFetch(`/v1/workers/runtime-sync-jobs/${job.id}/result`, {
      method: "POST",
      headers: { ...syncLeaseHeaders(job.leaseToken), "content-type": "application/json" },
      body: JSON.stringify(result)
    }).then(jsonResponse);
  }

  async heartbeatWorkspaceRuntimeSync(job: WorkspaceRuntimeSyncJob): Promise<{ leaseExpiresAt: string }> {
    const response = await this.authorizedFetch(`/v1/workers/runtime-sync-jobs/${job.id}/heartbeat`, {
      method: "POST",
      headers: syncLeaseHeaders(job.leaseToken)
    });
    const body = (await jsonResponse(response)) as { leaseExpiresAt?: unknown };
    if (typeof body.leaseExpiresAt !== "string" || !Number.isFinite(Date.parse(body.leaseExpiresAt))) {
      throw new Error("runtime sync heartbeat response is invalid");
    }
    return { leaseExpiresAt: body.leaseExpiresAt };
  }

  async heartbeat(taskId: string, leaseToken: string): Promise<{ leaseExpiresAt: string; state: string }> {
    const response = await this.authorizedFetch(`/v1/tasks/${taskId}/heartbeat`, { method: "POST", headers: leaseHeaders(leaseToken) });
    return (await jsonResponse(response)) as { leaseExpiresAt: string; state: string };
  }

  async signals(taskId: string, leaseToken: string, afterSeq: number): Promise<Signal[]> {
    const response = await this.authorizedFetch(`/v1/tasks/${taskId}/signals?after_seq=${afterSeq}`, { headers: leaseHeaders(leaseToken) });
    const body = (await jsonResponse(response)) as { signals: unknown[] };
    return body.signals.map((signal) => signalSchema.parse(signal));
  }

  async downloadAttachment(task: ClaimedTask, signal: Signal, attachmentId: string, target: string, maxBytes: number): Promise<{ path: string; size: number }> {
    const response = await this.authorizedFetch(
      `/v1/tasks/${task.id}/signals/${signal.id}/attachments/${attachmentId}`,
      { headers: leaseHeaders(task.leaseToken) }
    );
    if (!response.ok) {
      const text = await response.text();
      throw new AttachmentDownloadError(response.status === 413 ? "file_limit" : "download_failed", `control plane ${response.status}: ${text.slice(0, 500)}`);
    }
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await response.body?.cancel();
      throw new AttachmentDownloadError("task_limit", "attachment would exceed the remaining task limit");
    }
    if (!response.body) throw new AttachmentDownloadError("download_failed", "control plane returned an empty attachment body");
    const finalTarget = targetWithResponseExtension(target, response.headers.get("content-disposition"));
    await mkdir(dirname(finalTarget), { recursive: true, mode: 0o700 });
    const temporary = `${finalTarget}.${randomUUID()}.tmp`;
    let bytes = 0;
    try {
      const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
      const destination = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          callback(bytes > maxBytes ? new AttachmentDownloadError("task_limit", "attachment exceeded the remaining task limit") : null, chunk);
        }
      });
      await pipeline(source, counter, destination);
      await chmod(temporary, 0o600);
      await rename(temporary, finalTarget);
      return { path: finalTarget, size: bytes };
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async decideSignal(taskId: string, signalId: string, leaseToken: string, result: AttentionResult): Promise<void> {
    attentionResultSchema.parse(result);
    await this.authorizedFetch(`/v1/tasks/${taskId}/signals/${signalId}/decision`, {
      method: "POST",
      headers: { ...leaseHeaders(leaseToken), "content-type": "application/json" },
      body: JSON.stringify(result)
    }).then(jsonResponse);
  }

  async event(taskId: string, leaseToken: string, type: string, summary: string, payload: Record<string, unknown> = {}): Promise<void> {
    await this.authorizedFetch(`/v1/tasks/${taskId}/events`, {
      method: "POST",
      headers: { ...leaseHeaders(leaseToken), "content-type": "application/json" },
      body: JSON.stringify({ type, summary, payload })
    }).then(jsonResponse);
  }

  async streamCommentary(task: ClaimedTask, update: { itemId: string; text: string; ordinal: number }, baseRoomSeq: number): Promise<void> {
    await this.authorizedFetch(`/v1/tasks/${task.id}/stream`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify({ ...update, phase: "commentary", baseRoomSeq })
    }).then(jsonResponse);
  }

  async submitDraft(task: ClaimedTask, content: string, baseRoomSeq: number, codexThreadId: string) {
    const response = await this.authorizedFetch(`/v1/tasks/${task.id}/drafts`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify({ content, baseRoomSeq, force: false, codexThreadId })
    });
    return (await jsonResponse(response)) as { held: boolean; sent: boolean; simulated?: boolean };
  }

  async requestApproval(task: ClaimedTask, requestId: string, method: string, summary: string, payload: Record<string, unknown>) {
    const response = await this.authorizedFetch(`/v1/tasks/${task.id}/approvals`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify({ requestId, method, summary, payload })
    });
    return (await jsonResponse(response)) as { id: string; state: "pending" | "approved" | "rejected" | "expired"; expiresAt: string };
  }

  async action(task: ClaimedTask, actionKey: string, actionType: string, requestDigest: string, result: Record<string, unknown>): Promise<void> {
    await this.authorizedFetch(`/v1/tasks/${task.id}/actions`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify({ actionKey, actionType, requestDigest, result })
    }).then(jsonResponse);
  }

  async approval(task: ClaimedTask, approvalId: string) {
    const response = await this.authorizedFetch(`/v1/tasks/${task.id}/approvals/${approvalId}`, { headers: leaseHeaders(task.leaseToken) });
    return (await jsonResponse(response)) as { id: string; state: "pending" | "approved" | "rejected" | "expired" };
  }

  async result(
    task: ClaimedTask,
    status: "completed" | "failed" | "waiting_input" | "human_owned",
    summary: string,
    lifecycle?: { disposition: "complete" | "awaiting_followup" | "unchanged"; processedRoomSeq: number; dispositionReason: string }
  ): Promise<void> {
    await this.authorizedFetch(`/v1/tasks/${task.id}/result`, {
      method: "POST",
      headers: { ...leaseHeaders(task.leaseToken), "content-type": "application/json" },
      body: JSON.stringify({ status, summary, ...(status === "completed" ? lifecycle : {}) })
    }).then(jsonResponse);
  }

  private async authorizedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    if (!this.sessionToken) await this.createSession();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.sessionToken}`);
    let response = await fetch(`${this.config.controlPlaneUrl}${path}`, { ...init, headers });
    if (response.status === 401) {
      await this.createSession();
      headers.set("authorization", `Bearer ${this.sessionToken}`);
      response = await fetch(`${this.config.controlPlaneUrl}${path}`, { ...init, headers });
    }
    return response;
  }
}

function targetWithResponseExtension(target: string, contentDisposition: string | null): string {
  if (extname(target) || !contentDisposition) return target;
  const encoded = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (!encoded) return target;
  let fileName = "";
  try {
    fileName = decodeURIComponent(encoded);
  } catch {
    return target;
  }
  const extension = extname(fileName);
  return /^\.[A-Za-z0-9]{1,10}$/.test(extension) ? `${target}${extension.toLowerCase()}` : target;
}

export class AttachmentDownloadError extends Error {
  constructor(readonly reason: "file_limit" | "task_limit" | "download_failed", message: string) {
    super(message);
  }
}

function leaseHeaders(token: string): Record<string, string> {
  return { "x-lease-token": token };
}

function syncLeaseHeaders(token: string): Record<string, string> {
  return { "x-sync-lease-token": token };
}

function snapshotLeaseHeaders(token: string): Record<string, string> {
  return { "x-snapshot-lease-token": token };
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`control plane ${response.status}: ${text.slice(0, 2_000)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function downloadBoundedResponse(
  response: Response,
  target: string,
  maxBytes: number,
  expectedSha256: string,
  label: string
): Promise<{ path: string; size: number; sha256: string }> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`${label} download failed with status ${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error(`${label} exceeds the configured size limit`);
  }
  if (!response.body) throw new Error(`${label} response has no body`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  let bytes = 0;
  const digest = createHash("sha256");
  try {
    const source = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>);
    const destination = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > maxBytes) return callback(new Error(`${label} exceeds the configured size limit`));
        digest.update(chunk);
        callback(null, chunk);
      }
    });
    await pipeline(source, counter, destination);
    const actualSha256 = digest.digest("hex");
    if (actualSha256 !== expectedSha256) throw new Error(`${label} digest mismatch`);
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    return { path: target, size: bytes, sha256: actualSha256 };
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
