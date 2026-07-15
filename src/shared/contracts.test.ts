import { describe, expect, it } from "vitest";
import { claimedTaskSchema, signalSchema, workerRegistrationSchema, workerUserSkillsReportSchema } from "./contracts.js";

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
