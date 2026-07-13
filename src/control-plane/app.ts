import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import staticPlugin from "@fastify/static";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Kysely } from "kysely";
import type { Database } from "../db/types.js";
import {
  approvalRequestSchema,
  actionReceiptSchema,
  commentaryStreamUpdateSchema,
  claimedTaskSchema,
  draftSubmissionSchema,
  resultSubmissionSchema,
  taskEventSchema,
  workerModelCatalogSchema,
  workerRegistrationSchema,
  type InboxDecision
} from "../shared/contracts.js";
import type { ControlPlaneConfig } from "./config.js";
import { issueWorkerSession, readDeviceBearer, requireWorkerSession, verifyDeviceCredential } from "./auth.js";
import { ControlPlaneRepository } from "./repository.js";
import { LarkGateway } from "../lark/gateway.js";
import { EventRouter } from "./event-router.js";
import { DraftService } from "./drafts.js";
import { approvalPolicyDecision } from "./policy.js";
import { AppError, errorMessage } from "../shared/errors.js";
import { registerAdminAuth } from "./admin-auth.js";
import { registerAdminRoutes } from "./admin-routes.js";
import { registerMetrics } from "./metrics.js";
import { AdminEventBus } from "./admin-events.js";
import { RuntimeStatus } from "./runtime-status.js";
import { TaskOutputService } from "./task-output.js";
import { registerAdminFlowRoutes } from "./admin-flow.js";
import { registerRunnerRoutes, RunnerReleaseService } from "./runner-routes.js";
import { BotGatewayRegistry } from "./bot-runtime.js";
import { MessageRouter } from "./message-router.js";
import { BotMessageFanoutService } from "./bot-message-fanout.js";

function leaseToken(request: FastifyRequest): string {
  const value = request.headers["x-lease-token"];
  if (typeof value !== "string" || !value) throw new AppError("missing X-Lease-Token", 401, "missing_lease");
  return value;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

export interface ControlPlaneServices {
  repository: ControlPlaneRepository;
  router: EventRouter;
  drafts: DraftService;
  outputs: TaskOutputService;
  lark: LarkGateway;
  gateways: BotGatewayRegistry;
  adminEvents: AdminEventBus;
  runtime: RuntimeStatus;
  messageRouter: MessageRouter;
  fanout: BotMessageFanoutService;
}

export function buildControlPlane(
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  services?: Partial<ControlPlaneServices>,
  readiness: { isLarkReady(): boolean; runtime?: RuntimeStatus } = { isLarkReady: () => true }
): { app: FastifyInstance; services: ControlPlaneServices } {
  const app = Fastify({
    forceCloseConnections: true,
    logger: { redact: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-lease-token", "body.token", "body.appSecret", "body.content", "body.text", "body.payload", "body.result"] }
  });
  const runtime = services?.runtime ?? readiness.runtime ?? new RuntimeStatus();
  const lark = services?.lark ?? new LarkGateway(config.larkCliPath);
  const gateways = services?.gateways ?? new BotGatewayRegistry(db, config.larkCliPath, services?.lark);
  const repository = services?.repository ?? new ControlPlaneRepository(db, config.leaseSeconds);
  const adminEvents = services?.adminEvents ?? new AdminEventBus();
  const messageRouter = services?.messageRouter ?? new MessageRouter(db);
  const fanout = services?.fanout ?? new BotMessageFanoutService(db, gateways, messageRouter, adminEvents);
  const router = services?.router ?? new EventRouter(db, config, lark, repository, undefined, messageRouter);
  const outputs = services?.outputs ?? new TaskOutputService(db, config, gateways);
  const drafts = services?.drafts ?? new DraftService(db, config, gateways, outputs, fanout);
  const runnerReleases = new RunnerReleaseService(config);
  const runnerManifestTimer = setInterval(() => void runnerReleases.current(true), config.runnerManifestRefreshSeconds * 1_000);
  runnerManifestTimer.unref();
  app.addHook("onClose", async () => clearInterval(runnerManifestTimer));
  const resolvedServices = { repository, router, drafts, outputs, lark, gateways, adminEvents, runtime, messageRouter, fanout };

  void app.register(cookie);

  app.setErrorHandler((error, _request, reply) => {
    const appError = error instanceof AppError ? error : new AppError(errorMessage(error));
    if (appError.statusCode >= 500) app.log.error({ err: error, code: appError.code }, "request failed");
    void reply.status(appError.statusCode).send({ error: { code: appError.code, message: appError.message } });
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/readyz", async () => {
    await db.selectFrom("processed_events").select((eb) => eb.val(1).as("ok")).limit(1).execute();
    if (config.larkEnabled && !readiness.isLarkReady()) throw new AppError("lark consumers are not ready", 503, "lark_not_ready");
    return { ok: true };
  });
  app.get("/", async (_request, reply) => {
    return reply.code(302).header("location", "/admin/").send();
  });

  app.post("/v1/worker-sessions", async (request, reply) => {
    const registration = workerRegistrationSchema.parse(request.body);
    const credentialId = await verifyDeviceCredential(db, registration.executorId, readDeviceBearer(request));
    await repository.upsertWorker(registration);
    adminEvents.publish("worker", registration.executorId);
    const session = await issueWorkerSession(config, {
      executorId: registration.executorId,
      homeRef: registration.homeRef,
      codexProfile: registration.codexProfile,
      configFingerprint: registration.configFingerprint,
      credentialId
    });
    return reply.send({ sessionToken: session.token, expiresAt: session.expiresAt.toISOString() });
  });

  app.post("/v1/workers/model-catalog", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    const body = workerModelCatalogSchema.parse(request.body);
    await db.updateTable("workers").set({
      model_catalog: JSON.stringify(body.models),
      model_catalog_updated_at: new Date(),
      updated_at: new Date()
    }).where("executor_id", "=", principal.executorId).execute();
    adminEvents.publish("worker", principal.executorId);
    return { ok: true };
  });

  app.post("/v1/tasks/claim", async (request, reply) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.touchWorker(principal.executorId);
    adminEvents.publish("worker", principal.executorId);
    const deadline = Date.now() + 25_000;
    do {
      const claimed = await repository.claimTask(principal);
      if (claimed) {
        const conversation = await db.selectFrom("conversations").innerJoin("bots", "bots.id", "conversations.bot_id")
          .select([
            "conversations.room_seq", "conversations.chat_type", "conversations.bot_config_revision", "conversations.role_instructions_snapshot",
            "conversations.attention_model_snapshot", "conversations.attention_reasoning_effort_snapshot",
            "conversations.execution_model_snapshot", "conversations.execution_reasoning_effort_snapshot",
            "bots.app_id", "bots.display_name"
          ])
          .where("conversations.id", "=", claimed.task.conversation_id).executeTakeFirstOrThrow();
        const signals = await repository.taskSignals(claimed.task.id);
        const previous = claimed.task.turn_index > 1
          ? await db.selectFrom("tasks")
              .leftJoin("task_outputs", "task_outputs.task_id", "tasks.id")
              .select(["tasks.disposition_reason", "tasks.conversation_disposition", "task_outputs.current_content"])
              .where("tasks.conversation_id", "=", claimed.task.conversation_id)
              .where("tasks.turn_index", "<", claimed.task.turn_index)
              .orderBy("tasks.turn_index", "desc")
              .executeTakeFirst()
          : null;
        const attentionContext = previous
          ? [
              `上一回合生命周期：${previous.conversation_disposition ?? "未改变"}`,
              `上一回合等待理由：${previous.disposition_reason ?? "未记录"}`,
              `上一回合回复摘要：${String(previous.current_content ?? "").slice(0, 500)}`
            ].join("\n").slice(0, 2_000)
          : "这是会话的首次激活回合。";
        const payload = {
          id: claimed.task.id,
          botId: claimed.task.bot_id,
          botAppId: conversation.app_id,
          botDisplayName: conversation.display_name,
          roleInstructions: conversation.role_instructions_snapshot,
          botConfigRevision: conversation.bot_config_revision,
          attentionModel: conversation.attention_model_snapshot,
          attentionReasoningEffort: conversation.attention_reasoning_effort_snapshot,
          executionModel: conversation.execution_model_snapshot,
          executionReasoningEffort: conversation.execution_reasoning_effort_snapshot,
          conversationId: claimed.task.conversation_id,
          state: claimed.task.state,
          leaseToken: claimed.leaseToken,
          leaseExpiresAt: claimed.leaseExpiresAt.toISOString(),
          requestedWorkspaceAlias: claimed.task.requested_workspace_alias,
          resolvedWorkspaceAlias: claimed.task.resolved_workspace_alias,
          requesterId: claimed.task.requester_id,
          requesterRole: claimed.task.requester_role,
          authorization: claimed.task.authorization_grant,
          codexThreadId: claimed.task.codex_thread_id,
          chatType: conversation.chat_type,
          turnIndex: claimed.task.turn_index,
          triggerMessageId: claimed.task.trigger_message_id,
          attentionContext,
          roomSeq: conversation.room_seq,
          signals: signals.map((signal) => ({
            id: signal.id,
            taskId: signal.task_id,
            seq: signal.seq,
            senderId: signal.sender_id,
            senderRole: signal.sender_role,
            senderType: signal.sender_type,
            senderBotId: signal.sender_bot_id,
            senderDisplayName: signal.sender_display_name,
            ingressSource: signal.ingress_source,
            originMessageId: signal.origin_message_id,
            botDialogueDepth: signal.bot_dialogue_depth,
            messageId: signal.message_id,
            messageType: signal.message_type,
            content: signal.content,
            preview: signal.preview,
            priority: signal.priority,
            decision: signal.decision,
            createdAt: iso(signal.created_at)
          }))
        };
        const validated = claimedTaskSchema.safeParse(payload);
        if (!validated.success) {
          const detail = validated.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
          await repository.rejectInvalidClaim(claimed.task.id, claimed.leaseToken, detail);
          adminEvents.publish("task", claimed.task.id);
          continue;
        }
        return reply.send(validated.data);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    } while (Date.now() < deadline);
    return reply.status(204).send();
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/heartbeat", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    const heartbeat = await repository.heartbeat(request.params.id, principal.executorId, leaseToken(request));
    return { leaseExpiresAt: heartbeat.leaseExpiresAt.toISOString(), state: heartbeat.state };
  });

  app.get<{ Params: { id: string }; Querystring: { after_seq?: string } }>("/v1/tasks/:id/signals", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const afterSeq = Number.parseInt(request.query.after_seq ?? "0", 10);
    const signals = await repository.taskSignals(request.params.id, Number.isFinite(afterSeq) ? afterSeq : 0);
    return {
      signals: signals.map((signal) => ({
        id: signal.id,
        taskId: signal.task_id,
        seq: signal.seq,
        senderId: signal.sender_id,
        senderRole: signal.sender_role,
        senderType: signal.sender_type,
        senderBotId: signal.sender_bot_id,
        senderDisplayName: signal.sender_display_name,
        ingressSource: signal.ingress_source,
        originMessageId: signal.origin_message_id,
        botDialogueDepth: signal.bot_dialogue_depth,
        messageId: signal.message_id,
        messageType: signal.message_type,
        content: signal.content,
        preview: signal.preview,
        priority: signal.priority,
        decision: signal.decision,
        createdAt: iso(signal.created_at)
      }))
    };
  });

  app.post<{ Params: { id: string; signalId: string } }>("/v1/tasks/:id/signals/:signalId/decision", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const body = request.body as { decision?: InboxDecision; rationale?: string; priority?: number };
    if (!body.decision || !["consume", "defer", "dismiss", "merge"].includes(body.decision)) {
      throw new AppError("invalid inbox decision", 400, "invalid_decision");
    }
    await repository.decideSignal(request.params.id, request.params.signalId, body.decision, body.rationale ?? "", body.priority ?? 50);
    adminEvents.publish("task", request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/events", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const event = taskEventSchema.parse(request.body);
    await repository.recordTaskEvent(request.params.id, event.type, event.summary, event.payload);
    if (event.type === "codex.thread" && typeof event.payload.threadId === "string") {
      await repository.updateTaskThread(request.params.id, event.payload.threadId);
    }
    adminEvents.publish("task", request.params.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/stream", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const update = commentaryStreamUpdateSchema.parse(request.body);
    const result = await outputs.streamCommentary(request.params.id, update);
    adminEvents.publish("task", request.params.id);
    return result;
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/drafts", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const draft = draftSubmissionSchema.parse(request.body);
    if (draft.codexThreadId) await repository.updateTaskThread(request.params.id, draft.codexThreadId);
    const result = await drafts.submit(request.params.id, draft.content, draft.baseRoomSeq, draft.force);
    adminEvents.publish("task", request.params.id);
    return result;
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/approvals", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const body = approvalRequestSchema.parse(request.body);
    const authorization = await repository.taskAuthorization(request.params.id);
    const automaticDecision = approvalPolicyDecision(body.method, body.summary, authorization.grant, authorization.role);
    const approval = await repository.createApproval(request.params.id, body.requestId, body.method, body.summary, body.payload, automaticDecision);
    if (approval.state === "pending") {
      await outputs.showStatus(request.params.id, `等待主人审批：${body.summary}`);
    }
    adminEvents.publish("approval", approval.id);
    return { id: approval.id, state: approval.state, expiresAt: iso(approval.expires_at) };
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/actions", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const body = actionReceiptSchema.parse(request.body);
    await repository.recordActionReceipt(request.params.id, body.actionKey, body.actionType, body.requestDigest, body.result);
    adminEvents.publish("task", request.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string; approvalId: string } }>("/v1/tasks/:id/approvals/:approvalId", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const approval = await repository.getApproval(request.params.id, request.params.approvalId);
    return { id: approval.id, state: approval.state, decidedAt: approval.decided_at ? iso(approval.decided_at) : null };
  });

  app.post<{ Params: { id: string } }>("/v1/tasks/:id/result", async (request) => {
    const principal = await requireWorkerSession(db, config, request);
    await repository.assertLease(request.params.id, principal.executorId, leaseToken(request));
    const result = resultSubmissionSchema.parse(request.body);
    const lifecycle = result.status === "completed"
      ? { disposition: result.disposition, processedRoomSeq: result.processedRoomSeq, reason: result.dispositionReason }
      : undefined;
    const completed = await repository.finishTask(request.params.id, result.status, result.summary, lifecycle);
    if (result.status === "failed") await outputs.showStatus(request.params.id, `处理失败：${result.summary}`);
    if (result.status === "human_owned") await outputs.showStatus(request.params.id, "已暂停自动执行，等待本机 Codex App 接手。");
    adminEvents.publish("task", request.params.id);
    if (completed.nextTaskId) adminEvents.publish("task", completed.nextTaskId);
    return { ok: true, nextTaskId: completed.nextTaskId };
  });

  registerAdminAuth(app, db, config);
  registerRunnerRoutes(app, db, config, runnerReleases, adminEvents);
  registerAdminRoutes(app, db, config, { repository, lark, gateways, events: adminEvents, runtime, fanout });
  registerAdminFlowRoutes(app, db, config, runtime);
  registerMetrics(app, db, config, runtime);

  const adminRoot = resolve(process.cwd(), "admin-dist");
  const adminAssets = resolve(adminRoot, "assets");
  if (existsSync(adminAssets)) {
    void app.register(staticPlugin, { root: adminAssets, prefix: "/admin/assets/", decorateReply: false });
  }
  const sendAdmin = async (request: FastifyRequest, reply: import("fastify").FastifyReply) => {
    if (!existsSync(resolve(adminRoot, "index.html"))) throw new AppError("运维后台尚未构建", 503, "admin_ui_unavailable");
    reply.type("text/html; charset=utf-8").header("cache-control", "no-store");
    const forwardedPrefix = typeof request.headers["x-forwarded-prefix"] === "string"
      && /^\/[A-Za-z0-9/_-]*$/.test(request.headers["x-forwarded-prefix"])
      ? request.headers["x-forwarded-prefix"].replace(/\/+$/, "")
      : "";
    const html = await readFile(resolve(adminRoot, "index.html"), "utf8");
    return html.replace("<head>", `<head><base href="${forwardedPrefix}/admin/">`);
  };
  app.get("/admin", async (_request, reply) => reply.code(302).header("location", "/admin/").send());
  app.get("/admin/", sendAdmin);
  app.get("/admin/*", sendAdmin);

  return { app, services: resolvedServices };
}
