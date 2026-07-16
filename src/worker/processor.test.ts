import { chmod, mkdir, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { parse as parseToml } from "smol-toml";
import { threadSnapshotChunkSchema, type ClaimedTask, type Signal, type ThreadSnapshotJob, type WorkspaceRuntimeSyncJob } from "../shared/contracts.js";
import type { ResolvedWorkerConfig } from "./config.js";
import { AttachmentDownloadError, type ControlPlaneClient } from "./control-plane-client.js";
import {
  buildTaskPrompt,
  buildThreadSnapshotChunks,
  buildThreadSummaryBatchPlan,
  buildThreadSummaryBatches,
  codexCompactionFromActivity,
  fallbackThreadTurnSummary,
  prepareThreadSummaryCodexConfig,
  shouldMergeCausalBotRevision,
  TaskProcessor,
  threadTurnSummaryInput
} from "./processor.js";

function startupProcessor(listSkills: () => Promise<never[]> = async () => []) {
  const logs: string[] = [];
  const client = { reportUserSkills: vi.fn(async () => undefined) } as unknown as ControlPlaneClient;
  const processor = new TaskProcessor({
    workspaceRoots: [{ alias: "repo", path: tmpdir() }],
    runtimeStateDir: tmpdir(),
    attachmentRetentionDays: 7
  } as ResolvedWorkerConfig, client, {
    log: (message) => logs.push(message)
  });
  const codex = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    listSkills: vi.fn(listSkills)
  };
  const summaryCodex = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined)
  };
  (processor as unknown as { codex: typeof codex }).codex = codex;
  (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;
  return { processor, codex, summaryCodex, logs };
}

describe("TaskProcessor startup", () => {
  it("skips global attachment cleanup and continues to Codex startup", async () => {
    const { processor, codex, summaryCodex, logs } = startupProcessor();
    await processor.start();
    expect(codex.start).toHaveBeenCalledOnce();
    expect(summaryCodex.start).not.toHaveBeenCalled();
    expect(logs).toContain("global attachment cleanup: skipped; deferred to maintenance");
    await processor.stop();
  });

  it("logs successful startup stages", async () => {
    const { processor, logs } = startupProcessor();
    await processor.start();
    expect(logs).toContain("attention workspace: ready");
    expect(logs).toContain("Codex App Server: ready");
    expect(logs).toContain("Thread summary App Server: deferred until snapshot refresh");
    expect(logs).toContain("user skill inventory: ready");
    await processor.stop();
  });

  it("logs user skill inventory failure and continues startup", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const { processor, codex, logs } = startupProcessor(async () => { throw new Error("scan failed"); });
      await processor.start();
      expect(codex.start).toHaveBeenCalledOnce();
      expect(logs).toContain("user skill inventory: unavailable; continuing");
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("worker user skill inventory unavailable"));
      await processor.stop();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("thread summary Codex isolation", () => {
  it("derives a private home with only authentication and model/provider configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "thread-summary-home-"));
    const codexHome = join(root, "source-home");
    const runtimeStateDir = join(root, "state");
    await mkdir(codexHome, { recursive: true });
    await mkdir(runtimeStateDir, { recursive: true });
    const catalogPath = join(codexHome, "catalog.json");
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ token: "auth-secret" }), { mode: 0o644 });
    await writeFile(catalogPath, JSON.stringify({ models: [{ slug: "summary-model" }] }));
    await writeFile(join(codexHome, "config.toml"), [
      'model = "base-model"',
      'sandbox_mode = "danger-full-access"',
      'approval_policy = "never"',
      `model_catalog_json = ${JSON.stringify(catalogPath)}`,
      '[model_providers.safe]',
      'name = "Safe provider"',
      'base_url = "https://provider.invalid/v1"',
      'experimental_bearer_token = "provider-secret"',
      '[mcp_servers.unsafe]',
      'command = "unsafe-tool"',
      '[plugins.unsafe]',
      'enabled = true'
    ].join("\n"));
    await writeFile(join(codexHome, "safe.config.toml"), [
      'model = "summary-model"',
      'model_provider = "safe"',
      'model_reasoning_effort = "medium"',
      '[features]',
      'shell_tool = true',
      'plugins = true'
    ].join("\n"));

    const resolved = await prepareThreadSummaryCodexConfig({
      codexHome,
      codexProfile: "safe",
      runtimeStateDir,
      profileOverrides: ['features.shell_tool=true'],
      profileModel: "summary-model",
      profileReasoningEffort: "medium"
    } as ResolvedWorkerConfig);

    const generated = parseToml(await readFile(join(resolved.codexHome, "config.toml"), "utf8")) as Record<string, unknown>;
    expect(generated).toEqual({
      model: "summary-model",
      model_provider: "safe",
      model_reasoning_effort: "medium",
      model_catalog_json: join(resolved.codexHome, "model-catalog.json"),
      model_providers: {
        safe: {
          name: "Safe provider",
          base_url: "https://provider.invalid/v1",
          experimental_bearer_token: "provider-secret"
        }
      }
    });
    expect(await readFile(join(resolved.codexHome, "auth.json"), "utf8")).toBe(JSON.stringify({ token: "auth-secret" }));
    expect(await readFile(join(resolved.codexHome, "model-catalog.json"), "utf8")).toBe(await readFile(catalogPath, "utf8"));
    expect((await stat(resolved.codexHome)).mode & 0o777).toBe(0o700);
    expect((await stat(join(resolved.codexHome, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(resolved.codexHome, "config.toml"))).mode & 0o777).toBe(0o600);
    expect(resolved.profileOverrides).toContain("features.shell_tool=false");
    expect(resolved.profileOverrides).toContain("features.plugins=false");
    expect(resolved.profileOverrides).not.toContain("features.shell_tool=true");
    expect(JSON.stringify(generated)).not.toContain("unsafe-tool");
  });
});

const signal = (id: string, attachments: Signal["attachments"]): Signal => ({
  id,
  taskId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  seq: 1,
  senderId: "ou_owner",
  senderRole: "owner",
  senderType: "user",
  senderBotId: null,
  senderDisplayName: null,
  ingressSource: "lark",
  originMessageId: "om_signal",
  botDialogueDepth: 0,
  messageId: "om_signal",
  messageType: "file",
  content: "请读取附件",
  preview: "请读取附件",
  attachments,
  priority: 90,
  decision: "consume",
  createdAt: new Date().toISOString()
});

const task = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  botId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  botAppId: "cli_test",
  botDisplayName: "Test Bot",
  roleInstructions: "",
  botConfigRevision: 1,
  attachmentPolicy: { maxBytes: 5, taskMaxBytes: 8, retentionDays: 7 },
  requesterRole: "owner",
  authorization: { read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false }
} as ClaimedTask;

describe("TaskProcessor attachments", () => {
  it("redacts active runtime credentials from user-visible and audit payload strings", () => {
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }]
    } as ResolvedWorkerConfig, {} as ControlPlaneClient);
    const internal = processor as unknown as {
      activeSecretValues: string[];
      redactSecrets(value: string): string;
      redactUnknown(value: unknown): unknown;
    };
    internal.activeSecretValues = ["runtime-secret"];
    expect(internal.redactSecrets("token=runtime-secret")).toBe("token=[REDACTED]");
    expect(internal.redactSecrets("-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----"))
      .toBe("[REDACTED PRIVATE KEY]");
    expect(internal.redactUnknown({ command: ["echo", "runtime-secret"] })).toEqual({ command: ["echo", "[REDACTED]"] });
  });

  it("keeps file paths internal in the prompt and sends images by localImage instead of text paths", () => {
    const current = signal("11111111-1111-4111-8111-111111111111", []);
    const prompt = buildTaskPrompt(task, [current], false, [
      { id: "22222222-2222-4222-8222-222222222222", type: "image", fileName: "screen.png", path: "/private/screen.png", size: 10 },
      { id: "33333333-3333-4333-8333-333333333333", type: "file", fileName: "proof.txt", path: "/private/proof.txt", size: 10 }
    ], [{ id: "44444444-4444-4444-8444-444444444444", type: "file", fileName: "missing.txt", reason: "附件下载失败或资源已删除" }]);
    expect(prompt).toContain("图片「screen.png」已作为 localImage 输入");
    expect(prompt).not.toContain("/private/screen.png");
    expect(prompt).toContain("/private/proof.txt");
    expect(prompt).toContain("禁止在 commentary 或最终飞书回复中原样输出");
    expect(prompt).toContain("missing.txt");
  });

  it("deduplicates attachment IDs and degrades when the task total limit is reached", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lark-agent-processor-attachments-"));
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const limits: number[] = [];
    const client = {
      downloadAttachment: async (_task: ClaimedTask, _signal: Signal, attachmentId: string, _target: string, maxBytes: number) => {
        limits.push(maxBytes);
        if (attachmentId.startsWith("6666")) throw new AttachmentDownloadError("task_limit", "total limit");
        return { path: _target, size: 5 };
      },
      event: async (_taskId: string, _leaseToken: string, type: string, _summary: string, payload: Record<string, unknown>) => { events.push({ type, payload }); }
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: workspace }],
      attachmentMaxBytes: 5,
      attachmentTaskMaxBytes: 8,
      attachmentRetentionDays: 7
    } as ResolvedWorkerConfig, client);
    const first = { id: "55555555-5555-4555-8555-555555555555", type: "file" as const, fileName: "first.txt" };
    const second = { id: "66666666-6666-4666-8666-666666666666", type: "file" as const, fileName: "second.txt" };
    const signals = [
      signal("77777777-7777-4777-8777-777777777777", [first, second]),
      { ...signal("88888888-8888-4888-8888-888888888888", [first]), messageId: "om_duplicate", seq: 2 }
    ];
    const resolve = (processor as unknown as { resolveAttachments(
      task: ClaimedTask,
      workspacePath: string,
      signals: Signal[],
      downloaded: Map<string, unknown>,
      failed: Set<string>
    ): Promise<{ available: unknown[]; unavailable: unknown[] }> }).resolveAttachments.bind(processor);
    const result = await resolve({ ...task, leaseToken: "lease" }, workspace, signals, new Map(), new Set());
    expect(result.available).toHaveLength(1);
    expect(result.unavailable).toHaveLength(1);
    expect(limits).toEqual([5, 3]);
    expect(events.map((item) => item.type)).toEqual(["attachment.downloaded", "attachment.failed"]);
    expect(events[1]?.payload.reason).toBe("task_limit");
  });
});

describe("TaskProcessor stale draft revision", () => {
  it("merges a registered bot reply from the same causal chain deterministically", () => {
    const botSignal: Signal = {
      ...signal("99999999-9999-4999-8999-999999999999", []),
      senderId: "cli_peer",
      senderType: "bot",
      senderBotId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      senderDisplayName: "Peer Bot",
      originMessageId: "om_signal",
      messageId: "om_peer_reply",
      content: "1",
      preview: "1",
      decision: "pending"
    };

    expect(shouldMergeCausalBotRevision({ ...task, signals: [signal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", [])] }, botSignal, true)).toBe(true);
    expect(shouldMergeCausalBotRevision({ ...task, signals: [signal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", [])] }, botSignal, false)).toBe(false);
    expect(shouldMergeCausalBotRevision({ ...task, signals: [signal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", [])] }, { ...botSignal, originMessageId: "om_other" }, true)).toBe(false);
    expect(shouldMergeCausalBotRevision({ ...task, signals: [signal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", [])] }, { ...botSignal, senderType: "user" }, true)).toBe(false);
  });
});

describe("TaskProcessor workspace runtime sync", () => {
  it("validates the lease before touching the workspace and clears busy state after heartbeat failure", async () => {
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }]
    } as ResolvedWorkerConfig, {
      heartbeatWorkspaceRuntimeSync: async () => { throw new Error("lease rejected"); }
    } as unknown as ControlPlaneClient);
    const job = {
      id: "11111111-1111-4111-8111-111111111111",
      botAppId: "cli_test",
      chatContextId: "22222222-2222-4222-8222-222222222222",
      workspaceKey: "22222222-2222-4222-8222-222222222222",
      resolvedWorkspaceAlias: "repo",
      leaseToken: "lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      desiredFingerprint: "a".repeat(64),
      skills: [],
      skillSetFingerprint: "b".repeat(64),
      runtimeConfig: { fingerprint: "c".repeat(64), files: [] }
    } as WorkspaceRuntimeSyncJob;
    await expect(processor.processWorkspaceRuntimeSync(job)).rejects.toThrow("lease rejected");
    expect(processor.isBusy()).toBe(false);
  });

  it("reports a failed result immediately when the workspace cannot be resolved", async () => {
    const results: Array<{ status: string; summary: string }> = [];
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }]
    } as ResolvedWorkerConfig, {
      heartbeatWorkspaceRuntimeSync: async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }),
      completeWorkspaceRuntimeSync: async (_job: WorkspaceRuntimeSyncJob, result: { status: string; summary: string }) => { results.push(result); }
    } as unknown as ControlPlaneClient);
    const job = {
      id: "11111111-1111-4111-8111-111111111121",
      botAppId: "cli_test",
      chatContextId: "22222222-2222-4222-8222-222222222222",
      workspaceKey: "22222222-2222-4222-8222-222222222222",
      resolvedWorkspaceAlias: "missing",
      leaseToken: "lease",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      desiredFingerprint: "a".repeat(64),
      skills: [],
      skillSetFingerprint: "b".repeat(64),
      runtimeConfig: { fingerprint: "c".repeat(64), files: [] }
    } as WorkspaceRuntimeSyncJob;
    await expect(processor.processWorkspaceRuntimeSync(job)).rejects.toThrow(/workspace alias/i);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: "failed", summary: "工作区无法准备，技能与运行配置未同步。" });
    expect(processor.isBusy()).toBe(false);
  });
});

describe("TaskProcessor Thread snapshots", () => {
  const snapshotJob = (): ThreadSnapshotJob => ({
    id: "11111111-1111-4111-8111-111111111111",
    chatContextId: "22222222-2222-4222-8222-222222222222",
    threadId: "thread-fixed",
    leaseToken: "snapshot-lease",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    attempt: 1,
    summaryEnabled: false,
    summaryModel: null,
    summaryReasoningEffort: null
  });

  it("uploads bounded chunks, excludes snapshot work from idle state, and completes without starting a turn", async () => {
    const uploaded: Array<{ turns: unknown[]; items: unknown[] }> = [];
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => { releaseRead = resolve; });
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      uploadThreadSnapshotChunk: vi.fn(async (_job: ThreadSnapshotJob, chunk: { turns: unknown[]; items: unknown[] }) => { uploaded.push(chunk); }),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], supportsThreadItemsList: true
    } as ResolvedWorkerConfig, client);
    const history = {
      thread: { id: "thread-fixed" }, protocolSource: "thread/read+thread/items/list" as const,
      turns: [{ turnIndex: 0, turnId: "turn-0", status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: { id: "turn-0" } }],
      items: Array.from({ length: 101 }, (_, ordinal) => ({
        ordinal, turnId: "turn-0", itemIndex: ordinal, itemId: `item-${ordinal}`, itemType: "agentMessage", raw: { id: `item-${ordinal}`, type: "agentMessage", text: `${ordinal}` }
      }))
    };
    const codex = { readThreadHistory: vi.fn(async () => { await readGate; return history; }) };
    (processor as unknown as { codex: typeof codex }).codex = codex;

    const running = processor.processThreadSnapshot(snapshotJob());
    await vi.waitFor(() => expect(processor.isBusy()).toBe(true));
    await expect(processor.processThreadSnapshot(snapshotJob())).rejects.toThrow("runner is busy");
    releaseRead();
    await running;

    expect(processor.isBusy()).toBe(false);
    expect(codex.readThreadHistory).toHaveBeenCalledWith("thread-fixed", true);
    expect(uploaded.flatMap((chunk) => chunk.turns)).toHaveLength(1);
    expect(uploaded.flatMap((chunk) => chunk.items)).toHaveLength(101);
    expect(uploaded.every((chunk) => chunk.turns.length <= 50 && chunk.items.length <= 50)).toBe(true);
    expect(client.completeThreadSnapshot).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ turnCount: 1, itemCount: 101 }));
    expect(client.failThreadSnapshot).not.toHaveBeenCalled();
  });

  it("reports an explicit failure when one persisted Item exceeds 4 MiB", async () => {
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      uploadThreadSnapshotChunk: vi.fn(async () => undefined),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client);
    const codex = { readThreadHistory: vi.fn(async () => ({
      thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const, turns: [],
      items: [{ ordinal: 0, turnId: null, itemIndex: null, itemId: "huge", itemType: "agentMessage", raw: { text: "x".repeat(4 * 1024 * 1024) } }]
    })) };
    (processor as unknown as { codex: typeof codex }).codex = codex;

    await expect(processor.processThreadSnapshot(snapshotJob())).rejects.toThrow(/超过 4 MiB/);
    expect(client.uploadThreadSnapshotChunk).not.toHaveBeenCalled();
    expect(client.completeThreadSnapshot).not.toHaveBeenCalled();
    expect(client.failThreadSnapshot).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("超过 4 MiB"));
    expect(processor.isBusy()).toBe(false);
  });

  it("rejects oversized items before silently truncating their raw JSON", () => {
    expect(() => buildThreadSnapshotChunks({ turns: [], items: [{
      ordinal: 0, turnId: null, itemIndex: null, itemId: "huge", itemType: "unknown", raw: { payload: "x".repeat(4 * 1024 * 1024) }
    }] })).toThrow(/未截断快照内容/);
  });

  it("reuses AI summaries, summarizes only visible messages, and falls back without failing the snapshot", async () => {
    const uploaded: Array<{ turns: Array<Record<string, unknown>>; items: unknown[] }> = [];
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => [{
        turnId: "turn-0", summary: "已有摘要", summaryModel: "older-model", summaryGeneratedAt: "2026-07-15T00:00:00.000Z"
      }]),
      uploadThreadSnapshotChunk: vi.fn(async (_job: ThreadSnapshotJob, chunk: { turns: Array<Record<string, unknown>>; items: unknown[] }) => { uploaded.push(chunk); }),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp", supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client);
    const history = {
      thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
      turns: ["turn-0", "turn-1", "turn-2"].map((turnId, turnIndex) => ({
        turnIndex, turnId, status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: { id: turnId }
      })),
      items: [
        { ordinal: 0, turnId: "turn-0", itemIndex: 0, itemId: "old", itemType: "userMessage", raw: { content: [{ type: "text", text: "旧消息" }] } },
        { ordinal: 1, turnId: "turn-1", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { content: [{ type: "text", text: "飞书信号：\n- [bot:协作助手|member|depth=1] 请完成部署回测" }] } },
        { ordinal: 2, turnId: "turn-1", itemIndex: 1, itemId: "reason", itemType: "reasoning", raw: { summary: ["隐藏推理不得提交"] } },
        { ordinal: 3, turnId: "turn-1", itemIndex: 2, itemId: "agent", itemType: "agentMessage", raw: { text: JSON.stringify({ reply: "部署回测完成", rationale: "内部原因" }) } },
        { ordinal: 4, turnId: "turn-2", itemIndex: 0, itemId: "command", itemType: "commandExecution", raw: { command: "secret-command" } }
      ]
    };
    const codex = { readThreadHistory: vi.fn(async () => history) };
    const summaryCodex = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      summarizeThreadTurns: vi.fn(async (_cwd, turns) => turns.map((turn) => ({ turnId: turn.turnId, summary: "完成部署回测" })))
    };
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    await processor.processThreadSnapshot({
      ...snapshotJob(), summaryEnabled: true, summaryModel: "summary-model", summaryReasoningEffort: "medium"
    });

    expect(summaryCodex.summarizeThreadTurns).toHaveBeenCalledTimes(1);
    const summaryInputs = summaryCodex.summarizeThreadTurns.mock.calls[0]?.[1];
    expect(summaryInputs).toEqual([{
      turnId: "turn-1",
      messages: [
        { speaker: "other_agent", speakerName: "协作助手", text: "请完成部署回测" },
        { speaker: "agent", speakerName: "本 Agent", text: "部署回测完成" }
      ]
    }]);
    expect(JSON.stringify(summaryInputs)).not.toContain("隐藏推理");
    expect(JSON.stringify(summaryInputs)).not.toContain("secret-command");
    const turns = uploaded.flatMap((chunk) => chunk.turns);
    expect(turns).toEqual([
      expect.objectContaining({ turnId: "turn-0", summary: "已有摘要", summarySource: "ai", summaryModel: "older-model", summaryGeneratedAt: "2026-07-15T00:00:00.000Z" }),
      expect.objectContaining({ turnId: "turn-1", summary: "完成部署回测", summarySource: "ai", summaryModel: "summary-model" }),
      expect.objectContaining({ turnId: "turn-2", summary: "本轮执行记录", summarySource: "fallback", summaryModel: null })
    ]);
    expect(client.completeThreadSnapshot).toHaveBeenCalledOnce();
    expect(client.failThreadSnapshot).not.toHaveBeenCalled();
  });

  it("never starts a Turn on the original Thread while generating summaries", async () => {
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => []),
      uploadThreadSnapshotChunk: vi.fn(async () => undefined),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp", supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client);
    const codex = {
      readThreadHistory: vi.fn(async () => ({
        thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
        turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: {} }],
        items: [{ ordinal: 0, turnId: "turn-1", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { text: "只读原 Thread" } }]
      })),
      startEphemeralThread: vi.fn(),
      runTurn: vi.fn()
    };
    const summaryCodex = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      summarizeThreadTurns: vi.fn(async () => [{ turnId: "turn-1", summary: "只读快照摘要" }])
    };
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    await processor.processThreadSnapshot({ ...snapshotJob(), summaryEnabled: true });

    expect(codex.readThreadHistory).toHaveBeenCalledWith("thread-fixed", false);
    expect(codex.startEphemeralThread).not.toHaveBeenCalled();
    expect(codex.runTurn).not.toHaveBeenCalled();
    expect(summaryCodex.summarizeThreadTurns).toHaveBeenCalledOnce();
    expect(client.completeThreadSnapshot).toHaveBeenCalledOnce();
  });

  it("renews the snapshot lease while a summary batch crosses the heartbeat interval", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T08:00:00.000Z"));
    let summaryStarted!: () => void;
    const started = new Promise<void>((resolve) => { summaryStarted = resolve; });
    let releaseSummary!: () => void;
    const summaryResult = new Promise<Array<{ turnId: string; summary: string }>>((resolve) => {
      releaseSummary = () => resolve([{ turnId: "turn-1", summary: "续租期间生成摘要" }]);
    });
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => []),
      uploadThreadSnapshotChunk: vi.fn(async () => undefined),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp", supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client);
    const codex = { readThreadHistory: vi.fn(async () => ({
      thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
      turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: {} }],
      items: [{ ordinal: 0, turnId: "turn-1", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { text: "等待慢摘要" } }]
    })) };
    const summaryCodex = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      summarizeThreadTurns: vi.fn(() => {
        summaryStarted();
        return summaryResult;
      })
    };
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    try {
      const running = processor.processThreadSnapshot({ ...snapshotJob(), summaryEnabled: true });
      await started;
      expect(client.heartbeatThreadSnapshot).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20_000);
      expect(client.heartbeatThreadSnapshot).toHaveBeenCalledTimes(2);

      releaseSummary();
      await running;
      expect(client.completeThreadSnapshot).toHaveBeenCalledOnce();
      expect(client.failThreadSnapshot).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back for an entire failed AI batch and retries fallback summaries on the next refresh", async () => {
    const uploaded: Array<{ turns: Array<Record<string, unknown>> }> = [];
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => []),
      uploadThreadSnapshotChunk: vi.fn(async (_job: ThreadSnapshotJob, chunk: { turns: Array<Record<string, unknown>> }) => { uploaded.push(chunk); }),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({ workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp" } as ResolvedWorkerConfig, client);
    const codex = {
      readThreadHistory: vi.fn(async () => ({
        thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
        turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: {} }],
        items: [{ ordinal: 0, turnId: "turn-1", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { text: "重新生成摘要" } }]
      }))
    };
    const summaryCodex = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      summarizeThreadTurns: vi.fn(async () => { throw new Error("summary unavailable"); })
    };
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    await expect(processor.processThreadSnapshot({ ...snapshotJob(), summaryEnabled: true })).resolves.toBeUndefined();
    expect(uploaded.flatMap((chunk) => chunk.turns)).toEqual([
      expect.objectContaining({ turnId: "turn-1", summary: "重新生成摘要", summarySource: "fallback" })
    ]);
    expect(client.failThreadSnapshot).not.toHaveBeenCalled();
    expect(client.previousThreadTurnSummaries).toHaveBeenCalledOnce();
  });

  it("bounds a hung summary App Server initialize, falls back, and retries next refresh", async () => {
    const uploaded: Array<{ turns: Array<Record<string, unknown>> }> = [];
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => []),
      uploadThreadSnapshotChunk: vi.fn(async (_job: ThreadSnapshotJob, chunk: { turns: Array<Record<string, unknown>> }) => { uploaded.push(chunk); }),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const history = {
      thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
      turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: {} }],
      items: [{ ordinal: 0, turnId: "turn-1", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { text: "隔离进程重试" } }]
    };
    const codex = { readThreadHistory: vi.fn(async () => history) };
    const summaryCodex = {
      start: vi.fn()
        .mockImplementationOnce(() => new Promise<void>(() => undefined))
        .mockResolvedValue(undefined),
      stop: vi.fn(async () => undefined),
      abort: vi.fn(),
      summarizeThreadTurns: vi.fn(async () => [{ turnId: "turn-1", summary: "隔离进程恢复" }])
    };
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp", supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client, { summaryTimeoutMs: 20 });
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    await expect(processor.processThreadSnapshot({ ...snapshotJob(), summaryEnabled: true })).resolves.toBeUndefined();
    expect(uploaded.flatMap((chunk) => chunk.turns)).toEqual([
      expect.objectContaining({ turnId: "turn-1", summary: "隔离进程重试", summarySource: "fallback" })
    ]);
    expect(summaryCodex.summarizeThreadTurns).not.toHaveBeenCalled();
    expect(summaryCodex.abort).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("timed out") }));
    expect(client.failThreadSnapshot).not.toHaveBeenCalled();

    uploaded.length = 0;
    await expect(processor.processThreadSnapshot({ ...snapshotJob(), id: "33333333-3333-4333-8333-333333333333", summaryEnabled: true })).resolves.toBeUndefined();
    expect(summaryCodex.start).toHaveBeenCalledTimes(2);
    expect(summaryCodex.summarizeThreadTurns).toHaveBeenCalledOnce();
    expect(uploaded.flatMap((chunk) => chunk.turns)).toEqual([
      expect.objectContaining({ turnId: "turn-1", summary: "隔离进程恢复", summarySource: "ai" })
    ]);
  });

  it("applies one deadline across summary process startup and generation", async () => {
    const uploaded: Array<{ turns: Array<Record<string, unknown>> }> = [];
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => []),
      uploadThreadSnapshotChunk: vi.fn(async (_job: ThreadSnapshotJob, chunk: { turns: Array<Record<string, unknown>> }) => { uploaded.push(chunk); }),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp", supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client, { summaryTimeoutMs: 45 });
    const codex = { readThreadHistory: vi.fn(async () => ({
      thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
      turns: [{ turnIndex: 0, turnId: "turn-1", status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: {} }],
      items: [{ ordinal: 0, turnId: "turn-1", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { text: "整批截止时间" } }]
    })) };
    const summaryCodex = {
      start: vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }),
      stop: vi.fn(async () => undefined),
      abort: vi.fn(),
      summarizeThreadTurns: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return [{ turnId: "turn-1", summary: "不应采用的迟到摘要" }];
      })
    };
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    await expect(processor.processThreadSnapshot({ ...snapshotJob(), summaryEnabled: true })).resolves.toBeUndefined();
    expect(summaryCodex.abort).toHaveBeenCalledOnce();
    expect(uploaded.flatMap((chunk) => chunk.turns)).toEqual([
      expect.objectContaining({ turnId: "turn-1", summary: "整批截止时间", summarySource: "fallback" })
    ]);
  });

  it("falls back only the turn whose JSON-encoded summary input exceeds 48 KiB", async () => {
    const uploaded: Array<{ turns: Array<Record<string, unknown>> }> = [];
    const client = {
      heartbeatThreadSnapshot: vi.fn(async () => ({ leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })),
      previousThreadTurnSummaries: vi.fn(async () => []),
      uploadThreadSnapshotChunk: vi.fn(async (_job: ThreadSnapshotJob, chunk: { turns: Array<Record<string, unknown>> }) => { uploaded.push(chunk); }),
      completeThreadSnapshot: vi.fn(async () => undefined),
      failThreadSnapshot: vi.fn(async () => undefined)
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }], runtimeStateDir: "/tmp", supportsThreadItemsList: false
    } as ResolvedWorkerConfig, client);
    const escaped = "\\".repeat(4 * 1024);
    const history = {
      thread: { id: "thread-fixed" }, protocolSource: "thread/read" as const,
      turns: ["turn-oversized", "turn-normal"].map((turnId, turnIndex) => ({
        turnIndex, turnId, status: "completed", startedAt: null, completedAt: null, durationMs: null, error: null, raw: { id: turnId }
      })),
      items: [
        ...Array.from({ length: 8 }, (_, itemIndex) => ({
          ordinal: itemIndex, turnId: "turn-oversized", itemIndex, itemId: `escaped-${itemIndex}`,
          itemType: "userMessage", raw: { text: escaped }
        })),
        { ordinal: 8, turnId: "turn-normal", itemIndex: 0, itemId: "normal", itemType: "userMessage", raw: { text: "正常摘要输入" } }
      ]
    };
    const codex = { readThreadHistory: vi.fn(async () => history) };
    const summaryCodex = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      summarizeThreadTurns: vi.fn(async (_cwd, turns) => turns.map((turn) => ({ turnId: turn.turnId, summary: "正常回合摘要" })))
    };
    (processor as unknown as { codex: typeof codex }).codex = codex;
    (processor as unknown as { summaryCodex: typeof summaryCodex }).summaryCodex = summaryCodex;

    await expect(processor.processThreadSnapshot({ ...snapshotJob(), summaryEnabled: true })).resolves.toBeUndefined();

    expect(summaryCodex.summarizeThreadTurns).toHaveBeenCalledOnce();
    expect(summaryCodex.summarizeThreadTurns.mock.calls[0]?.[1]).toEqual([
      { turnId: "turn-normal", messages: [{ speaker: "user", speakerName: "用户", text: "正常摘要输入" }] }
    ]);
    expect(uploaded.flatMap((chunk) => chunk.turns)).toEqual([
      expect.objectContaining({ turnId: "turn-oversized", summarySource: "fallback" }),
      expect.objectContaining({ turnId: "turn-normal", summary: "正常回合摘要", summarySource: "ai" })
    ]);
    expect(client.completeThreadSnapshot).toHaveBeenCalledOnce();
    expect(client.failThreadSnapshot).not.toHaveBeenCalled();
  });

  it("bounds summary batches and derives a readable fallback from visible messages", () => {
    const inputs = Array.from({ length: 101 }, (_, index) => ({
      turnId: `turn-${index}`,
      messages: [{ speaker: "user" as const, speakerName: "用户", text: `第 ${index} 条消息` }]
    }));
    const batches = buildThreadSummaryBatches(inputs);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 1]);
    const escaped = "\\".repeat(4 * 1024);
    const oversized = { turnId: "oversized", messages: Array.from({ length: 8 }, () => ({ speaker: "user" as const, speakerName: "用户", text: escaped })) };
    expect(buildThreadSummaryBatchPlan([inputs[0]!, oversized, inputs[1]!])).toEqual({
      batches: [[inputs[0]!], [inputs[1]!]],
      oversized: [oversized]
    });
    expect(fallbackThreadTurnSummary(inputs[0]!, "2026-07-16T00:00:00.000Z")).toEqual({
      summary: "第 0 条消息", summarySource: "fallback", summaryModel: null, summaryGeneratedAt: "2026-07-16T00:00:00.000Z"
    });
    const emojiFallback = fallbackThreadTurnSummary({
      turnId: "turn-emoji",
      messages: [{ speaker: "user", speakerName: "用户", text: "😀".repeat(30) }]
    }, "2026-07-16T00:00:00.000Z");
    expect(emojiFallback.summary).toBe("😀".repeat(24));
    expect(threadSnapshotChunkSchema.safeParse({
      chunkIndex: 0,
      turns: [{
        turnIndex: 0,
        turnId: "turn-emoji",
        status: "completed",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
        raw: {},
        ...emojiFallback
      }],
      items: []
    }).success).toBe(true);
    expect(threadTurnSummaryInput("turn", [{
      ordinal: 0, turnId: "turn", itemIndex: 0, itemId: "user", itemType: "userMessage", raw: { text: "用户消息" }
    }, {
      ordinal: 1, turnId: "turn", itemIndex: 1, itemId: "collab", itemType: "collabAgentToolCall",
      raw: { senderName: "审查 Agent", prompt: "检查代码", result: "没有发现阻塞" }
    }])).toEqual({ turnId: "turn", messages: [
      { speaker: "user", speakerName: "用户", text: "用户消息" },
      { speaker: "other_agent", speakerName: "审查 Agent", text: "没有发现阻塞" }
    ] });
  });
});

describe("TaskProcessor chat context audit", () => {
  it("parses preferred and legacy automatic compaction notifications", () => {
    expect(codexCompactionFromActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_compact",
      item: { type: "contextCompaction", id: "item_compact" }
    })).toEqual({ threadId: "thr_chat", turnId: "turn_compact", itemId: "item_compact", source: "item/completed" });
    expect(codexCompactionFromActivity("thread/compacted", {
      threadId: "thr_chat",
      turnId: "turn_compact"
    })).toEqual({ threadId: "thr_chat", turnId: "turn_compact", itemId: null, source: "thread/compacted" });
    expect(codexCompactionFromActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_other",
      item: { type: "agentMessage", id: "item_message" }
    })).toBeNull();
  });

  it("deduplicates by item ID, falls back to turn ID for legacy notifications, and ignores attention threads", async () => {
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const client = {
      event: async (_taskId: string, _leaseToken: string, type: string, _summary: string, payload: Record<string, unknown>) => {
        events.push({ type, payload });
      }
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }]
    } as ResolvedWorkerConfig, client);
    const persistent = {
      ...task,
      chatContextId: "99999999-9999-4999-8999-999999999999",
      workspaceKey: "99999999-9999-4999-8999-999999999999",
      codexThreadId: "thr_chat",
      chatContextThreadId: "thr_chat",
      leaseToken: "lease"
    } as ClaimedTask;
    const internal = processor as unknown as {
      currentTask: ClaimedTask | null;
      currentCodexThreadId: string | null;
      handleCodexActivity(method: string, params: Record<string, unknown>): void;
      flushCompactions(): Promise<void>;
    };
    internal.currentTask = persistent;
    internal.currentCodexThreadId = "thr_chat";
    internal.handleCodexActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_compact",
      item: { type: "contextCompaction", id: "item_compact" }
    });
    internal.handleCodexActivity("thread/compacted", { threadId: "thr_chat", turnId: "turn_compact" });
    internal.handleCodexActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_compact",
      item: { type: "contextCompaction", id: "item_compact" }
    });
    internal.handleCodexActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_compact",
      item: { type: "contextCompaction", id: "item_compact_second" }
    });
    internal.handleCodexActivity("thread/compacted", { threadId: "thr_chat", turnId: "turn_legacy" });
    internal.handleCodexActivity("thread/compacted", { threadId: "thr_chat", turnId: "turn_legacy" });
    internal.handleCodexActivity("item/completed", {
      threadId: "thr_attention",
      turnId: "turn_attention",
      item: { type: "contextCompaction", id: "item_attention" }
    });
    await internal.flushCompactions();

    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      type: "codex.context.compacted",
      payload: {
        chatContextId: persistent.chatContextId,
        threadId: "thr_chat",
        turnId: "turn_compact",
        itemId: "item_compact",
        source: "item/completed"
      }
    });
    expect(events[1]?.payload).toMatchObject({ turnId: "turn_compact", itemId: "item_compact_second", source: "item/completed" });
    expect(events[2]?.payload).toMatchObject({ turnId: "turn_legacy", itemId: null, source: "thread/compacted" });
    expect(internal.currentCodexThreadId).toBe("thr_chat");
  });

  it("retries compaction audit and flushes it before releasing the task lease through result", async () => {
    const order: string[] = [];
    let attempts = 0;
    const client = {
      event: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("temporary network failure");
        order.push("compaction");
      },
      result: async () => { order.push("result"); }
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }]
    } as ResolvedWorkerConfig, client);
    const persistent = {
      ...task,
      chatContextId: "a8888888-8888-4888-8888-888888888888",
      workspaceKey: "a8888888-8888-4888-8888-888888888888",
      codexThreadId: "thr_chat",
      chatContextThreadId: "thr_chat",
      leaseToken: "lease"
    } as ClaimedTask;
    const internal = processor as unknown as {
      currentTask: ClaimedTask | null;
      currentCodexThreadId: string | null;
      handleCodexActivity(method: string, params: Record<string, unknown>): void;
      finishTask(task: ClaimedTask, status: "waiting_input", summary: string): Promise<void>;
    };
    internal.currentTask = persistent;
    internal.currentCodexThreadId = "thr_chat";
    internal.handleCodexActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_compact",
      item: { type: "contextCompaction", id: "item_compact" }
    });
    await internal.finishTask(persistent, "waiting_input", "pause");
    expect(attempts).toBe(2);
    expect(order).toEqual(["compaction", "result"]);
  });

  it("does not release the task lease when compaction audit exhausts retries", async () => {
    let attempts = 0;
    let resultCalls = 0;
    const client = {
      event: async () => {
        attempts += 1;
        throw new Error("control plane unavailable");
      },
      result: async () => { resultCalls += 1; }
    } as unknown as ControlPlaneClient;
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: "/tmp" }]
    } as ResolvedWorkerConfig, client);
    const persistent = {
      ...task,
      chatContextId: "a7777777-7777-4777-8777-777777777777",
      workspaceKey: "a7777777-7777-4777-8777-777777777777",
      codexThreadId: "thr_chat",
      chatContextThreadId: "thr_chat",
      leaseToken: "lease"
    } as ClaimedTask;
    const internal = processor as unknown as {
      currentTask: ClaimedTask | null;
      currentCodexThreadId: string | null;
      handleCodexActivity(method: string, params: Record<string, unknown>): void;
      finishTask(task: ClaimedTask, status: "waiting_input", summary: string): Promise<void>;
    };
    internal.currentTask = persistent;
    internal.currentCodexThreadId = "thr_chat";
    internal.handleCodexActivity("item/completed", {
      threadId: "thr_chat",
      turnId: "turn_failed_audit",
      item: { type: "contextCompaction", id: "item_failed_audit" }
    });

    await expect(internal.finishTask(persistent, "waiting_input", "pause")).rejects.toThrow(/compaction audit failed/i);
    expect(attempts).toBe(3);
    expect(resultCalls).toBe(0);
  });

  it("opens human handoff in the chat-specific workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lark-agent-handoff-workspace-"));
    const marker = join(root, "opened-path.txt");
    const launcher = join(root, "launcher.sh");
    await writeFile(launcher, `#!/bin/sh\nprintf '%s' "$1" > ${JSON.stringify(marker)}\n`);
    await chmod(launcher, 0o755);
    const processor = new TaskProcessor({
      workspaceRoots: [{ alias: "repo", path: root }],
      appLauncher: launcher,
      codexHome: root
    } as ResolvedWorkerConfig, {} as ControlPlaneClient);
    const chatContextId = "a9999999-9999-4999-8999-999999999999";
    await processor.openHandoff({
      ...task,
      chatContextId,
      workspaceKey: chatContextId,
      resolvedWorkspaceAlias: "repo"
    } as ClaimedTask);
    let opened = "";
    for (let attempt = 0; attempt < 200 && !opened; attempt += 1) {
      opened = await readFile(marker, "utf8").catch(() => "");
      if (!opened) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(opened).toBe(await realpath(join(root, "cli_test", "chats", chatContextId)));
  }, 10_000);
});
