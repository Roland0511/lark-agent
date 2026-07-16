import { describe, expect, it } from "vitest";
import {
  claimedTaskSchema,
  signalSchema,
  threadSnapshotJobSchema,
  threadSnapshotTurnSchema,
  threadSnapshotTurnSummariesPageSchema,
  workerRegistrationSchema,
  workerUserSkillsReportSchema
} from "./contracts.js";

function claim(botId: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    botId,
    botAppId: "cli_bot123",
    botDisplayName: "测试机器人",
    roleInstructions: "",
    botConfigRevision: 1,
    attentionModel: null,
    attentionReasoningEffort: null,
    executionModel: "gpt-test",
    executionReasoningEffort: "high",
    conversationId: "22222222-2222-4222-8222-222222222222",
    state: "running",
    leaseToken: "lease-token",
    leaseExpiresAt: new Date().toISOString(),
    requestedWorkspaceAlias: "repo",
    resolvedWorkspaceAlias: "repo",
    requesterId: "ou_owner",
    requesterRole: "owner",
    authorization: { read: true, repoWrite: false, gitCommit: false, gitPush: false, deploy: false, larkWrite: false, destructive: false },
    codexThreadId: null,
    chatType: "group",
    turnIndex: 1,
    triggerMessageId: "om_trigger",
    attentionContext: "首次激活回合",
    roomSeq: 1,
    signals: []
  };
}

describe("claimedTaskSchema", () => {
  it("接受 PostgreSQL 可保存的历史固定 Bot UUID", () => {
    expect(claimedTaskSchema.parse(claim("00000000-0000-0000-0000-000000000001")).botId)
      .toBe("00000000-0000-0000-0000-000000000001");
  });

  it("拒绝非规范 UUID，避免无效任务进入 Worker", () => {
    expect(claimedTaskSchema.safeParse(claim("legacy-bot")).success).toBe(false);
  });

  it("兼容旧 Claim，并校验聊天工作区只接受小写标准 UUID", () => {
    expect(claimedTaskSchema.parse(claim("00000000-0000-0000-0000-000000000001")).chatContextId).toBeUndefined();
    const modern = {
      ...claim("00000000-0000-0000-0000-000000000001"),
      chatContextId: "a3333333-3333-4333-8333-333333333333",
      workspaceKey: "a3333333-3333-4333-8333-333333333333",
      chatContextThreadId: null
    };
    expect(claimedTaskSchema.parse(modern)).toMatchObject({
      chatContextId: modern.chatContextId,
      workspaceKey: modern.workspaceKey,
      chatContextThreadId: null
    });
    expect(claimedTaskSchema.safeParse({ ...modern, workspaceKey: modern.workspaceKey.toUpperCase() }).success).toBe(false);
  });
});

describe("signalSchema attachment compatibility", () => {
  it("treats old control-plane signals without attachments as an empty array", () => {
    const signal = signalSchema.parse({
      id: "33333333-3333-4333-8333-333333333333",
      taskId: "11111111-1111-4111-8111-111111111111",
      seq: 1,
      senderId: "ou_owner",
      senderRole: "owner",
      senderType: "user",
      senderBotId: null,
      senderDisplayName: null,
      ingressSource: "lark",
      originMessageId: "om_old",
      botDialogueDepth: 0,
      messageId: "om_old",
      messageType: "text",
      content: "legacy signal",
      preview: "legacy signal",
      priority: 90,
      decision: "pending",
      createdAt: new Date().toISOString()
    });
    expect(signal.attachments).toEqual([]);
  });
});

describe("workerUserSkillsReportSchema", () => {
  const report = {
    skills: [], fingerprint: "a".repeat(64), scannedAt: new Date().toISOString(),
    status: "ready" as const, truncated: false, total: 0, errors: []
  };

  it("要求总数与截断标记相互一致", () => {
    expect(workerUserSkillsReportSchema.safeParse({ ...report, total: 1, truncated: false }).success).toBe(false);
    expect(workerUserSkillsReportSchema.safeParse({ ...report, total: 0, truncated: true }).success).toBe(false);
    expect(workerUserSkillsReportSchema.safeParse({ ...report, total: 1, truncated: true }).success).toBe(true);
  });

  it("拒绝把带扫描错误的清单标记为就绪", () => {
    expect(workerUserSkillsReportSchema.safeParse({ ...report, errors: ["scan failed"] }).success).toBe(false);
    expect(workerUserSkillsReportSchema.safeParse({ ...report, status: "stale", errors: ["scan failed"] }).success).toBe(true);
  });
});

describe("workerRegistrationSchema workspace mapping compatibility", () => {
  const registration = {
    executorId: "worker-a", displayName: "Worker A", homeRef: "worker-a:home", codexProfile: "lark-agent",
    configFingerprint: "a".repeat(64), codexVersion: "codex test", capacity: 1,
    workspaceAliases: ["repo"], capabilities: ["codex", "chat_context_v1"]
  };

  it("accepts both legacy registrations and the independent mapping fingerprint", () => {
    expect(workerRegistrationSchema.safeParse(registration).success).toBe(true);
    expect(workerRegistrationSchema.safeParse({ ...registration, workspaceMappingFingerprint: "b".repeat(64) }).success).toBe(true);
    expect(workerRegistrationSchema.safeParse({ ...registration, workspaceMappingFingerprint: "invalid" }).success).toBe(false);
  });
});

describe("Thread snapshot summary contracts", () => {
  const legacyJob = {
    id: "11111111-1111-4111-8111-111111111111",
    chatContextId: "22222222-2222-4222-8222-222222222222",
    threadId: "thread-1",
    leaseToken: "lease",
    leaseExpiresAt: new Date().toISOString(),
    attempt: 1
  };
  const legacyTurn = {
    turnIndex: 0,
    turnId: "turn-1",
    status: "completed",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    error: null,
    raw: { id: "turn-1" }
  };

  it("为旧控制面 Claim 提供关闭摘要的默认策略", () => {
    expect(threadSnapshotJobSchema.parse(legacyJob)).toMatchObject({
      summaryEnabled: false,
      summaryModel: null,
      summaryReasoningEffort: null
    });
  });

  it("兼容旧 Runner 回合，并校验摘要元数据必须完整", () => {
    expect(threadSnapshotTurnSchema.safeParse(legacyTurn).success).toBe(true);
    expect(threadSnapshotTurnSchema.safeParse({ ...legacyTurn, summary: "修复分页" }).success).toBe(false);
    expect(threadSnapshotTurnSchema.safeParse({
      ...legacyTurn,
      summary: "修复分页",
      summarySource: "ai",
      summaryModel: null,
      summaryGeneratedAt: new Date().toISOString()
    }).success).toBe(true);
    expect(threadSnapshotTurnSchema.safeParse({
      ...legacyTurn,
      summary: "超过二十四个字符的回合摘要必须被接口契约明确拒绝掉"
    }).success).toBe(false);
  });

  it("按 Unicode code point 校验 emoji 摘要长度", () => {
    const metadata = {
      summarySource: "ai" as const,
      summaryModel: "gpt-test",
      summaryGeneratedAt: new Date().toISOString()
    };
    expect(threadSnapshotTurnSchema.safeParse({
      ...legacyTurn,
      ...metadata,
      summary: "😀".repeat(24)
    }).success).toBe(true);
    expect(threadSnapshotTurnSchema.safeParse({
      ...legacyTurn,
      ...metadata,
      summary: "😀".repeat(25)
    }).success).toBe(false);
    expect(threadSnapshotTurnSummariesPageSchema.safeParse({
      summaries: [{
        turnId: "turn-emoji",
        summary: "🚀".repeat(24),
        summaryModel: "gpt-test",
        summaryGeneratedAt: metadata.summaryGeneratedAt
      }],
      nextCursor: null
    }).success).toBe(true);
  });

  it("摘要复用分页最多返回 50 项", () => {
    const summary = {
      turnId: "turn-1",
      summary: "修复分页",
      summaryModel: "gpt-test",
      summaryGeneratedAt: new Date().toISOString()
    };
    expect(threadSnapshotTurnSummariesPageSchema.safeParse({ summaries: [summary], nextCursor: null }).success).toBe(true);
    expect(threadSnapshotTurnSummariesPageSchema.safeParse({ summaries: Array(51).fill(summary), nextCursor: null }).success).toBe(false);
  });
});
