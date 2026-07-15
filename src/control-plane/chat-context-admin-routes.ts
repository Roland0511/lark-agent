import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { z } from "zod";
import type { Database } from "../db/types.js";
import { AppError } from "../shared/errors.js";
import { requireAdmin, requireCsrf } from "./admin-auth.js";
import type { ControlPlaneConfig } from "./config.js";
import type { AdminEventBus } from "./admin-events.js";

const listQuerySchema = z.object({
  // Keep legacy bootstrap IDs filterable even when their UUID version nibble is 0.
  bot: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).optional(),
  chatType: z.enum(["group", "p2p"]).optional(),
  state: z.enum(["uninitialized", "ready", "blocked"]).optional(),
  q: z.string().trim().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100)
});
const chatContextIdSchema = z.string().uuid();

export interface ChatContextRecoveryCheck {
  key: "thread" | "executor" | "claimable" | "capability" | "homeIdentity" | "profile" | "workspaceAlias" | "configFingerprint";
  label: string;
  state: "pass" | "fail";
  detail: string;
}

interface RecoveryContextSnapshot {
  codex_thread_id: string | null;
  thread_consistent?: boolean;
  executor_id: string | null;
  executor_home_ref: string | null;
  executor_profile: string | null;
  executor_config_fingerprint: string | null;
  workspace_root_alias: string | null;
}

interface RecoveryWorkerSnapshot {
  executor_id: string;
  home_ref: string;
  codex_profile: string;
  config_fingerprint: string;
  workspace_aliases: unknown;
  capabilities: unknown;
  operational_mode: "enabled" | "maintenance" | "disabled";
  deleted_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

export function redactAbsoluteLocalPath(value: string | null): string | null {
  if (!value) return null;
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value) ? "已配置（本机路径已隐藏）" : value;
}

export function parseChatContextId(value: string): string {
  const parsed = chatContextIdSchema.safeParse(value);
  if (!parsed.success) throw new AppError("Chat Context ID 格式无效", 400, "invalid_chat_context_id");
  return parsed.data;
}

export function parseChatContextListQuery(value: unknown): z.infer<typeof listQuerySchema> {
  const parsed = listQuerySchema.safeParse(value);
  if (!parsed.success) throw new AppError("聊天记忆筛选条件格式无效", 400, "invalid_chat_context_filter");
  return parsed.data;
}

function check(
  key: ChatContextRecoveryCheck["key"],
  label: string,
  passed: boolean,
  passDetail: string,
  failDetail: string
): ChatContextRecoveryCheck {
  return { key, label, state: passed ? "pass" : "fail", detail: passed ? passDetail : failDetail };
}

/** Builds public, human-readable checks without echoing local paths or identity fingerprints. */
export function buildChatContextRecoveryChecks(
  context: RecoveryContextSnapshot,
  worker: RecoveryWorkerSnapshot | null
): ChatContextRecoveryCheck[] {
  const capabilities = Array.isArray(worker?.capabilities) ? worker.capabilities.map(String) : [];
  const workspaceAliases = Array.isArray(worker?.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
  const hasExecutorBinding = Boolean(context.executor_id?.trim());
  const executorExists = Boolean(hasExecutorBinding && worker);
  const executorActive = Boolean(executorExists && !worker?.deleted_at);
  const executorClaimable = Boolean(executorActive && worker?.operational_mode === "enabled");
  const homeMatches = Boolean(
    executorActive && context.executor_home_ref && worker?.home_ref === context.executor_home_ref
  );
  const profileMatches = Boolean(
    executorActive && context.executor_profile && worker?.codex_profile === context.executor_profile
  );
  const fingerprintMatches = Boolean(
    executorActive && context.executor_config_fingerprint && worker?.config_fingerprint === context.executor_config_fingerprint
  );
  const workspaceMatches = Boolean(
    executorActive && context.workspace_root_alias && workspaceAliases.includes(context.workspace_root_alias)
  );

  return [
    check(
      "thread",
      "原 Thread",
      Boolean(context.codex_thread_id?.trim()) && context.thread_consistent !== false,
      "原 Thread 已记录，关联任务未出现替代 Thread",
      context.codex_thread_id?.trim() ? "关联任务出现不同 Thread，不能安全解除阻塞" : "未记录可恢复的原 Thread"
    ),
    check(
      "executor",
      "原执行器",
      executorActive,
      "原执行器存在且未删除",
      !hasExecutorBinding ? "原绑定未记录执行器" : !executorExists ? "原执行器不存在" : "原执行器已删除"
    ),
    check("claimable", "领取状态", executorClaimable, "原执行器当前可领取任务", "原执行器当前未启用，无法领取任务"),
    check(
      "capability",
      "永久聊天记忆能力",
      executorActive && capabilities.includes("chat_context_v1"),
      "原执行器支持永久聊天记忆",
      "原执行器尚不支持永久聊天记忆"
    ),
    check("homeIdentity", "Home 身份", homeMatches, "Home 身份与原绑定一致", "Home 身份与原绑定不一致或缺失"),
    check("profile", "Codex Profile", profileMatches, "Codex Profile 与原绑定一致", "Codex Profile 与原绑定不一致或缺失"),
    check("workspaceAlias", "工作区别名", workspaceMatches, "原工作区别名仍可用", "原工作区别名在执行器当前配置中不存在"),
    check("configFingerprint", "配置指纹", fingerprintMatches, "配置指纹与原绑定一致", "配置指纹与原绑定不一致或缺失")
  ];
}

function publicContext(row: {
  id: string;
  bot_id: string;
  bot_app_id: string;
  bot_display_name: string;
  chat_id: string;
  chat_type: string;
  chat_name: string | null;
  codex_thread_id: string | null;
  executor_id: string | null;
  executor_profile: string | null;
  executor_config_fingerprint: string | null;
  codex_version: string | null;
  workspace_root_alias: string | null;
  state: string;
  blocked_reason: string | null;
  last_activity_at: Date | string;
  last_compacted_at: Date | string | null;
  auto_compaction_count: number;
  created_at: Date | string;
  updated_at: Date | string;
}) {
  return {
    id: row.id,
    workspaceKey: row.id,
    botId: row.bot_id,
    botAppId: row.bot_app_id,
    botDisplayName: row.bot_display_name,
    chatId: row.chat_id,
    chatType: row.chat_type,
    chatName: row.chat_name,
    threadId: row.codex_thread_id,
    executorId: row.executor_id,
    executorProfile: row.executor_profile,
    executorConfigFingerprint: row.executor_config_fingerprint ? "已记录（值已隐藏）" : null,
    codexVersion: row.codex_version,
    workspaceRootAlias: redactAbsoluteLocalPath(row.workspace_root_alias),
    state: row.state,
    blockedReason: row.blocked_reason ? "长期绑定已阻塞，请查看关联任务诊断。" : null,
    lastActivityAt: iso(row.last_activity_at),
    lastCompactedAt: iso(row.last_compacted_at),
    autoCompactionCount: Number(row.auto_compaction_count),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at)
  };
}

/** Registers admin views and guarded recovery for permanent bot+chat Codex bindings. */
export function registerChatContextAdminRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  config: ControlPlaneConfig,
  events: AdminEventBus
): void {
  const baseQuery = () => db.selectFrom("chat_contexts")
    .innerJoin("bots", "bots.id", "chat_contexts.bot_id")
    .leftJoin("bot_chat_bindings", (join) => join
      .onRef("bot_chat_bindings.bot_id", "=", "chat_contexts.bot_id")
      .onRef("bot_chat_bindings.chat_id", "=", "chat_contexts.chat_id"))
    .select([
      "chat_contexts.id", "chat_contexts.bot_id", "bots.app_id as bot_app_id", "bots.display_name as bot_display_name",
      "chat_contexts.chat_id", "chat_contexts.chat_type", "bot_chat_bindings.chat_name",
      "chat_contexts.codex_thread_id", "chat_contexts.executor_id", "chat_contexts.executor_profile",
      "chat_contexts.executor_config_fingerprint", "chat_contexts.codex_version", "chat_contexts.workspace_root_alias",
      "chat_contexts.state", "chat_contexts.blocked_reason", "chat_contexts.last_activity_at",
      "chat_contexts.last_compacted_at", "chat_contexts.auto_compaction_count", "chat_contexts.created_at", "chat_contexts.updated_at"
    ]);

  const filteredQuery = (queryParams: z.infer<typeof listQuerySchema>) => {
    let query = baseQuery().where("bots.deleted_at", "is", null);
    if (queryParams.bot) query = query.where("chat_contexts.bot_id", "=", queryParams.bot);
    if (queryParams.chatType) query = query.where("chat_contexts.chat_type", "=", queryParams.chatType);
    if (queryParams.state) query = query.where("chat_contexts.state", "=", queryParams.state);
    if (queryParams.q) {
      const needle = `%${queryParams.q.replace(/[%_]/g, "")}%`;
      query = query.where(sql<boolean>`(
        chat_contexts.chat_id ILIKE ${needle}
        OR COALESCE(bot_chat_bindings.chat_name, '') ILIKE ${needle}
        OR COALESCE(chat_contexts.codex_thread_id, '') ILIKE ${needle}
        OR bots.display_name ILIKE ${needle}
      )`);
    }
    return query;
  };

  app.get<{ Querystring: { bot?: string; chatType?: string; state?: string; q?: string; limit?: string } }>("/v1/admin/chat-contexts", async (request) => {
    await requireAdmin(db, config, request);
    const queryParams = parseChatContextListQuery(request.query);
    const filtered = filteredQuery(queryParams);
    const [rows, summary] = await Promise.all([
      filtered.orderBy("chat_contexts.last_activity_at", "desc").orderBy("chat_contexts.id", "desc").limit(queryParams.limit).execute(),
      db.selectFrom(filtered.as("filtered")).select([
        sql<number>`count(*)::int`.as("total"),
        sql<number>`count(*) filter (where filtered.state = 'ready')::int`.as("ready"),
        sql<number>`count(*) filter (where filtered.state = 'blocked')::int`.as("blocked"),
        sql<number>`count(*) filter (where filtered.state = 'uninitialized')::int`.as("uninitialized"),
        sql<Date | null>`max(filtered.last_activity_at)`.as("last_activity_at")
      ]).executeTakeFirstOrThrow()
    ]);
    return {
      items: rows.map(publicContext),
      summary: {
        total: Number(summary.total),
        ready: Number(summary.ready),
        blocked: Number(summary.blocked),
        uninitialized: Number(summary.uninitialized),
        lastActivityAt: iso(summary.last_activity_at)
      }
    };
  });

  app.get<{ Params: { id: string } }>("/v1/admin/chat-contexts/:id", async (request) => {
    await requireAdmin(db, config, request);
    const id = parseChatContextId(request.params.id);
    const context = await baseQuery()
      .where("chat_contexts.id", "=", id)
      .where("bots.deleted_at", "is", null)
      .executeTakeFirst();
    if (!context) throw new AppError("聊天记忆不存在", 404, "chat_context_not_found");
    const compactions = await db.selectFrom("chat_context_compactions")
      .select(["id", "task_id", "codex_thread_id", "codex_turn_id", "codex_item_id", "notification_type", "occurred_at", "created_at"])
      .where("chat_context_id", "=", context.id)
      .orderBy("occurred_at", "desc")
      .orderBy("id", "desc")
      .limit(100)
      .execute();
    return {
      ...publicContext(context),
      compactions: compactions.map((item) => ({
        id: item.id,
        taskId: item.task_id,
        threadId: item.codex_thread_id,
        turnId: item.codex_turn_id,
        itemId: item.codex_item_id,
        notificationType: item.notification_type,
        occurredAt: iso(item.occurred_at),
        createdAt: iso(item.created_at)
      }))
    };
  });

  app.post<{ Params: { id: string } }>("/v1/admin/chat-contexts/:id/recover", async (request) => {
    const principal = await requireAdmin(db, config, request, true);
    requireCsrf(request, principal);
    const id = parseChatContextId(request.params.id);
    const result = await db.transaction().execute(async (trx) => {
      const identity = await trx.selectFrom("chat_contexts")
        .innerJoin("bots", "bots.id", "chat_contexts.bot_id")
        .select(["chat_contexts.id", "chat_contexts.bot_id", "chat_contexts.chat_id"])
        .where("chat_contexts.id", "=", id)
        .where("bots.deleted_at", "is", null)
        .executeTakeFirst();
      if (!identity) throw new AppError("聊天记忆不存在", 404, "chat_context_not_found");

      await sql`select pg_advisory_xact_lock(hashtext(${`${identity.bot_id}:${identity.chat_id}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").selectAll().where("id", "=", id).forUpdate().executeTakeFirst();
      if (!context) throw new AppError("聊天记忆不存在", 404, "chat_context_not_found");
      const checkedAt = new Date();

      if (context.state === "uninitialized") {
        await trx.insertInto("chat_context_recovery_attempts").values({
          chat_context_id: context.id,
          actor_open_id: principal.openId,
          state_before: context.state,
          state_after: context.state,
          result: "uninitialized",
          failed_check_keys: JSON.stringify([]),
          checked_at: checkedAt
        }).execute();
        return { kind: "uninitialized" as const };
      }

      const worker = context.executor_id
        ? await trx.selectFrom("workers").select([
            "executor_id", "home_ref", "codex_profile", "config_fingerprint", "workspace_aliases", "capabilities",
            "operational_mode", "deleted_at"
          ]).where("executor_id", "=", context.executor_id).executeTakeFirst() ?? null
        : null;
      const threadMismatch = context.codex_thread_id
        ? await trx.selectFrom("tasks")
            .innerJoin("conversations", "conversations.id", "tasks.conversation_id")
            .select("tasks.id")
            .where("conversations.chat_context_id", "=", context.id)
            .where("tasks.codex_thread_id", "is not", null)
            .where("tasks.codex_thread_id", "!=", context.codex_thread_id)
            .executeTakeFirst()
        : null;
      const checks = buildChatContextRecoveryChecks({ ...context, thread_consistent: !threadMismatch }, worker);
      const failedCheckKeys = checks.filter((item) => item.state === "fail").map((item) => item.key);
      const allPassed = failedCheckKeys.length === 0;
      const recovered = context.state === "blocked" && allPassed;
      const nextState = recovered ? "ready" as const : context.state;

      if (recovered) {
        await trx.updateTable("chat_contexts").set({ state: "ready", blocked_reason: null, updated_at: checkedAt })
          .where("id", "=", context.id).where("state", "=", "blocked").executeTakeFirst();
      }
      await trx.insertInto("chat_context_recovery_attempts").values({
        chat_context_id: context.id,
        actor_open_id: principal.openId,
        state_before: context.state,
        state_after: nextState,
        result: recovered ? "recovered" : allPassed ? "already_ready" : "check_failed",
        failed_check_keys: JSON.stringify(failedCheckKeys),
        checked_at: checkedAt
      }).execute();
      return {
        kind: "result" as const,
        response: {
          id: context.id,
          state: nextState,
          recovered,
          checkedAt: checkedAt.toISOString(),
          checks
        }
      };
    });

    if (result.kind === "uninitialized") {
      throw new AppError("聊天记忆尚未建立原 Thread，无法执行恢复", 409, "chat_context_uninitialized");
    }
    if (result.response.recovered) {
      events.publish("chat_context", id);
      events.publish("task");
    }
    return result.response;
  });
}
