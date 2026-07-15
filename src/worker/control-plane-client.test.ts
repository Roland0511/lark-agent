import { lstat, mkdtemp, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedTask, Signal } from "../shared/contracts.js";
import type { ResolvedWorkerConfig } from "./config.js";
import { AttachmentDownloadError, ControlPlaneClient } from "./control-plane-client.js";

const config = {
  controlPlaneUrl: "https://agent.example.test",
  deviceToken: "device-token",
  executorId: "worker-a",
  displayName: "Worker A",
  homeRef: "worker-a:home",
  codexProfile: "lark-agent",
  configFingerprint: "a".repeat(64),
  workspaceMappingFingerprint: "c".repeat(64),
  codexVersion: "test",
  capacity: 1,
  workspaceRoots: [{ alias: "repo", path: "/tmp" }],
  capabilities: ["codex"],
  runnerVersion: "0.2.5",
  architecture: "arm64"
} as ResolvedWorkerConfig;

const task = { id: "11111111-1111-4111-8111-111111111111", leaseToken: "lease-token" } as ClaimedTask;
const signal = { id: "22222222-2222-4222-8222-222222222222" } as Signal;

function sessionResponse(): Response {
  return Response.json({ sessionToken: "session-token", expiresAt: new Date(Date.now() + 60_000).toISOString() });
}

afterEach(() => vi.unstubAllGlobals());

describe("ControlPlaneClient registration", () => {
  it("reports the independent workspace mapping fingerprint when creating a session", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(sessionResponse());
    vi.stubGlobal("fetch", fetchMock);

    await new ControlPlaneClient(config).createSession();

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      configFingerprint: config.configFingerprint,
      workspaceMappingFingerprint: config.workspaceMappingFingerprint,
      capabilities: config.capabilities
    });
  });
});

describe("ControlPlaneClient attachment download", () => {
  it("atomically writes a bounded response with file mode 0600", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-agent-client-download-"));
    const target = join(directory, "proof.txt");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(new Response("proof", { headers: { "content-length": "5" } })));
    const downloaded = await new ControlPlaneClient(config).downloadAttachment(task, signal, "33333333-3333-4333-8333-333333333333", target, 5);
    expect(downloaded).toEqual({ path: target, size: 5 });
    expect(await readFile(target, "utf8")).toBe("proof");
    expect((await lstat(target)).mode & 0o777).toBe(0o600);
  });

  it("removes partial files when a streamed response exceeds the remaining task limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-agent-client-limit-"));
    const target = join(directory, "too-large.txt");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(new Response("123456")));
    await expect(new ControlPlaneClient(config).downloadAttachment(task, signal, "44444444-4444-4444-8444-444444444444", target, 5))
      .rejects.toMatchObject<Partial<AttachmentDownloadError>>({ reason: "task_limit" });
    expect(await readdir(directory)).toEqual([]);
  });

  it("preserves a safe extension inferred by the control plane for localImage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-agent-client-image-extension-"));
    const target = join(directory, "image");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(new Response("jpeg", { headers: { "content-length": "4", "content-disposition": "attachment; filename=\"attachment\"; filename*=UTF-8''image.JPG" } })));
    const downloaded = await new ControlPlaneClient(config).downloadAttachment(task, signal, "66666666-6666-4666-8666-666666666666", target, 10);
    expect(downloaded).toEqual({ path: `${target}.jpg`, size: 4 });
    expect(await readFile(downloaded.path, "utf8")).toBe("jpeg");
  });

  it("classifies a control-plane 413 as the per-file limit", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lark-agent-client-file-limit-"));
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json({ error: { code: "attachment_too_large" } }, { status: 413 })));
    await expect(new ControlPlaneClient(config).downloadAttachment(task, signal, "55555555-5555-4555-8555-555555555555", join(directory, "too-large.txt"), 100))
      .rejects.toMatchObject<Partial<AttachmentDownloadError>>({ reason: "file_limit" });
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("ControlPlaneClient workspace runtime sync protocol", () => {
  it.each([404, 405])("keeps claiming ordinary tasks when an older control plane returns %s for runtime sync", async (status) => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ControlPlaneClient(config);

    await expect(client.claimWorkspaceRuntimeSync()).resolves.toBeNull();
    await expect(client.claim()).resolves.toBeNull();
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://agent.example.test/v1/tasks/claim");
  });

  it("uses the dedicated sync lease and returns the desired fingerprint on completion", async () => {
    const job = {
      id: "77777777-7777-4777-8777-777777777777",
      botAppId: "cli_test",
      chatContextId: "88888888-8888-4888-8888-888888888888",
      workspaceKey: "88888888-8888-4888-8888-888888888888",
      resolvedWorkspaceAlias: "repo",
      leaseToken: "sync-lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      desiredFingerprint: "d".repeat(64),
      skills: [],
      skillSetFingerprint: "0".repeat(64),
      runtimeConfig: { fingerprint: "0".repeat(64), files: [] }
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json(job))
      .mockResolvedValueOnce(Response.json({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new ControlPlaneClient(config);
    const claimed = await client.claimWorkspaceRuntimeSync();
    expect(claimed).toMatchObject({ id: job.id, desiredFingerprint: job.desiredFingerprint });
    await expect(client.heartbeatWorkspaceRuntimeSync(claimed!)).resolves.toHaveProperty("leaseExpiresAt");
    await client.completeWorkspaceRuntimeSync(claimed!, {
      status: "applied",
      summary: "synced",
      desiredFingerprint: job.desiredFingerprint,
      skillSetFingerprint: job.skillSetFingerprint,
      runtimeConfigFingerprint: job.runtimeConfig.fingerprint,
      files: []
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://agent.example.test/v1/workers/runtime-sync-jobs/claim");
    const heartbeatRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[2]?.[0]).toBe(`https://agent.example.test/v1/workers/runtime-sync-jobs/${job.id}/heartbeat`);
    expect(new Headers(heartbeatRequest.headers).get("x-sync-lease-token")).toBe("sync-lease");
    const resultRequest = fetchMock.mock.calls[3]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[3]?.[0]).toBe(`https://agent.example.test/v1/workers/runtime-sync-jobs/${job.id}/result`);
    expect(new Headers(resultRequest.headers).get("x-sync-lease-token")).toBe("sync-lease");
    expect(JSON.parse(String(resultRequest.body))).toMatchObject({ desiredFingerprint: job.desiredFingerprint });
  });
});

describe("ControlPlaneClient task runtime reporting", () => {
  it("reports a fail-closed runtime error under the task lease", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await new ControlPlaneClient(config).reportRuntimeFailure(task, {
      skillSetFingerprint: "a".repeat(64),
      runtimeConfigFingerprint: "b".repeat(64),
      code: "runtime_file_drift",
      summary: "配置文件与工作区现状冲突",
      targetPath: ".env"
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`https://agent.example.test/v1/tasks/${task.id}/runtime-snapshot/failure`);
    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(request.headers).get("x-lease-token")).toBe("lease-token");
    expect(JSON.parse(String(request.body))).toMatchObject({ code: "runtime_file_drift", targetPath: ".env" });
  });
});
