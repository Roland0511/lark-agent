import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { ClaimedTask, Signal } from "../shared/contracts.js";
import type { ResolvedWorkerConfig } from "./config.js";
import { AttachmentDownloadError, type ControlPlaneClient } from "./control-plane-client.js";
import { buildTaskPrompt, TaskProcessor } from "./processor.js";

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
