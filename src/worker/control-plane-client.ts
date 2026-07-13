import {
  attentionResultSchema,
  claimedTaskSchema,
  signalSchema,
  workerSessionResponseSchema,
  type AttentionResult,
  type ClaimedTask,
  type InboxDecision,
  type Signal,
  type WorkerRegistration,
  type WorkerModelCatalogEntry
} from "../shared/contracts.js";
import type { ResolvedWorkerConfig } from "./config.js";

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
    return claimedTaskSchema.parse(await jsonResponse(response));
  }

  async reportModelCatalog(models: WorkerModelCatalogEntry[]): Promise<void> {
    await this.authorizedFetch("/v1/workers/model-catalog", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models })
    }).then(jsonResponse);
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

function leaseHeaders(token: string): Record<string, string> {
  return { "x-lease-token": token };
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`control plane ${response.status}: ${text.slice(0, 2_000)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}
