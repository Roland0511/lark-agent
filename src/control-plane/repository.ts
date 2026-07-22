import { sql, type Kysely, type Transaction } from "kysely";
import type { Database, Task } from "../db/types.js";
import { continuityFingerprintV2Capability, type AuthorizationGrant, type InboxDecision, type WorkerRegistration } from "../shared/contracts.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import { executorHasClaimCapacity, lockExecutorClaim } from "./executor-claim-lock.js";
import { authorizationFromMessage } from "./policy.js";

type ClaimedTask = Task & {
  bot_config_revision_snapshot: number;
  role_instructions_snapshot: string;
};

export interface TaskLeaseGuard {
  executorId: string;
  leaseToken: string;
}

interface WorkerRegistrationOptions {
  statusOnInsert: string;
  statusOnUpdate?: string;
  restoreDeleted?: boolean;
}

const configFingerprintBlockReasons = [
  "固定执行器的 CODEX_HOME、Profile 或配置指纹已变化，需要主人确认",
  "聊天绑定的执行器、CODEX_HOME、Profile、配置指纹或工作区别名已不匹配"
];

const configFingerprintTaskSummaries = [
  ...configFingerprintBlockReasons,
  "执行器 CODEX_HOME/profile 配置指纹已变化，需要主人确认"
];

async function migrateContinuityFingerprintV2(
  db: Transaction<Database>,
  registration: WorkerRegistration,
  mappingFingerprint: string | null,
  now: Date,
  previous: {
    home_ref: string;
    codex_profile: string;
    workspace_mapping_fingerprint: string | null;
    capabilities: unknown;
  } | undefined
): Promise<void> {
  if (!previous) return;
  const previousCapabilities = Array.isArray(previous.capabilities) ? previous.capabilities.map(String) : [];
  const isAlgorithmUpgrade = registration.capabilities.includes(continuityFingerprintV2Capability)
    && !previousCapabilities.includes(continuityFingerprintV2Capability)
    && previous.home_ref === registration.homeRef
    && previous.codex_profile === registration.codexProfile
    && (previous.workspace_mapping_fingerprint === null || mappingFingerprint === null || previous.workspace_mapping_fingerprint === mappingFingerprint);
  if (!isAlgorithmUpgrade) return;

  let contextQuery = db.selectFrom("chat_contexts").select(["id", "state", "blocked_reason"])
    .where("executor_id", "=", registration.executorId)
    .where("executor_home_ref", "=", registration.homeRef)
    .where("executor_profile", "=", registration.codexProfile)
    .where("codex_thread_id", "is not", null)
    .where("workspace_root_alias", "in", registration.workspaceAliases)
    .where((eb) => eb.or([
      eb("state", "=", "ready"),
      eb.and([eb("state", "=", "blocked"), eb("blocked_reason", "in", configFingerprintBlockReasons)])
    ]));
  contextQuery = previous.workspace_mapping_fingerprint === null
    ? contextQuery.where((eb) => eb.or([
        eb("executor_workspace_mapping_fingerprint", "is", null),
        eb("executor_workspace_mapping_fingerprint", "=", mappingFingerprint)
      ]))
    : contextQuery.where("executor_workspace_mapping_fingerprint", "=", mappingFingerprint);
  const contexts = await contextQuery.execute();
  if (!contexts.length) return;

  const contextIds = contexts.map((context) => context.id);
  const recoveredContextIds = contexts
    .filter((context) => context.state === "blocked" && configFingerprintBlockReasons.includes(context.blocked_reason ?? ""))
    .map((context) => context.id);
  await db.updateTable("chat_contexts").set({
    executor_config_fingerprint: registration.configFingerprint,
    executor_workspace_mapping_fingerprint: mappingFingerprint,
    codex_version: registration.codexVersion,
    updated_at: now
  }).where("id", "in", contextIds).execute();
  if (recoveredContextIds.length) {
    await db.updateTable("chat_contexts").set({ state: "ready", blocked_reason: null, updated_at: now })
      .where("id", "in", recoveredContextIds).execute();
    await db.insertInto("chat_context_recovery_attempts").values(recoveredContextIds.map((chatContextId) => ({
      chat_context_id: chatContextId,
      actor_open_id: "system:continuity-fingerprint-v2",
      state_before: "blocked" as const,
      state_after: "ready" as const,
      result: "recovered" as const,
      failed_check_keys: JSON.stringify([]),
      checked_at: now
    }))).execute();
  }

  const conversations = await db.selectFrom("conversations").select("id").where("chat_context_id", "in", contextIds).execute();
  if (!conversations.length) return;
  const conversationIds = conversations.map((conversation) => conversation.id);
  const activeTasks = await db.selectFrom("tasks").select(["id", "state", "summary"])
    .where("conversation_id", "in", conversationIds)
    .where("executor_id", "=", registration.executorId)
    .where("state", "in", ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"])
    .execute();
  if (!activeTasks.length) return;
  const taskIds = activeTasks.map((task) => task.id);
  const requeuedTaskIds = activeTasks
    .filter((task) => task.state === "waiting_input" && configFingerprintTaskSummaries.includes(task.summary ?? ""))
    .map((task) => task.id);
  await db.updateTable("tasks").set({
    executor_config_fingerprint: registration.configFingerprint,
    executor_workspace_mapping_fingerprint: mappingFingerprint,
    codex_version: registration.codexVersion,
    updated_at: now
  }).where("id", "in", taskIds).execute();
  if (requeuedTaskIds.length) {
    await db.updateTable("tasks").set({
      state: "waiting_worker",
      summary: null,
      revision: sql`revision + 1`,
      updated_at: now
    }).where("id", "in", requeuedTaskIds).execute();
    await db.insertInto("task_events").values(requeuedTaskIds.map((taskId) => ({
      task_id: taskId,
      event_type: "chat_context.fingerprint_migrated",
      summary: "连续性指纹已升级，任务恢复等待执行",
      payload: JSON.stringify({ version: 2 })
    }))).execute();
  }
}

export async function upsertWorkerRegistration(
  db: Transaction<Database>,
  registration: WorkerRegistration,
  options: WorkerRegistrationOptions
): Promise<void> {
  const now = new Date();
  const mappingFingerprint = registration.workspaceMappingFingerprint ?? null;
  await sql`select pg_advisory_xact_lock(hashtext(${`worker-registration:${registration.executorId}`}))`.execute(db);
  const previous = await db.selectFrom("workers")
    .select(["config_fingerprint", "workspace_mapping_fingerprint", "home_ref", "codex_profile", "capabilities"])
    .where("executor_id", "=", registration.executorId)
    .executeTakeFirst();
  const expectedProfileSwitch = await db.selectFrom("profile_switch_migrations")
    .innerJoin("device_commands", "device_commands.id", "profile_switch_migrations.command_id")
    .select("profile_switch_migrations.id")
    .where("profile_switch_migrations.executor_id", "=", registration.executorId)
    .where("profile_switch_migrations.target_profile", "=", registration.codexProfile)
    .where("profile_switch_migrations.state", "in", ["preparing", "ready", "switching", "committing"])
    .where("device_commands.state", "=", "running")
    .executeTakeFirst();

  await db.insertInto("workers").values({
    executor_id: registration.executorId,
    display_name: registration.displayName,
    home_ref: registration.homeRef,
    codex_profile: registration.codexProfile,
    config_fingerprint: registration.configFingerprint,
    workspace_mapping_fingerprint: mappingFingerprint,
    codex_version: registration.codexVersion,
    capacity: registration.capacity,
    workspace_aliases: JSON.stringify(registration.workspaceAliases),
    capabilities: JSON.stringify(registration.capabilities),
    runner_version: registration.runnerVersion ?? null,
    architecture: registration.architecture ?? null,
    registration_source: registration.registrationSource ?? "quick_install",
    status: options.statusOnInsert,
    deleted_at: null,
    last_seen_at: now,
    updated_at: now
  }).onConflict((conflict) => conflict.column("executor_id").doUpdateSet({
    display_name: registration.displayName,
    home_ref: registration.homeRef,
    codex_profile: registration.codexProfile,
    config_fingerprint: registration.configFingerprint,
    workspace_mapping_fingerprint: mappingFingerprint ?? sql`workers.workspace_mapping_fingerprint`,
    codex_version: registration.codexVersion,
    capacity: registration.capacity,
    workspace_aliases: JSON.stringify(registration.workspaceAliases),
    capabilities: JSON.stringify(registration.capabilities),
    runner_version: registration.runnerVersion ?? null,
    architecture: registration.architecture ?? null,
    registration_source: registration.registrationSource ?? "quick_install",
    ...(options.statusOnUpdate ? { status: options.statusOnUpdate } : {}),
    ...(options.restoreDeleted ? { deleted_at: null } : {}),
    last_seen_at: now,
    updated_at: now
  })).execute();

  if (mappingFingerprint && previous?.workspace_mapping_fingerprint === null) {
    await db.updateTable("tasks").set({ executor_workspace_mapping_fingerprint: mappingFingerprint, updated_at: now })
      .where("executor_id", "=", registration.executorId)
      .where("executor_workspace_mapping_fingerprint", "is", null)
      .where("executor_home_ref", "=", registration.homeRef)
      .where("executor_profile", "=", registration.codexProfile)
      .where("executor_config_fingerprint", "=", registration.configFingerprint)
      .execute();
    await db.updateTable("chat_contexts").set({ executor_workspace_mapping_fingerprint: mappingFingerprint, updated_at: now })
      .where("executor_id", "=", registration.executorId)
      .where("executor_workspace_mapping_fingerprint", "is", null)
      .where("executor_home_ref", "=", registration.homeRef)
      .where("executor_profile", "=", registration.codexProfile)
      .where("executor_config_fingerprint", "=", registration.configFingerprint)
      .execute();
  }

  if (mappingFingerprint && previous?.workspace_mapping_fingerprint && previous.workspace_mapping_fingerprint !== mappingFingerprint) {
    await db.updateTable("tasks").set({
      state: "waiting_input",
      revision: sql`revision + 1`,
      summary: "执行器工作区映射已变化，需要主人确认",
      lease_token_hash: null,
      lease_expires_at: null,
      updated_at: now
    }).where("executor_id", "=", registration.executorId)
      .where("executor_workspace_mapping_fingerprint", "is distinct from", mappingFingerprint)
      .where("state", "in", ["queued", "waiting_worker", "running", "waiting_approval", "held_draft"])
      .execute();
    await db.updateTable("chat_contexts").set({
      state: "blocked",
      blocked_reason: "固定执行器的工作区映射已变化，需要主人确认",
      updated_at: now
    }).where("executor_id", "=", registration.executorId)
      .where("codex_thread_id", "is not", null)
      .where("executor_workspace_mapping_fingerprint", "is distinct from", mappingFingerprint)
      .execute();
  }

  await migrateContinuityFingerprintV2(db, registration, mappingFingerprint, now, previous);

  if (!expectedProfileSwitch) {
    await db.updateTable("tasks")
      .set({ state: "waiting_input", revision: sql`revision + 1`, summary: "执行器 CODEX_HOME/profile 配置指纹已变化，需要主人确认", lease_token_hash: null, lease_expires_at: null, updated_at: now })
      .where("executor_id", "=", registration.executorId)
      .where("executor_config_fingerprint", "is not", null)
      .where("executor_config_fingerprint", "!=", registration.configFingerprint)
      .where("state", "in", ["queued", "waiting_worker", "running", "waiting_approval", "held_draft"])
      .execute();
    await db.updateTable("chat_contexts")
      .set({ state: "blocked", blocked_reason: "固定执行器的 CODEX_HOME、Profile 或配置指纹已变化，需要主人确认", updated_at: now })
      .where("executor_id", "=", registration.executorId)
      .where("codex_thread_id", "is not", null)
      .where((eb) => eb.or([
        eb("executor_home_ref", "is distinct from", registration.homeRef),
        eb("executor_profile", "is distinct from", registration.codexProfile),
        eb("executor_config_fingerprint", "is distinct from", registration.configFingerprint)
      ]))
      .execute();
  }
}

export class ControlPlaneRepository {
  constructor(private readonly db: Kysely<Database>, private readonly leaseSeconds: number) {}

  async upsertWorker(registration: WorkerRegistration): Promise<void> {
    await this.db.transaction().execute((trx) => upsertWorkerRegistration(trx, registration, {
      statusOnInsert: "online",
      statusOnUpdate: "online"
    }));
  }

  async claimTask(principal: {
    executorId: string;
    homeRef: string;
    codexProfile: string;
    configFingerprint: string;
    workspaceMappingFingerprint?: string | null;
  }): Promise<null | { task: ClaimedTask; leaseToken: string; leaseExpiresAt: Date }> {
    const leaseToken = randomToken();
    const leaseExpiresAt = new Date(Date.now() + this.leaseSeconds * 1000);
    const task = await this.db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, principal.executorId);
      const worker = await trx.selectFrom("workers").selectAll().where("executor_id", "=", principal.executorId).where("deleted_at", "is", null).executeTakeFirst();
      if (!worker) throw new AppError("worker is not registered", 401, "unknown_executor");
      if (worker.operational_mode !== "enabled") return null;
      const capabilities = Array.isArray(worker.capabilities) ? worker.capabilities.map(String) : [];
      if (!capabilities.includes("chat_context_v1")) return null;
      const workspaceMappingFingerprint = principal.workspaceMappingFingerprint ?? null;
      if (
        worker.home_ref !== principal.homeRef ||
        worker.codex_profile !== principal.codexProfile ||
        worker.config_fingerprint !== principal.configFingerprint ||
        (workspaceMappingFingerprint !== null && worker.workspace_mapping_fingerprint !== workspaceMappingFingerprint)
      ) {
        throw new AppError("worker configuration changed; create a new session", 409, "worker_config_changed");
      }
      if (!await executorHasClaimCapacity(trx, principal.executorId, worker.capacity)) return null;
      const aliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
      const singleWorkspaceAlias = aliases.length === 1 ? aliases[0] as string : null;
      const workspaceMappingReady = capabilities.includes("workspace_mapping_v1") &&
        workspaceMappingFingerprint !== null && worker.workspace_mapping_fingerprint === workspaceMappingFingerprint;
      const result = await sql<ClaimedTask>`
      WITH candidate AS (
        SELECT tasks.id, tasks.revision,
          bots.config_revision AS current_bot_config_revision,
          bots.role_instructions AS current_role_instructions,
          bots.attention_model AS current_attention_model,
          bots.attention_reasoning_effort AS current_attention_reasoning_effort,
          bots.execution_model AS current_execution_model,
          bots.execution_reasoning_effort AS current_execution_reasoning_effort
        FROM tasks
        JOIN bots ON bots.id = tasks.bot_id
        JOIN conversations ON conversations.id = tasks.conversation_id
        JOIN chat_contexts ON chat_contexts.id = conversations.chat_context_id
        WHERE tasks.state IN ('queued', 'waiting_worker')
          AND chat_contexts.state <> 'blocked'
          AND (
            NOT EXISTS (
              SELECT 1 FROM bot_skill_bindings skill_binding
              WHERE skill_binding.bot_id = tasks.bot_id AND skill_binding.deleted_at IS NULL
                AND (skill_binding.chat_context_id IS NULL OR skill_binding.chat_context_id = conversations.chat_context_id)
            )
            OR (
              ${capabilities.includes("skillhub_skills_v1")} AND ${capabilities.includes("user_skills_inventory_v1")}
              AND ${workspaceMappingReady}
              AND ${worker.user_skills_scan_status === "ready"} AND ${!worker.user_skills_truncated}
            )
          )
          AND (
            NOT EXISTS (
              SELECT 1 FROM bot_skill_bindings runtime_binding
              WHERE runtime_binding.bot_id = tasks.bot_id AND runtime_binding.deleted_at IS NULL
                AND (runtime_binding.chat_context_id IS NULL OR runtime_binding.chat_context_id = conversations.chat_context_id)
                AND (
                  EXISTS (SELECT 1 FROM skill_runtime_environment_revisions env_revision WHERE env_revision.binding_id = runtime_binding.id AND env_revision.superseded_at IS NULL AND env_revision.desired_state = 'present')
                  OR EXISTS (SELECT 1 FROM skill_runtime_file_revisions file_revision WHERE file_revision.binding_id = runtime_binding.id AND file_revision.superseded_at IS NULL)
                )
            )
            OR (${capabilities.includes("skill_runtime_config_v1")} AND ${workspaceMappingReady})
          )
          AND (tasks.executor_id IS NULL OR tasks.executor_id = ${principal.executorId})
          AND (tasks.executor_config_fingerprint IS NULL OR tasks.executor_config_fingerprint = ${principal.configFingerprint})
          AND (tasks.executor_workspace_mapping_fingerprint IS NULL OR tasks.executor_workspace_mapping_fingerprint = ${workspaceMappingFingerprint})
          AND (tasks.preferred_executor_id IS NULL OR tasks.preferred_executor_id = ${principal.executorId})
          AND (
            chat_contexts.codex_thread_id IS NULL
            OR (
              chat_contexts.executor_id = ${principal.executorId}
              AND chat_contexts.executor_home_ref = ${principal.homeRef}
              AND chat_contexts.executor_profile = ${principal.codexProfile}
              AND chat_contexts.executor_config_fingerprint = ${principal.configFingerprint}
              AND chat_contexts.executor_workspace_mapping_fingerprint IS NOT DISTINCT FROM ${workspaceMappingFingerprint}
              AND chat_contexts.workspace_root_alias = ANY(${sql.val(aliases)}::text[])
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM tasks other_task
            JOIN conversations other_conversation ON other_conversation.id = other_task.conversation_id
            WHERE other_conversation.chat_context_id = conversations.chat_context_id
              AND other_task.id <> tasks.id
              AND other_task.state IN ('running', 'waiting_approval', 'held_draft', 'human_owned')
          )
          AND (
            tasks.preferred_executor_id IS NOT NULL
            OR 1 = (
              SELECT count(*)
              FROM workers eligible_worker
              WHERE eligible_worker.deleted_at IS NULL
                AND eligible_worker.operational_mode = 'enabled'
                AND eligible_worker.capabilities ? 'chat_context_v1'
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM bot_skill_bindings skill_binding
                    WHERE skill_binding.bot_id = tasks.bot_id AND skill_binding.deleted_at IS NULL
                      AND (skill_binding.chat_context_id IS NULL OR skill_binding.chat_context_id = conversations.chat_context_id)
                  )
                  OR (
                    eligible_worker.capabilities ? 'skillhub_skills_v1'
                    AND eligible_worker.capabilities ? 'user_skills_inventory_v1'
                    AND eligible_worker.capabilities ? 'workspace_mapping_v1'
                    AND eligible_worker.workspace_mapping_fingerprint IS NOT NULL
                    AND eligible_worker.user_skills_scan_status = 'ready'
                    AND NOT eligible_worker.user_skills_truncated
                  )
                )
                AND (
                  NOT EXISTS (
                    SELECT 1 FROM bot_skill_bindings runtime_binding
                    WHERE runtime_binding.bot_id = tasks.bot_id AND runtime_binding.deleted_at IS NULL
                      AND (runtime_binding.chat_context_id IS NULL OR runtime_binding.chat_context_id = conversations.chat_context_id)
                      AND (
                        EXISTS (SELECT 1 FROM skill_runtime_environment_revisions env_revision WHERE env_revision.binding_id = runtime_binding.id AND env_revision.superseded_at IS NULL AND env_revision.desired_state = 'present')
                        OR EXISTS (SELECT 1 FROM skill_runtime_file_revisions file_revision WHERE file_revision.binding_id = runtime_binding.id AND file_revision.superseded_at IS NULL)
                      )
                  )
                  OR (
                    eligible_worker.capabilities ? 'skill_runtime_config_v1'
                    AND eligible_worker.capabilities ? 'workspace_mapping_v1'
                    AND eligible_worker.workspace_mapping_fingerprint IS NOT NULL
                  )
                )
                AND (tasks.executor_id IS NULL OR tasks.executor_id = eligible_worker.executor_id)
                AND (tasks.executor_config_fingerprint IS NULL OR tasks.executor_config_fingerprint = eligible_worker.config_fingerprint)
                AND (tasks.executor_workspace_mapping_fingerprint IS NULL OR tasks.executor_workspace_mapping_fingerprint = eligible_worker.workspace_mapping_fingerprint)
                AND (
                  eligible_worker.workspace_aliases ? COALESCE(tasks.requested_workspace_alias, tasks.resolved_workspace_alias)
                  OR (
                    tasks.requested_workspace_alias IS NULL
                    AND tasks.resolved_workspace_alias IS NULL
                    AND jsonb_array_length(eligible_worker.workspace_aliases) = 1
                  )
                )
            )
          )
          AND (
            COALESCE(requested_workspace_alias, resolved_workspace_alias) = ANY(${sql.val(aliases)}::text[])
            OR (
              requested_workspace_alias IS NULL
              AND resolved_workspace_alias IS NULL
              AND ${singleWorkspaceAlias}::text IS NOT NULL
            )
          )
        ORDER BY tasks.created_at ASC
        -- Lock the durable context first. The outer UPDATE then locks the task
        -- and rechecks state+revision, matching every other context -> task path.
        FOR UPDATE OF chat_contexts SKIP LOCKED
        LIMIT 1
      )
      UPDATE tasks t
      SET state = 'running',
          executor_id = ${principal.executorId},
          executor_home_ref = ${principal.homeRef},
          executor_profile = ${principal.codexProfile},
          executor_config_fingerprint = ${principal.configFingerprint},
          executor_workspace_mapping_fingerprint = ${workspaceMappingFingerprint},
          codex_version = ${worker.codex_version},
          bot_config_revision_snapshot = CASE
            WHEN t.bot_config_revision_snapshot IS NULL THEN candidate.current_bot_config_revision
            ELSE t.bot_config_revision_snapshot
          END,
          role_instructions_snapshot = CASE
            WHEN t.bot_config_revision_snapshot IS NULL THEN candidate.current_role_instructions
            ELSE t.role_instructions_snapshot
          END,
          attention_model_snapshot = CASE
            WHEN t.bot_config_revision_snapshot IS NULL THEN candidate.current_attention_model
            ELSE t.attention_model_snapshot
          END,
          attention_reasoning_effort_snapshot = CASE
            WHEN t.bot_config_revision_snapshot IS NULL THEN candidate.current_attention_reasoning_effort
            ELSE t.attention_reasoning_effort_snapshot
          END,
          execution_model_snapshot = CASE
            WHEN t.bot_config_revision_snapshot IS NULL THEN candidate.current_execution_model
            ELSE t.execution_model_snapshot
          END,
          execution_reasoning_effort_snapshot = CASE
            WHEN t.bot_config_revision_snapshot IS NULL THEN candidate.current_execution_reasoning_effort
            ELSE t.execution_reasoning_effort_snapshot
          END,
          resolved_workspace_alias = COALESCE(t.resolved_workspace_alias, t.requested_workspace_alias, ${singleWorkspaceAlias}),
          lease_token_hash = ${sha256(leaseToken)},
          lease_expires_at = ${leaseExpiresAt},
          attempt = attempt + 1,
          revision = t.revision + 1,
          updated_at = now()
      FROM candidate
      WHERE t.id = candidate.id
        AND t.state IN ('queued', 'waiting_worker')
        AND t.revision = candidate.revision
      RETURNING t.*
      `.execute(trx);
      return result.rows[0] ?? null;
    });
    if (!task) return null;
    await this.recordTaskEvent(task.id, "task.claimed", "任务已被执行器领取", {
      executorId: principal.executorId,
      attempt: task.attempt,
      resolvedWorkspaceAlias: task.resolved_workspace_alias
    });
    return { task, leaseToken, leaseExpiresAt };
  }

  async rejectInvalidClaim(taskId: string, leaseToken: string, detail: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const task = await trx.updateTable("tasks").set({
        state: "waiting_input",
        summary: `任务领取契约无效：${detail}`.slice(0, 5_000),
        lease_token_hash: null,
        lease_expires_at: null,
        revision: sql`revision + 1`,
        updated_at: new Date()
      }).where("id", "=", taskId).where("lease_token_hash", "=", sha256(leaseToken)).returning("id").executeTakeFirst();
      if (task) await trx.insertInto("task_events").values({
        task_id: task.id,
        event_type: "task.contract_invalid",
        summary: "任务领取响应未通过共享契约校验，已安全暂停",
        payload: JSON.stringify({ detail: detail.slice(0, 1_000) })
      }).execute();
    });
  }

  async touchWorker(executorId: string): Promise<void> {
    await this.db.updateTable("workers").set({ last_seen_at: new Date(), status: "online", updated_at: new Date() }).where("executor_id", "=", executorId).execute();
  }

  async recoverExpiredLeases(): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const paused = await trx.updateTable("tasks").set({
        state: "waiting_input",
        lease_token_hash: null,
        lease_expires_at: null,
        summary: "任务在 Codex thread 建立前连续 3 次租约过期，已停止自动重领",
        updated_at: now,
        revision: sql`revision + 1`
      }).where("state", "=", "running").where("lease_expires_at", "<", now)
        .where("codex_thread_id", "is", null).where("attempt", ">=", 3).returning("id").execute();
      if (paused.length) await trx.insertInto("task_events").values(paused.map((task) => ({
        task_id: task.id,
        event_type: "task.lease_recovery_stopped",
        summary: "领取后尚未启动 Codex，连续租约过期，已安全暂停",
        payload: JSON.stringify({ threshold: 3 })
      }))).execute();
      const requeued = await trx.updateTable("tasks").set((eb) => ({
        state: "waiting_worker",
        preferred_executor_id: eb.ref("executor_id"),
        lease_token_hash: null,
        lease_expires_at: null,
        summary: "执行器租约已过期，等待原执行器恢复",
        updated_at: now,
        revision: sql`revision + 1`
      })).where("state", "=", "running").where("lease_expires_at", "<", now).executeTakeFirst();
      return paused.length + Number(requeued.numUpdatedRows);
    });
  }

  async heartbeat(taskId: string, executorId: string, leaseToken: string): Promise<{ leaseExpiresAt: Date; state: string }> {
    const leaseExpiresAt = new Date(Date.now() + this.leaseSeconds * 1000);
    const updated = await this.db
      .updateTable("tasks")
      .set({ lease_expires_at: leaseExpiresAt, updated_at: new Date() })
      .where("id", "=", taskId)
      .where("executor_id", "=", executorId)
      .where("lease_token_hash", "=", sha256(leaseToken))
      .where("lease_expires_at", ">", new Date())
      .returning(["id", "state"])
      .executeTakeFirst();
    if (!updated) throw new AppError("task lease is missing or expired", 409, "invalid_lease");
    await this.db.updateTable("workers").set({ last_seen_at: new Date(), status: "online" }).where("executor_id", "=", executorId).execute();
    return { leaseExpiresAt, state: updated.state };
  }

  async assertLease(taskId: string, executorId: string, leaseToken: string): Promise<Task> {
    const task = await this.db
      .selectFrom("tasks")
      .selectAll()
      .where("id", "=", taskId)
      .where("executor_id", "=", executorId)
      .where("lease_token_hash", "=", sha256(leaseToken))
      .where("lease_expires_at", ">", new Date())
      .executeTakeFirst();
    if (!task) throw new AppError("task lease is missing or expired", 409, "invalid_lease");
    return task;
  }

  async taskSignals(taskId: string, afterSeq = 0) {
    return this.db
      .selectFrom("signals")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("seq", ">", afterSeq)
      .orderBy("seq", "asc")
      .execute();
  }

  async decideSignal(
    taskId: string,
    signalId: string,
    decision: InboxDecision,
    rationale: string,
    priority: number
  ): Promise<void> {
    const result = await this.db
      .updateTable("signals")
      .set({ decision, decision_rationale: rationale, priority, decided_at: new Date() })
      .where("id", "=", signalId)
      .where("task_id", "=", taskId)
      .executeTakeFirst();
    if (!result.numUpdatedRows) throw new AppError("signal not found", 404, "not_found");
  }

  async recordTaskEvent(taskId: string, eventType: string, summary: string, payload: unknown): Promise<void> {
    await this.db.insertInto("task_events").values({ task_id: taskId, event_type: eventType, summary, payload: JSON.stringify(payload) }).execute();
  }

  async bindTaskThread(taskId: string, codexThreadId: string, lease?: TaskLeaseGuard): Promise<{ status: "bound" | "unchanged" | "blocked"; chatContextId: string }> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const identity = await trx.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id")
        .select(["conversations.bot_id", "conversations.chat_id", "conversations.chat_context_id"]).where("tasks.id", "=", taskId).executeTakeFirst();
      if (!identity) throw new AppError("task not found", 404, "not_found");
      await sql`select pg_advisory_xact_lock(hashtext(${`${identity.bot_id}:${identity.chat_id}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").selectAll().where("id", "=", identity.chat_context_id).forUpdate().executeTakeFirstOrThrow();
      const task = await trx.selectFrom("tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirstOrThrow();
      this.assertLockedLease(task, lease);

      const runtimeConfig = task.runtime_config_snapshot && typeof task.runtime_config_snapshot === "object"
        ? task.runtime_config_snapshot as { environment?: unknown; files?: unknown }
        : {};
      const requiresWorkspaceMapping = (Array.isArray(task.skill_set_snapshot) && task.skill_set_snapshot.length > 0) ||
        (Array.isArray(runtimeConfig.environment) && runtimeConfig.environment.length > 0) ||
        (Array.isArray(runtimeConfig.files) && runtimeConfig.files.length > 0);
      const environmentComplete = Boolean(
        task.executor_id && task.executor_home_ref && task.executor_profile &&
        task.executor_config_fingerprint && task.resolved_workspace_alias &&
        (!requiresWorkspaceMapping || task.executor_workspace_mapping_fingerprint)
      );
      const environmentMatches = !context.executor_id || (
        context.executor_id === task.executor_id &&
        context.executor_home_ref === task.executor_home_ref &&
        context.executor_profile === task.executor_profile &&
        context.executor_config_fingerprint === task.executor_config_fingerprint &&
        context.executor_workspace_mapping_fingerprint === task.executor_workspace_mapping_fingerprint &&
        context.workspace_root_alias === task.resolved_workspace_alias
      );
      const threadMatches = !context.codex_thread_id || context.codex_thread_id === codexThreadId;
      if (context.state === "blocked" || !environmentComplete || !environmentMatches || !threadMatches) {
        const reason = context.state === "blocked"
          ? context.blocked_reason ?? "聊天上下文已阻塞"
          : !environmentComplete
            ? "任务缺少完整执行环境，无法固定聊天 Thread"
            : !environmentMatches
              ? "任务执行环境与聊天固定环境不一致"
              : `Codex 返回了不同 Thread：当前 ${context.codex_thread_id}，实际 ${codexThreadId}`;
        await trx.updateTable("tasks").set({
          codex_thread_id: codexThreadId,
          state: "waiting_input",
          summary: reason,
          lease_token_hash: null,
          lease_expires_at: null,
          revision: sql`revision + 1`,
          updated_at: now
        }).where("id", "=", task.id).execute();
        await trx.updateTable("chat_contexts").set({ state: "blocked", blocked_reason: reason, updated_at: now }).where("id", "=", context.id).execute();
        await trx.insertInto("task_events").values({
          task_id: task.id,
          event_type: "chat_context.blocked",
          summary: "聊天记忆绑定冲突，任务已安全暂停",
          payload: JSON.stringify({ chatContextId: context.id, expectedThreadId: context.codex_thread_id, actualThreadId: codexThreadId, reason })
        }).execute();
        return { status: "blocked", chatContextId: context.id };
      }

      const status = context.codex_thread_id ? "unchanged" : "bound";
      await trx.updateTable("tasks").set({ codex_thread_id: codexThreadId, updated_at: now }).where("id", "=", task.id).execute();
      await trx.updateTable("chat_contexts").set({
        codex_thread_id: codexThreadId,
        executor_id: task.executor_id,
        executor_home_ref: task.executor_home_ref,
        executor_profile: task.executor_profile,
        executor_config_fingerprint: task.executor_config_fingerprint,
        executor_workspace_mapping_fingerprint: task.executor_workspace_mapping_fingerprint,
        codex_version: task.codex_version,
        workspace_root_alias: task.resolved_workspace_alias,
        state: "ready",
        blocked_reason: null,
        last_activity_at: now,
        updated_at: now
      }).where("id", "=", context.id).execute();
      return { status, chatContextId: context.id };
    });
  }

  /** @deprecated Use bindTaskThread so the durable chat context is updated atomically. */
  async updateTaskThread(taskId: string, codexThreadId: string): Promise<void> {
    await this.bindTaskThread(taskId, codexThreadId);
  }

  async blockTaskContext(taskId: string, reason: string, lease?: TaskLeaseGuard): Promise<{ chatContextId: string }> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const identity = await trx.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id")
        .select(["conversations.bot_id", "conversations.chat_id", "conversations.chat_context_id"]).where("tasks.id", "=", taskId).executeTakeFirst();
      if (!identity) throw new AppError("task not found", 404, "not_found");
      await sql`select pg_advisory_xact_lock(hashtext(${`${identity.bot_id}:${identity.chat_id}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").selectAll().where("id", "=", identity.chat_context_id).forUpdate().executeTakeFirstOrThrow();
      const task = await trx.selectFrom("tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirstOrThrow();
      this.assertLockedLease(task, lease);
      const summary = reason.trim().slice(0, 5_000) || "聊天 Thread 无法在固定执行环境中恢复";
      await trx.updateTable("tasks").set({
        state: "waiting_input",
        summary,
        lease_token_hash: null,
        lease_expires_at: null,
        revision: sql`revision + 1`,
        updated_at: now
      }).where("id", "=", task.id).execute();
      await trx.updateTable("chat_contexts").set({ state: "blocked", blocked_reason: summary, updated_at: now }).where("id", "=", context.id).execute();
      await trx.insertInto("task_events").values({
        task_id: task.id,
        event_type: "chat_context.blocked",
        summary: "聊天记忆无法安全恢复，任务已暂停",
        payload: JSON.stringify({ chatContextId: context.id, expectedThreadId: context.codex_thread_id, reason: summary })
      }).execute();
      return { chatContextId: context.id };
    });
  }

  async recordContextCompaction(taskId: string, payload: {
    threadId: string;
    turnId: string;
    itemId?: string | null;
    source: string;
    occurredAt?: Date;
  }, lease?: TaskLeaseGuard): Promise<{ recorded: boolean; blocked: boolean; chatContextId: string }> {
    return this.db.transaction().execute(async (trx) => {
      const identity = await trx.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id")
        .select(["tasks.id", "conversations.bot_id", "conversations.chat_id", "conversations.chat_context_id"]).where("tasks.id", "=", taskId).executeTakeFirst();
      if (!identity) throw new AppError("task not found", 404, "not_found");
      await sql`select pg_advisory_xact_lock(hashtext(${`${identity.bot_id}:${identity.chat_id}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").selectAll().where("id", "=", identity.chat_context_id).forUpdate().executeTakeFirstOrThrow();
      const task = await trx.selectFrom("tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirstOrThrow();
      this.assertLockedLease(task, lease);
      if (!context.codex_thread_id || context.codex_thread_id !== payload.threadId) {
        const reason = `自动压缩通知的 Thread 与聊天绑定不一致：当前 ${context.codex_thread_id ?? "未建立"}，通知 ${payload.threadId}`;
        await trx.updateTable("tasks").set({ state: "waiting_input", summary: reason, lease_token_hash: null, lease_expires_at: null, revision: sql`revision + 1`, updated_at: new Date() }).where("id", "=", identity.id).execute();
        await trx.updateTable("chat_contexts").set({ state: "blocked", blocked_reason: reason, updated_at: new Date() }).where("id", "=", context.id).execute();
        return { recorded: false, blocked: true, chatContextId: context.id };
      }
      const occurredAt = payload.occurredAt ?? new Date();
      const existing = payload.itemId
        ? await trx.selectFrom("chat_context_compactions").select(["id"])
            .where("chat_context_id", "=", context.id)
            .where("codex_item_id", "=", payload.itemId)
            .executeTakeFirst()
        : await trx.selectFrom("chat_context_compactions").select(["id"])
            .where("chat_context_id", "=", context.id)
            .where("codex_turn_id", "=", payload.turnId)
            .executeTakeFirst();
      if (existing) return { recorded: false, blocked: false, chatContextId: context.id };

      if (payload.itemId) {
        const legacy = await trx.selectFrom("chat_context_compactions").select("id")
          .where("chat_context_id", "=", context.id)
          .where("codex_turn_id", "=", payload.turnId)
          .where("codex_item_id", "is", null)
          .executeTakeFirst();
        if (legacy) {
          await trx.updateTable("chat_context_compactions").set({
            task_id: identity.id,
            codex_item_id: payload.itemId,
            notification_type: payload.source,
            occurred_at: occurredAt
          }).where("id", "=", legacy.id).execute();
          await trx.updateTable("chat_contexts").set({
            last_compacted_at: sql`GREATEST(COALESCE(last_compacted_at, ${occurredAt}), ${occurredAt})`,
            last_activity_at: sql`GREATEST(last_activity_at, ${occurredAt})`,
            updated_at: new Date()
          }).where("id", "=", context.id).execute();
          return { recorded: false, blocked: false, chatContextId: context.id };
        }
      }

      const inserted = await trx.insertInto("chat_context_compactions").values({
        chat_context_id: context.id,
        task_id: identity.id,
        codex_thread_id: payload.threadId,
        codex_turn_id: payload.turnId,
        codex_item_id: payload.itemId ?? null,
        notification_type: payload.source,
        occurred_at: occurredAt
      }).returning("id").executeTakeFirstOrThrow();
      await trx.updateTable("chat_contexts").set({
        auto_compaction_count: sql`auto_compaction_count + 1`,
        last_compacted_at: occurredAt,
        last_activity_at: occurredAt,
        updated_at: new Date()
      }).where("id", "=", context.id).execute();
      return { recorded: Boolean(inserted), blocked: false, chatContextId: context.id };
    });
  }

  async finishTask(
    taskId: string,
    state: "completed" | "failed" | "waiting_input" | "human_owned",
    summary: string,
    lifecycle?: { disposition: "complete" | "awaiting_followup" | "unchanged"; processedRoomSeq: number; reason: string },
    lease?: TaskLeaseGuard
  ): Promise<{ nextTaskId: string | null }> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const identity = await trx.selectFrom("tasks").innerJoin("conversations", "conversations.id", "tasks.conversation_id")
        .select(["conversations.bot_id", "conversations.chat_id", "conversations.chat_context_id"]).where("tasks.id", "=", taskId).executeTakeFirst();
      if (!identity) return { nextTaskId: null };
      await sql`select pg_advisory_xact_lock(hashtext(${`${identity.bot_id}:${identity.chat_id}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").selectAll().where("id", "=", identity.chat_context_id).forUpdate().executeTakeFirstOrThrow();
      const current = await trx.selectFrom("tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirstOrThrow();
      this.assertLockedLease(current, lease);
      const conversation = await trx.selectFrom("conversations").selectAll().where("id", "=", current.conversation_id).forUpdate().executeTakeFirstOrThrow();
      const storedDisposition = lifecycle?.disposition === "unchanged" ? null : lifecycle?.disposition ?? null;
      await trx.updateTable("tasks").set({
        state,
        revision: sql`revision + 1`,
        summary,
        conversation_disposition: state === "completed" ? storedDisposition : current.conversation_disposition,
        disposition_reason: state === "completed" ? (lifecycle?.reason || null) : current.disposition_reason,
        lease_token_hash: null,
        lease_expires_at: null,
        updated_at: now,
        completed_at: state === "completed" || state === "failed" ? now : null
      }).where("id", "=", taskId).execute();
      await trx.updateTable("chat_contexts").set({ last_activity_at: now, updated_at: now }).where("id", "=", context.id).execute();
      if (state === "completed") await trx.insertInto("task_events").values({
        task_id: taskId,
        event_type: "task.completed",
        summary: "任务回合已完成",
        payload: JSON.stringify({ disposition: storedDisposition, processedRoomSeq: lifecycle?.processedRoomSeq ?? null })
      }).execute();

      if (state !== "completed") {
        await trx.updateTable("conversations").set({ active: state !== "failed", updated_at: now }).where("id", "=", conversation.id).execute();
        return { nextTaskId: null };
      }

      const pending = lifecycle
        ? await trx.selectFrom("signals").selectAll().where("task_id", "=", taskId).where("seq", ">", lifecycle.processedRoomSeq).orderBy("seq").execute()
        : [];
      if (pending.length) {
        const first = pending[0] as (typeof pending)[number];
        const blocked = context.state === "blocked";
        const next = await trx.insertInto("tasks").values({
          bot_id: current.bot_id,
          conversation_id: conversation.id,
          state: blocked ? "waiting_input" : context.executor_id ? "waiting_worker" : "queued",
          turn_index: current.turn_index + 1,
          trigger_message_id: first.message_id,
          conversation_disposition: null,
          disposition_reason: null,
          requester_id: first.sender_id,
          requester_role: first.sender_role,
          authorization_grant: JSON.stringify(authorizationFromMessage(first.content, first.sender_role === "owner")),
          requested_workspace_alias: context.workspace_root_alias ?? current.requested_workspace_alias,
          resolved_workspace_alias: context.workspace_root_alias,
          preferred_executor_id: context.executor_id ?? current.preferred_executor_id,
          executor_id: context.executor_id,
          codex_thread_id: context.codex_thread_id,
          executor_home_ref: context.executor_home_ref,
          executor_profile: context.executor_profile,
          executor_config_fingerprint: context.executor_config_fingerprint,
          codex_version: context.codex_version,
          lease_token_hash: null,
          lease_expires_at: null,
          summary: blocked ? context.blocked_reason : null,
          completed_at: null,
          updated_at: now
        }).returning("id").executeTakeFirstOrThrow();
        await trx.updateTable("signals").set({ task_id: next.id }).where("task_id", "=", taskId).where("seq", ">", lifecycle?.processedRoomSeq ?? 0).execute();
        const pendingDeadline = conversation.chat_type === "group" && lifecycle?.disposition === "awaiting_followup"
          ? new Date(now.getTime() + 24 * 60 * 60_000)
          : conversation.chat_type === "group" ? conversation.followup_expires_at : null;
        await trx.updateTable("conversations").set({ active: true, followup_expires_at: pendingDeadline, updated_at: now }).where("id", "=", conversation.id).execute();
        await trx.insertInto("task_events").values({ task_id: next.id, event_type: "conversation.turn_queued", summary: `会话第 ${current.turn_index + 1} 回合已排队`, payload: JSON.stringify({ previousTaskId: taskId }) }).execute();
        return { nextTaskId: next.id };
      }

      if (conversation.chat_type === "group" && lifecycle?.disposition === "awaiting_followup") {
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60_000);
        await trx.updateTable("conversations").set({ active: true, followup_expires_at: expiresAt, updated_at: now }).where("id", "=", conversation.id).execute();
        await trx.insertInto("task_events").values({ task_id: taskId, event_type: "conversation.awaiting_followup", summary: "Agent 判断会话仍需续聊", payload: JSON.stringify({ expiresAt: expiresAt.toISOString(), reason: lifecycle.reason }) }).execute();
      } else if (conversation.chat_type === "group" && lifecycle?.disposition === "unchanged" && conversation.followup_expires_at) {
        await trx.updateTable("conversations").set({ active: true, updated_at: now }).where("id", "=", conversation.id).execute();
      } else {
        await trx.updateTable("conversations").set({ active: false, followup_expires_at: null, updated_at: now }).where("id", "=", conversation.id).execute();
        await trx.insertInto("task_events").values({ task_id: taskId, event_type: "conversation.completed", summary: "Agent 判断会话已经结束", payload: JSON.stringify({ reason: lifecycle?.reason ?? "" }) }).execute();
      }
      return { nextTaskId: null };
    });
  }

  private assertLockedLease(task: Task, lease?: TaskLeaseGuard): void {
    if (!lease) return;
    const leaseExpiresAt = task.lease_expires_at ? new Date(task.lease_expires_at).getTime() : 0;
    const mutableStates = new Set<Task["state"]>(["running", "waiting_approval", "held_draft"]);
    if (
      task.executor_id !== lease.executorId ||
      task.lease_token_hash !== sha256(lease.leaseToken) ||
      leaseExpiresAt <= Date.now() ||
      !mutableStates.has(task.state)
    ) {
      throw new AppError("task lease is missing, expired, or no longer mutable", 409, "invalid_lease");
    }
  }

  async expireFollowupConversations(): Promise<number> {
    const candidates = await this.db.selectFrom("conversations").select(["id", "bot_id", "chat_id"]).where("active", "=", true).where("followup_expires_at", "<=", new Date()).execute();
    let expired = 0;
    for (const candidate of candidates) {
      expired += await this.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${`${candidate.bot_id}:${candidate.chat_id}`}))`.execute(trx);
        const conversation = await trx.selectFrom("conversations").selectAll().where("id", "=", candidate.id).forUpdate().executeTakeFirst();
        if (!conversation?.active || !conversation.followup_expires_at || new Date(conversation.followup_expires_at) > new Date()) return 0;
        const activeTask = await trx.selectFrom("tasks").select("id").where("conversation_id", "=", conversation.id).where("state", "in", ["queued", "waiting_worker", "running", "waiting_input", "waiting_approval", "held_draft", "human_owned"]).executeTakeFirst();
        if (activeTask) return 0;
        await trx.updateTable("conversations").set({ active: false, followup_expires_at: null, updated_at: new Date() }).where("id", "=", conversation.id).execute();
        const latest = await trx.selectFrom("tasks").select("id").where("conversation_id", "=", conversation.id).orderBy("turn_index", "desc").executeTakeFirst();
        if (latest) await trx.insertInto("task_events").values({ task_id: latest.id, event_type: "conversation.followup_expired", summary: "续聊窗口已超过 24 小时，会话自动结束", payload: JSON.stringify({}) }).execute();
        return 1;
      });
    }
    return expired;
  }

  async createApproval(
    taskId: string,
    requestId: string,
    method: string,
    summary: string,
    payload: unknown,
    automaticDecision: "approved" | "rejected" | null
  ) {
    const now = new Date();
    const state = automaticDecision ?? "pending";
    const approval = await this.db
      .insertInto("approvals")
      .values({
        task_id: taskId,
        request_id: requestId,
        method,
        summary,
        payload: JSON.stringify(payload),
        state,
        decided_by: automaticDecision ? "policy" : null,
        decided_at: automaticDecision ? now : null,
        expires_at: new Date(Date.now() + 30 * 60_000)
      })
      .onConflict((conflict) => conflict.columns(["task_id", "request_id"]).doNothing())
      .returningAll()
      .executeTakeFirst();
    const existing = approval ?? (await this.db.selectFrom("approvals").selectAll().where("task_id", "=", taskId).where("request_id", "=", requestId).executeTakeFirstOrThrow());
    if (existing.state === "pending") {
      await this.db.updateTable("tasks").set({ state: "waiting_approval", revision: sql`revision + 1`, updated_at: now }).where("id", "=", taskId).execute();
    }
    return existing;
  }

  async getApproval(taskId: string, approvalId: string) {
    const approval = await this.db.selectFrom("approvals").selectAll().where("id", "=", approvalId).where("task_id", "=", taskId).executeTakeFirst();
    if (!approval) throw new AppError("approval not found", 404, "not_found");
    if (approval.state === "pending" && new Date(approval.expires_at).getTime() <= Date.now()) {
      await this.db.updateTable("approvals").set({ state: "expired", decided_at: new Date() }).where("id", "=", approval.id).execute();
      return { ...approval, state: "expired" as const };
    }
    return approval;
  }

  async decideApproval(approvalId: string, ownerOpenId: string, approved: boolean): Promise<string> {
    const updated = await this.db
      .updateTable("approvals")
      .set({ state: approved ? "approved" : "rejected", decided_by: ownerOpenId, decided_at: new Date() })
      .where("id", "=", approvalId)
      .where("state", "=", "pending")
      .returning("task_id")
      .executeTakeFirst();
    if (!updated) throw new AppError("approval is missing or already decided", 409, "approval_not_pending");
    await this.db.updateTable("tasks").set({ state: "running", revision: sql`revision + 1`, updated_at: new Date() }).where("id", "=", updated.task_id).execute();
    return updated.task_id;
  }

  async taskAuthorization(taskId: string): Promise<{ role: "owner" | "member"; grant: AuthorizationGrant }> {
    const task = await this.db.selectFrom("tasks").select(["requester_role", "authorization_grant"]).where("id", "=", taskId).executeTakeFirstOrThrow();
    return { role: task.requester_role, grant: task.authorization_grant as AuthorizationGrant };
  }

  async recordActionReceipt(taskId: string, actionKey: string, actionType: string, requestDigest: string, result: unknown): Promise<void> {
    await this.db.insertInto("action_receipts").values({
      task_id: taskId,
      action_key: actionKey,
      action_type: actionType,
      request_digest: requestDigest,
      result: JSON.stringify(result)
    }).onConflict((conflict) => conflict.columns(["task_id", "action_key"]).doNothing()).execute();
  }
}
