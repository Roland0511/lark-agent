import { z } from "zod";

export const taskStates = [
  "queued",
  "waiting_worker",
  "running",
  "waiting_input",
  "waiting_approval",
  "held_draft",
  "human_owned",
  "completed",
  "failed",
  "cancelled"
] as const;
export type TaskState = (typeof taskStates)[number];

export const inboxDecisions = ["consume", "defer", "dismiss", "merge"] as const;
export type InboxDecision = (typeof inboxDecisions)[number];

export const conversationDispositions = ["complete", "awaiting_followup"] as const;
export type ConversationDisposition = (typeof conversationDispositions)[number];

export const taskTurnResultSchema = z.object({
  reply: z.string().min(1).max(100_000),
  disposition: z.enum(conversationDispositions),
  rationale: z.string().min(1).max(500)
});
export type TaskTurnResult = z.infer<typeof taskTurnResultSchema>;

export const draftStates = ["drafted", "held", "approved", "sent", "silenced", "discarded"] as const;
export type DraftState = (typeof draftStates)[number];

export const approvalStates = ["pending", "approved", "rejected", "expired"] as const;
export type ApprovalState = (typeof approvalStates)[number];

export const authorizationGrantSchema = z.object({
  read: z.boolean().default(true),
  repoWrite: z.boolean().default(false),
  gitCommit: z.boolean().default(false),
  gitPush: z.boolean().default(false),
  deploy: z.boolean().default(false),
  larkWrite: z.boolean().default(false),
  destructive: z.literal(false).default(false)
});
export type AuthorizationGrant = z.infer<typeof authorizationGrantSchema>;

export const workerRegistrationSchema = z.object({
  executorId: z.string().min(1).max(128),
  displayName: z.string().min(1).max(128),
  homeRef: z.string().min(1).max(128),
  codexProfile: z.string().regex(/^[A-Za-z0-9_-]+$/),
  configFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceMappingFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  codexVersion: z.string().min(1).max(128),
  capacity: z.number().int().min(1).max(16),
  workspaceAliases: z.array(z.string().min(1).max(128)).max(128),
  capabilities: z.array(z.string().min(1).max(128)).max(128),
  runnerVersion: z.string().min(1).max(128).nullable().optional(),
  architecture: z.enum(["arm64", "x64"]).nullable().optional(),
  registrationSource: z.literal("quick_install").optional()
});
export type WorkerRegistration = z.infer<typeof workerRegistrationSchema>;

export const workerModelCatalogEntrySchema = z.object({
  id: z.string().min(1).max(256),
  displayName: z.string().min(1).max(256),
  isDefault: z.boolean().default(false),
  defaultReasoningEffort: z.string().max(32).nullable(),
  supportedReasoningEfforts: z.array(z.string().min(1).max(32)).max(16)
});
export const workerModelCatalogSchema = z.object({
  models: z.array(workerModelCatalogEntrySchema).max(500)
});
export type WorkerModelCatalogEntry = z.infer<typeof workerModelCatalogEntrySchema>;

const canonicalUuidSchema = z.string().regex(
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  "Invalid canonical UUID"
);

const lowercaseCanonicalUuidSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  "Invalid lowercase canonical UUID"
);

export const workerSessionResponseSchema = z.object({
  sessionToken: z.string(),
  expiresAt: z.string().datetime()
});

export const runnerEnrollmentSchema = z.object({
  token: z.string().min(32).max(256),
  registration: workerRegistrationSchema.extend({
    runnerVersion: z.string().min(1).max(128),
    architecture: z.enum(["arm64", "x64"]),
    registrationSource: z.literal("quick_install")
  })
});

export const runnerEnrollmentResponseSchema = z.object({
  deviceToken: z.string().min(32),
  executorId: z.string(),
  enrolledAt: z.string().datetime()
});

export const signalAttachmentSchema = z.object({
  id: z.string().uuid(),
  type: z.enum(["image", "file"]),
  fileName: z.string().min(1).max(255)
});
export type SignalAttachment = z.infer<typeof signalAttachmentSchema>;

export const signalSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid(),
  seq: z.number().int().positive(),
  senderId: z.string(),
  senderRole: z.enum(["owner", "member"]),
  senderType: z.enum(["user", "bot"]),
  senderBotId: canonicalUuidSchema.nullable(),
  senderDisplayName: z.string().nullable(),
  ingressSource: z.enum(["lark", "internal", "history"]),
  originMessageId: z.string(),
  botDialogueDepth: z.number().int().nonnegative(),
  messageId: z.string(),
  messageType: z.string(),
  content: z.string(),
  preview: z.string(),
  attachments: z.array(signalAttachmentSchema).default([]),
  priority: z.number().int(),
  decision: z.enum(["pending", ...inboxDecisions]),
  createdAt: z.string()
});
export type Signal = z.infer<typeof signalSchema>;

export const attachmentPolicySchema = z.object({
  maxBytes: z.number().int().positive(),
  taskMaxBytes: z.number().int().positive(),
  retentionDays: z.number().int().positive()
}).default({ maxBytes: 104_857_600, taskMaxBytes: 209_715_200, retentionDays: 7 });

export const skillCoordinateSchema = z.string().regex(
  /^@[a-z0-9][a-z0-9_-]{0,63}\/[a-z0-9][a-z0-9_-]{0,127}$/,
  "Invalid SkillHub coordinate"
);

export const taskSkillPackageSchema = z.object({
  packageId: canonicalUuidSchema,
  coordinate: skillCoordinateSchema,
  name: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  registryFingerprint: z.string().min(1).max(256),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sourceScope: z.enum(["bot", "chat_context"])
});
export type TaskSkillPackage = z.infer<typeof taskSkillPackageSchema>;

export const taskRuntimeEnvironmentSchema = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
});

export const taskRuntimeFileSchema = z.object({
  id: canonicalUuidSchema,
  targetPath: z.string().min(1).max(1_024),
  revision: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().nonnegative().max(1_048_576),
  desiredState: z.enum(["present", "absent"]).default("present"),
  force: z.boolean().default(false)
});
export type TaskRuntimeFile = z.infer<typeof taskRuntimeFileSchema>;

export const taskRuntimeConfigSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  environment: z.array(taskRuntimeEnvironmentSchema).max(64).default([]),
  files: z.array(taskRuntimeFileSchema).max(40).default([])
}).default({ fingerprint: "0".repeat(64), environment: [], files: [] });
export type TaskRuntimeConfig = z.infer<typeof taskRuntimeConfigSchema>;

export const taskRuntimeEnvironmentResponseSchema = z.object({
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  variables: z.array(z.object({
    name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    value: z.string().max(65_536)
  })).max(64)
});
export type TaskRuntimeEnvironmentResponse = z.infer<typeof taskRuntimeEnvironmentResponseSchema>;

export const workerUserSkillSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2_000),
  displayName: z.string().max(256).nullable(),
  shortDescription: z.string().max(500).nullable(),
  relativePath: z.string().min(1).max(1_024),
  dependencies: z.array(z.object({
    type: z.string().min(1).max(64),
    value: z.string().min(1).max(512),
    description: z.string().max(500).nullable()
  })).max(128).default([]),
  skillhub: z.object({
    coordinate: skillCoordinateSchema,
    version: z.string().min(1).max(128)
  }).nullable().default(null)
});
export type WorkerUserSkill = z.infer<typeof workerUserSkillSchema>;

export const workerUserSkillsReportSchema = z.object({
  skills: z.array(workerUserSkillSchema).max(512),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  scannedAt: z.string().datetime(),
  status: z.enum(["ready", "stale", "error"]),
  truncated: z.boolean().default(false),
  total: z.number().int().nonnegative(),
  errors: z.array(z.string().min(1).max(500)).max(50).default([])
}).superRefine((report, context) => {
  if (report.total < report.skills.length) {
    context.addIssue({ code: "custom", path: ["total"], message: "技能总数不能小于已上报技能数" });
  }
  if (report.truncated !== (report.total > report.skills.length)) {
    context.addIssue({ code: "custom", path: ["truncated"], message: "技能清单截断标记与技能总数不一致" });
  }
  if (report.status === "ready" && report.errors.length > 0) {
    context.addIssue({ code: "custom", path: ["errors"], message: "就绪的技能清单不能包含扫描错误" });
  }
});
export type WorkerUserSkillsReport = z.infer<typeof workerUserSkillsReportSchema>;

export const taskRuntimeSnapshotSchema = z.object({
  skillSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeConfigFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  managedSkills: z.array(taskSkillPackageSchema).max(64),
  userSkills: z.array(workerUserSkillSchema).max(512),
  environmentNames: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(64),
  files: z.array(z.object({
    id: canonicalUuidSchema,
    targetPath: z.string().min(1).max(1_024),
    revision: z.number().int().positive(),
    actualSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    status: z.enum(["applied", "deleted", "unchanged"]),
    error: z.null()
  })).max(40),
  appliedAt: z.string().datetime()
});
export type TaskRuntimeSnapshot = z.infer<typeof taskRuntimeSnapshotSchema>;

export const workspaceRuntimeSyncJobSchema = z.object({
  id: canonicalUuidSchema,
  botAppId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  chatContextId: lowercaseCanonicalUuidSchema,
  workspaceKey: lowercaseCanonicalUuidSchema,
  resolvedWorkspaceAlias: z.string().min(1).max(128),
  leaseToken: z.string().min(1),
  leaseExpiresAt: z.string().datetime(),
  desiredFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  skills: z.array(taskSkillPackageSchema).max(64).default([]),
  skillSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).default("0".repeat(64)),
  runtimeConfig: z.object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    files: z.array(taskRuntimeFileSchema).max(40).default([])
  })
});
export type WorkspaceRuntimeSyncJob = z.infer<typeof workspaceRuntimeSyncJobSchema>;

export const workspaceRuntimeSyncResultSchema = z.object({
  status: z.enum(["applied", "conflict", "failed"]),
  summary: z.string().min(1).max(2_000),
  desiredFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  skillSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeConfigFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(z.object({
    id: canonicalUuidSchema,
    targetPath: z.string().min(1).max(1_024),
    revision: z.number().int().positive(),
    status: z.enum(["applied", "deleted", "unchanged", "conflict", "failed"]),
    actualSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    errorCode: z.string().min(1).max(128).nullable()
  })).max(40)
});
export type WorkspaceRuntimeSyncResult = z.infer<typeof workspaceRuntimeSyncResultSchema>;

export const claimedTaskSchema = z.object({
  id: z.string().uuid(),
  botId: canonicalUuidSchema,
  botAppId: z.string().regex(/^cli_[A-Za-z0-9]+$/),
  botDisplayName: z.string().min(1),
  roleInstructions: z.string().max(20_000),
  botConfigRevision: z.number().int().positive(),
  attentionModel: z.string().max(256).nullable(),
  attentionReasoningEffort: z.string().max(32).nullable(),
  executionModel: z.string().max(256).nullable(),
  executionReasoningEffort: z.string().max(32).nullable(),
  conversationId: z.string().uuid(),
  // Optional while new runners are rolled out ahead of the chat-context control plane.
  // New-mode tasks always provide both UUIDs and keep them identical.
  chatContextId: lowercaseCanonicalUuidSchema.optional(),
  workspaceKey: lowercaseCanonicalUuidSchema.optional(),
  state: z.enum(taskStates),
  leaseToken: z.string(),
  leaseExpiresAt: z.string(),
  requestedWorkspaceAlias: z.string().nullable(),
  resolvedWorkspaceAlias: z.string().min(1),
  requesterId: z.string(),
  requesterRole: z.enum(["owner", "member"]),
  authorization: authorizationGrantSchema,
  codexThreadId: z.string().nullable(),
  chatContextThreadId: z.string().nullable().optional(),
  chatType: z.enum(["p2p", "group"]),
  turnIndex: z.number().int().positive(),
  triggerMessageId: z.string().min(1),
  attentionContext: z.string().max(2_000),
  attachmentPolicy: attachmentPolicySchema,
  skills: z.array(taskSkillPackageSchema).max(64).default([]),
  skillSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/).default("0".repeat(64)),
  runtimeConfig: taskRuntimeConfigSchema,
  roomSeq: z.number().int().nonnegative(),
  signals: z.array(signalSchema)
});
export type ClaimedTask = z.infer<typeof claimedTaskSchema>;

export const attentionResultSchema = z.object({
  decision: z.enum(inboxDecisions),
  priority: z.number().int().min(0).max(100),
  rationale: z.string().max(500)
});
export type AttentionResult = z.infer<typeof attentionResultSchema>;

export const draftSubmissionSchema = z.object({
  content: z.string().min(1).max(100_000),
  baseRoomSeq: z.number().int().nonnegative(),
  force: z.boolean().default(false),
  codexThreadId: z.string().min(1).optional()
});

export const commentaryStreamUpdateSchema = z.object({
  itemId: z.string().min(1).max(256),
  phase: z.literal("commentary"),
  text: z.string().min(1).max(100_000),
  ordinal: z.number().int().positive(),
  baseRoomSeq: z.number().int().nonnegative()
});
export type CommentaryStreamUpdate = z.infer<typeof commentaryStreamUpdateSchema>;

export const taskEventSchema = z.object({
  type: z.string().min(1).max(128),
  summary: z.string().max(2_000),
  payload: z.record(z.string(), z.unknown()).default({})
});

export const approvalRequestSchema = z.object({
  requestId: z.string().min(1).max(256),
  method: z.string().min(1).max(256),
  summary: z.string().min(1).max(2_000),
  payload: z.record(z.string(), z.unknown())
});

export const actionReceiptSchema = z.object({
  actionKey: z.string().min(1).max(256),
  actionType: z.string().min(1).max(128),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.record(z.string(), z.unknown())
});

export const resultSubmissionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    summary: z.string().max(5_000),
    disposition: z.enum(["complete", "awaiting_followup", "unchanged"]).default("complete"),
    processedRoomSeq: z.number().int().nonnegative().default(0),
    dispositionReason: z.string().max(500).default("")
  }),
  z.object({ status: z.literal("failed"), summary: z.string().max(5_000) }),
  z.object({ status: z.literal("waiting_input"), summary: z.string().max(5_000) }),
  z.object({ status: z.literal("human_owned"), summary: z.string().max(5_000) })
]);

export interface LarkMessageEvent {
  type: "im.message.receive_v1";
  event_id: string;
  timestamp: string;
  message_id: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  sender_id: string;
  message_type: string;
  content: string;
  create_time: string;
}

export interface LarkCardActionEvent {
  type: "card.action.trigger";
  event_id: string;
  timestamp: string;
  operator_id: string;
  message_id: string;
  chat_id: string;
  action_tag: string;
  action_value: string;
  token: string;
}

export interface LarkMessageDetails {
  messageId: string;
  rootId: string | null;
  parentId: string | null;
  threadId: string | null;
  chatId: string;
  senderId: string;
  senderType: string;
  messageType: string;
  content: string;
  rawContent?: string;
  createTime: string;
  mentions: Array<{ id: string; idType: string; name: string }>;
}
