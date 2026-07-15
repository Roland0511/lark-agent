import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ClaimedTask, Signal } from "../shared/contracts.js";
import type { ResolvedWorkerConfig } from "./config.js";
import { AttachmentDownloadError, type ControlPlaneClient } from "./control-plane-client.js";
import { buildTaskPrompt, codexCompactionFromActivity, TaskProcessor } from "./processor.js";

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
