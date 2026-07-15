import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError, errorMessage } from "../shared/errors.js";
import type { ControlPlaneConfig } from "./config.js";
import { requireAdmin, requireCsrf } from "./admin-auth.js";
import { BotGatewayRegistry, LarkProfileStore } from "./bot-runtime.js";
import { LarkGateway } from "../lark/gateway.js";
import { BotPermissionService, type BotPermissionCheck } from "./bot-permissions.js";
import type { RuntimeStatus } from "./runtime-status.js";
import type { AdminEventBus } from "./admin-events.js";

const createSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  appId: z.string().trim().regex(/^cli_[A-Za-z0-9]+$/),
  appSecret: z.string().min(8).max(512),
  roleInstructions: z.string().max(20_000).default(""),
  defaultExecutorId: z.string().max(128).nullable().default(null),
  defaultWorkspaceAlias: z.string().max(128).nullable().default(null),
  attentionModel: z.string().trim().min(1).max(256).nullable().default(null),
  attentionReasoningEffort: z.string().trim().min(1).max(32).nullable().default(null),
  executionModel: z.string().trim().min(1).max(256).nullable().default(null),
  executionReasoningEffort: z.string().trim().min(1).max(32).nullable().default(null)
});
const updateSchema = z.object({
  displayName: z.string().trim().min(1).max(64),
  roleInstructions: z.string().max(20_000),
  defaultExecutorId: z.string().max(128).nullable(),
  defaultWorkspaceAlias: z.string().max(128).nullable(),
  attentionModel: z.string().trim().min(1).max(256).nullable(),
  attentionReasoningEffort: z.string().trim().min(1).max(32).nullable(),
  executionModel: z.string().trim().min(1).max(256).nullable(),
  executionReasoningEffort: z.string().trim().min(1).max(32).nullable()
});
const commandSchema = z.object({ command: z.enum(["enable", "disable", "set_system", "reconnect"]) });
const credentialSchema = z.object({ appSecret: z.string().min(8).max(512) });
const bindingsSchema = z.object({ bindings: z.array(z.object({
  chatId: z.string().min(1).max(128), chatName: z.string().max(256).nullable().default(null), enabled: z.boolean().default(true),
  preferredExecutorId: z.string().max(128).nullable().default(null), workspaceAlias: z.string().max(128).nullable().default(null)
})).max(500) });

export interface BotRuntimeController {
  reconcile(botId: string): Promise<void>;
  suspend(botId: string): Promise<void>;
}

export function registerBotAdminRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  dependencies: { gateways: BotGatewayRegistry; runtime: RuntimeStatus; events: AdminEventBus; controller: BotRuntimeController; permissions?: BotPermissionService }
): void {
  const profiles = new LarkProfileStore(config.larkCliPath);
  const permissions = dependencies.permissions ?? new BotPermissionService(async (profileName) => (
    new LarkGateway(config.larkCliPath, undefined, profileName).listGrantedScopes()
  ));
  const persistPermissionCheck = async (botId: string, check: BotPermissionCheck) => {
    await db.updateTable("bots").set({
      permission_state: check.state,
      permission_check: JSON.stringify(check),
      permission_checked_at: new Date(check.checkedAt),
      updated_at: new Date()
    }).where("id", "=", botId).execute();
  };
  const checkBotPermissions = async (bot: { id: string; profile_name: string | null }) => {
    const check = await permissions.check(bot.profile_name);
    await persistPermissionCheck(bot.id, check);
    return check;
  };
  const requireCompletePermissions = async (bot: { id: string; profile_name: string | null }) => {
    const check = await checkBotPermissions(bot);
    if (check.ok) return check;
    const missing = check.items.filter((item) => item.status === "missing").map((item) => item.label);
    throw new AppError(
      check.state === "error" ? `应用权限检测失败：${check.error ?? "未知错误"}` : `应用权限不完整：${missing.join("、")}`,
      409,
      check.state === "error" ? "bot_permission_check_failed" : "bot_permissions_missing"
    );
  };
  const validateExecutionRoute = async (executorId: string | null, workspaceAlias: string | null) => {
    if (!executorId && !workspaceAlias) return;
    const workers = await db.selectFrom("workers").select(["executor_id", "workspace_aliases"]).where("deleted_at", "is", null).execute();
    const candidates = executorId ? workers.filter((worker) => worker.executor_id === executorId) : workers;
    if (executorId && !candidates.length) throw new AppError("默认执行器不存在", 409, "bot_executor_not_found");
    const selectedAliases = Array.isArray(candidates[0]?.workspace_aliases) ? candidates[0].workspace_aliases.map(String) : [];
    if (executorId && !workspaceAlias && selectedAliases.length !== 1) {
      throw new AppError("该执行器声明了多个总工作区，请明确选择一个", 409, "bot_workspace_required");
    }
    if (workspaceAlias && !candidates.some((worker) => Array.isArray(worker.workspace_aliases) && worker.workspace_aliases.map(String).includes(workspaceAlias))) {
      throw new AppError("所选执行器未声明该总工作区", 409, "bot_workspace_unavailable");
    }
  };
  const view = async (botId: string) => {
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", botId).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot) throw new AppError("机器人不存在", 404, "bot_not_found");
    const [bindings, activeConversations, activeTasks, enabledWorkers] = await Promise.all([
      db.selectFrom("bot_chat_bindings").selectAll().where("bot_id", "=", bot.id).orderBy("chat_name").execute(),
      db.selectFrom("conversations").select(sql<number>`count(*)::int`.as("count")).where("bot_id", "=", bot.id).where("active", "=", true).executeTakeFirstOrThrow(),
      db.selectFrom("tasks").select(sql<number>`count(*)::int`.as("count")).where("bot_id", "=", bot.id).where("state", "in", ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"]).executeTakeFirstOrThrow(),
      db.selectFrom("workers").select(["executor_id", "workspace_aliases"]).where("deleted_at", "is", null).where("operational_mode", "=", "enabled").execute()
    ]);
    const eligibleWorkers = enabledWorkers.filter((worker) => {
      const aliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
      return bot.default_workspace_alias ? aliases.includes(bot.default_workspace_alias) : aliases.length === 1;
    });
    const runtime = dependencies.runtime.snapshot([`${bot.id}:message`, `${bot.id}:card`]);
    const messageRuntime = runtime[`${bot.id}:message`];
    const permissionCheck = bot.permission_check && typeof bot.permission_check === "object" ? bot.permission_check : null;
    const eventSubscription = !bot.enabled
      ? { state: "disabled", label: "机器人已停用，未验证消息事件订阅" }
      : messageRuntime?.ready
        ? { state: "ready", label: "im.message.receive_v1 长连接正常" }
        : messageRuntime?.state === "error"
          ? { state: "error", label: "消息事件未就绪", error: messageRuntime.lastError ?? null }
          : { state: "pending", label: "正在等待消息长连接就绪" };
    return {
      id: bot.id, appId: bot.app_id, displayName: bot.display_name, roleInstructions: bot.role_instructions,
      ownerBound: Boolean(bot.owner_open_id), defaultExecutorId: bot.default_executor_id, defaultWorkspaceAlias: bot.default_workspace_alias,
      attentionModel: bot.attention_model, attentionReasoningEffort: bot.attention_reasoning_effort,
      executionModel: bot.execution_model, executionReasoningEffort: bot.execution_reasoning_effort,
      routeWarning: !bot.default_executor_id && eligibleWorkers.length > 1 ? "存在多个可用执行器，请明确绑定默认执行器" : null,
      enabled: bot.enabled, isSystem: bot.is_system, configRevision: bot.config_revision, credentialState: bot.credential_state,
      credentialError: bot.credential_error, credentialsConfigured: true,
      permissionState: bot.permission_state, permissionCheck, permissionCheckedAt: bot.permission_checked_at ? new Date(bot.permission_checked_at).toISOString() : null,
      eventSubscription, runtime, bindings: bindings.map((item) => ({
        chatId: item.chat_id, chatName: item.chat_name, enabled: item.enabled, preferredExecutorId: item.preferred_executor_id, workspaceAlias: item.workspace_alias
      })), credentialRotatable: Boolean(bot.profile_name), activeConversations: activeConversations.count, activeTasks: activeTasks.count,
      createdAt: new Date(bot.created_at).toISOString(), updatedAt: new Date(bot.updated_at).toISOString()
    };
  };

  app.get("/v1/admin/bots", async (request) => {
    await requireAdmin(db, config, request);
    const rows = await db.selectFrom("bots").select("id").where("deleted_at", "is", null).orderBy("display_name").execute();
    return { items: await Promise.all(rows.map((row) => view(row.id))) };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/bots/:id", async (request) => {
    await requireAdmin(db, config, request);
    return view(request.params.id);
  });

  app.post("/v1/admin/bots", async (request, reply) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const body = createSchema.parse(request.body);
    if (await db.selectFrom("bots").select("id").where("app_id", "=", body.appId).where("deleted_at", "is", null).executeTakeFirst()) throw new AppError("该 App ID 已绑定", 409, "bot_exists");
    await validateExecutionRoute(body.defaultExecutorId, body.defaultWorkspaceAlias);
    const profileName = `bot-${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    await profiles.add(profileName, body.appId, body.appSecret);
    try {
      const permissionCheck = await permissions.check(profileName);
      const systemExists = await db.selectFrom("bots").select("id").where("is_system", "=", true).where("deleted_at", "is", null).executeTakeFirst();
      const bot = await db.insertInto("bots").values({
        app_id: body.appId, profile_name: profileName, bot_open_id: body.appId, display_name: body.displayName,
        role_instructions: body.roleInstructions, owner_open_id: null, default_executor_id: body.defaultExecutorId,
        default_workspace_alias: body.defaultWorkspaceAlias,
        attention_model: body.attentionModel, attention_reasoning_effort: body.attentionReasoningEffort,
        execution_model: body.executionModel, execution_reasoning_effort: body.executionReasoningEffort,
        enabled: permissionCheck.ok, is_system: !systemExists, config_revision: 1,
        credential_state: "verified", credential_error: null,
        permission_state: permissionCheck.state, permission_check: JSON.stringify(permissionCheck), permission_checked_at: new Date(permissionCheck.checkedAt),
        deleted_at: null, updated_at: new Date()
      }).returning("id").executeTakeFirstOrThrow();
      if (permissionCheck.ok) await dependencies.controller.reconcile(bot.id);
      dependencies.events.publish("bot", bot.id);
      return reply.code(201).send(await view(bot.id));
    } catch (error) {
      await profiles.remove(profileName).catch(() => undefined);
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>("/v1/admin/bots/:id", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const body = updateSchema.parse(request.body);
    await validateExecutionRoute(body.defaultExecutorId, body.defaultWorkspaceAlias);
    const updated = await db.updateTable("bots").set({
      display_name: body.displayName, role_instructions: body.roleInstructions, default_executor_id: body.defaultExecutorId,
      default_workspace_alias: body.defaultWorkspaceAlias,
      attention_model: body.attentionModel, attention_reasoning_effort: body.attentionReasoningEffort,
      execution_model: body.executionModel, execution_reasoning_effort: body.executionReasoningEffort,
      config_revision: sql`config_revision + 1`, updated_at: new Date()
    }).where("id", "=", request.params.id).where("deleted_at", "is", null).returning("id").executeTakeFirst();
    if (!updated) throw new AppError("机器人不存在", 404, "bot_not_found");
    await dependencies.controller.reconcile(updated.id);
    dependencies.events.publish("bot", updated.id);
    return view(updated.id);
  });

  app.post<{ Params: { id: string } }>("/v1/admin/bots/:id/commands", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const body = commandSchema.parse(request.body);
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot) throw new AppError("机器人不存在", 404, "bot_not_found");
    if (body.command === "disable" && bot.is_system) throw new AppError("请先指定其他系统通知机器人", 409, "system_bot_required");
    if (body.command === "reconnect" && !bot.enabled) throw new AppError("机器人已停用，请先重新启用", 409, "bot_disabled");
    if (body.command === "enable" || body.command === "set_system") await requireCompletePermissions(bot);
    if (body.command === "set_system") {
      await db.transaction().execute(async (trx) => {
        await trx.updateTable("bots").set({ is_system: false, updated_at: new Date() }).where("is_system", "=", true).execute();
        await trx.updateTable("bots").set({ is_system: true, enabled: true, updated_at: new Date() }).where("id", "=", bot.id).execute();
      });
    } else if (body.command !== "reconnect") {
      await db.updateTable("bots").set({ enabled: body.command === "enable", updated_at: new Date() }).where("id", "=", bot.id).execute();
    }
    await dependencies.controller.reconcile(bot.id);
    dependencies.events.publish("bot", bot.id);
    return view(bot.id);
  });

  app.post<{ Params: { id: string } }>("/v1/admin/bots/:id/permission-check", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot) throw new AppError("机器人不存在", 404, "bot_not_found");
    const check = await checkBotPermissions(bot);
    if (check.ok && bot.enabled) await dependencies.controller.reconcile(bot.id);
    dependencies.events.publish("bot", bot.id);
    return view(bot.id);
  });

  app.post<{ Params: { id: string } }>("/v1/admin/bots/:id/credentials", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const body = credentialSchema.parse(request.body);
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot?.profile_name) throw new AppError("默认导入机器人需先转换为独立 profile", 409, "legacy_profile");
    await dependencies.controller.suspend(bot.id);
    try {
      await profiles.rotate(bot.profile_name, bot.app_id, body.appSecret);
      const permissionCheck = await permissions.check(bot.profile_name);
      await db.updateTable("bots").set({
        credential_state: "verified", credential_error: null,
        permission_state: permissionCheck.state, permission_check: JSON.stringify(permissionCheck), permission_checked_at: new Date(permissionCheck.checkedAt),
        updated_at: new Date()
      }).where("id", "=", bot.id).execute();
    } catch (error) {
      const restored = await profiles.verify(bot.profile_name, bot.app_id).then(() => true).catch(() => false);
      await db.updateTable("bots").set({ credential_state: restored ? "verified" : "error", credential_error: restored ? null : errorMessage(error).slice(0, 500), updated_at: new Date() }).where("id", "=", bot.id).execute();
      throw error;
    } finally {
      dependencies.gateways.invalidate(bot.id);
      await dependencies.controller.reconcile(bot.id);
    }
    return view(bot.id);
  });

  app.post<{ Params: { id: string } }>("/v1/admin/bots/:id/owner-binding", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const bot = await db.selectFrom("bots").select("id").where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot) throw new AppError("机器人不存在", 404, "bot_not_found");
    const token = randomToken(32);
    await db.deleteFrom("bot_owner_binding_tokens").where("bot_id", "=", bot.id).where("consumed_at", "is", null).execute();
    await db.insertInto("bot_owner_binding_tokens").values({ token_hash: sha256(token), bot_id: bot.id, expires_at: new Date(Date.now() + 10 * 60_000), consumed_at: null }).execute();
    return { command: `/绑定控制台 ${token}`, expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/bots/:id/chats", async (request) => {
    await requireAdmin(db, config, request);
    const chats = await (await dependencies.gateways.gateway(request.params.id)).listJoinedChats();
    const bindings = await db.selectFrom("bot_chat_bindings").selectAll().where("bot_id", "=", request.params.id).execute();
    return { items: chats.map((chat) => {
      const binding = bindings.find((item) => item.chat_id === chat.chatId);
      return { ...chat, bound: binding?.enabled ?? false, preferredExecutorId: binding?.preferred_executor_id ?? null, workspaceAlias: binding?.workspace_alias ?? null };
    }) };
  });

  app.put<{ Params: { id: string } }>("/v1/admin/bots/:id/chat-bindings", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const body = bindingsSchema.parse(request.body);
    await Promise.all(body.bindings.map((binding) => validateExecutionRoute(binding.preferredExecutorId, binding.workspaceAlias)));
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom("bot_chat_bindings").where("bot_id", "=", request.params.id).execute();
      if (body.bindings.length) await trx.insertInto("bot_chat_bindings").values(body.bindings.map((item) => ({
        bot_id: request.params.id, chat_id: item.chatId, chat_name: item.chatName, enabled: item.enabled,
        preferred_executor_id: item.preferredExecutorId, workspace_alias: item.workspaceAlias, updated_at: new Date()
      }))).execute();
    });
    dependencies.events.publish("bot", request.params.id);
    return view(request.params.id);
  });

  app.delete<{ Params: { id: string } }>("/v1/admin/bots/:id", async (request) => {
    const principal = await requireAdmin(db, config, request); requireCsrf(request, principal);
    const bot = await db.selectFrom("bots").selectAll().where("id", "=", request.params.id).where("deleted_at", "is", null).executeTakeFirst();
    if (!bot) throw new AppError("机器人不存在", 404, "bot_not_found");
    if (bot.enabled || bot.is_system) throw new AppError("请先停用机器人并切换系统通知机器人", 409, "bot_not_disabled");
    const activeSkill = await db.selectFrom("bot_skill_bindings").select("id").where("bot_id", "=", bot.id).where("deleted_at", "is", null).executeTakeFirst();
    if (activeSkill) throw new AppError("机器人仍有受控技能；请先逐个移除技能并等待工作区文件清理完成", 409, "bot_has_skills");
    const [activeConversation, activeTasks, pendingOutbox] = await Promise.all([
      db.selectFrom("conversations").select("id").where("bot_id", "=", bot.id).where("active", "=", true).executeTakeFirst(),
      db.selectFrom("tasks").select("id").where("bot_id", "=", bot.id).where("state", "in", ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"]).executeTakeFirst(),
      db.selectFrom("outbox_messages").innerJoin("tasks", "tasks.id", "outbox_messages.task_id").select("outbox_messages.id").where("tasks.bot_id", "=", bot.id).where("outbox_messages.state", "in", ["pending", "unknown"]).executeTakeFirst()
    ]);
    if (activeConversation || activeTasks || pendingOutbox) throw new AppError("机器人仍有活跃会话、关联任务或待核查发件箱", 409, "bot_in_use");
    await dependencies.controller.suspend(bot.id);
    await profiles.remove(bot.profile_name);
    await db.updateTable("bots").set({ deleted_at: new Date(), updated_at: new Date() }).where("id", "=", bot.id).execute();
    dependencies.gateways.invalidate(bot.id);
    dependencies.events.publish("bot", bot.id);
    return { ok: true };
  });
}
