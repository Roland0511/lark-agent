import { sql, type Kysely } from "kysely";
import type { Database, Task } from "../db/types.js";
import type { AuthorizationGrant, InboxDecision, WorkerRegistration } from "../shared/contracts.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import { authorizationFromMessage } from "./policy.js";

export class ControlPlaneRepository {
  constructor(private readonly db: Kysely<Database>, private readonly leaseSeconds: number) {}

  async upsertWorker(registration: WorkerRegistration): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto("workers")
      .values({
        executor_id: registration.executorId,
        display_name: registration.displayName,
        home_ref: registration.homeRef,
        codex_profile: registration.codexProfile,
        config_fingerprint: registration.configFingerprint,
        codex_version: registration.codexVersion,
        capacity: registration.capacity,
        workspace_aliases: JSON.stringify(registration.workspaceAliases),
        capabilities: JSON.stringify(registration.capabilities),
        runner_version: registration.runnerVersion ?? null,
        architecture: registration.architecture ?? null,
        registration_source: "quick_install",
        status: "online",
        last_seen_at: now,
        updated_at: now
      })
      .onConflict((conflict) =>
        conflict.column("executor_id").doUpdateSet({
          display_name: registration.displayName,
          home_ref: registration.homeRef,
          codex_profile: registration.codexProfile,
          config_fingerprint: registration.configFingerprint,
          codex_version: registration.codexVersion,
          capacity: registration.capacity,
          workspace_aliases: JSON.stringify(registration.workspaceAliases),
          capabilities: JSON.stringify(registration.capabilities),
          runner_version: registration.runnerVersion ?? null,
          architecture: registration.architecture ?? null,
          registration_source: "quick_install",
          status: "online",
          last_seen_at: now,
          updated_at: now
        })
      )
      .execute();
    await this.db
      .updateTable("tasks")
      .set({ state: "waiting_input", revision: sql`revision + 1`, summary: "执行器 CODEX_HOME/profile 配置指纹已变化，需要主人确认", lease_token_hash: null, lease_expires_at: null, updated_at: now })
      .where("executor_id", "=", registration.executorId)
      .where("executor_config_fingerprint", "is not", null)
      .where("executor_config_fingerprint", "!=", registration.configFingerprint)
      .where("state", "in", ["queued", "waiting_worker", "running", "waiting_approval", "held_draft"])
      .execute();
  }

  async claimTask(principal: {
    executorId: string;
    homeRef: string;
    codexProfile: string;
    configFingerprint: string;
  }): Promise<null | { task: Task; leaseToken: string; leaseExpiresAt: Date }> {
    const worker = await this.db.selectFrom("workers").selectAll().where("executor_id", "=", principal.executorId).where("deleted_at", "is", null).executeTakeFirst();
    if (!worker) throw new AppError("worker is not registered", 401, "unknown_executor");
    if (worker.operational_mode !== "enabled") return null;
    if (
      worker.home_ref !== principal.homeRef ||
      worker.codex_profile !== principal.codexProfile ||
      worker.config_fingerprint !== principal.configFingerprint
    ) {
      throw new AppError("worker configuration changed; create a new session", 409, "worker_config_changed");
    }
    const aliases = Array.isArray(worker.workspace_aliases) ? worker.workspace_aliases.map(String) : [];
    const singleWorkspaceAlias = aliases.length === 1 ? aliases[0] as string : null;
    const leaseToken = randomToken();
    const leaseExpiresAt = new Date(Date.now() + this.leaseSeconds * 1000);
    const result = await sql<Task>`
      WITH candidate AS (
        SELECT id
        FROM tasks
        WHERE state IN ('queued', 'waiting_worker')
          AND (executor_id IS NULL OR executor_id = ${principal.executorId})
          AND (executor_config_fingerprint IS NULL OR executor_config_fingerprint = ${principal.configFingerprint})
          AND (preferred_executor_id IS NULL OR preferred_executor_id = ${principal.executorId})
          AND (
            COALESCE(requested_workspace_alias, resolved_workspace_alias) = ANY(${sql.val(aliases)}::text[])
            OR (
              requested_workspace_alias IS NULL
              AND resolved_workspace_alias IS NULL
              AND ${singleWorkspaceAlias}::text IS NOT NULL
            )
          )
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE tasks t
      SET state = 'running',
          executor_id = ${principal.executorId},
          executor_home_ref = ${principal.homeRef},
          executor_profile = ${principal.codexProfile},
          executor_config_fingerprint = ${principal.configFingerprint},
          codex_version = ${worker.codex_version},
          resolved_workspace_alias = COALESCE(t.resolved_workspace_alias, t.requested_workspace_alias, ${singleWorkspaceAlias}),
          lease_token_hash = ${sha256(leaseToken)},
          lease_expires_at = ${leaseExpiresAt},
          attempt = attempt + 1,
          revision = revision + 1,
          updated_at = now()
      FROM candidate
      WHERE t.id = candidate.id
      RETURNING t.*
    `.execute(this.db);
    const task = result.rows[0];
    if (!task) return null;
    return { task, leaseToken, leaseExpiresAt };
  }

  async touchWorker(executorId: string): Promise<void> {
    await this.db.updateTable("workers").set({ last_seen_at: new Date(), status: "online", updated_at: new Date() }).where("executor_id", "=", executorId).execute();
  }

  async recoverExpiredLeases(): Promise<number> {
    const result = await this.db
      .updateTable("tasks")
      .set((eb) => ({
        state: "waiting_worker",
        preferred_executor_id: eb.ref("executor_id"),
        lease_token_hash: null,
        lease_expires_at: null,
        summary: "执行器租约已过期，等待原执行器恢复",
        updated_at: new Date(),
        revision: sql`revision + 1`
      }))
      .where("state", "=", "running")
      .where("lease_expires_at", "<", new Date())
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
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

  async updateTaskThread(taskId: string, codexThreadId: string): Promise<void> {
    await this.db.updateTable("tasks").set({ codex_thread_id: codexThreadId, updated_at: new Date() }).where("id", "=", taskId).execute();
  }

  async finishTask(
    taskId: string,
    state: "completed" | "failed" | "waiting_input" | "human_owned",
    summary: string,
    lifecycle?: { disposition: "complete" | "awaiting_followup" | "unchanged"; processedRoomSeq: number; reason: string }
  ): Promise<{ nextTaskId: string | null }> {
    return this.db.transaction().execute(async (trx) => {
      const now = new Date();
      const current = await trx.selectFrom("tasks").selectAll().where("id", "=", taskId).forUpdate().executeTakeFirst();
      if (!current) return { nextTaskId: null };
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

      if (state !== "completed") {
        await trx.updateTable("conversations").set({ active: state !== "failed", updated_at: now }).where("id", "=", conversation.id).execute();
        return { nextTaskId: null };
      }

      const pending = lifecycle
        ? await trx.selectFrom("signals").selectAll().where("task_id", "=", taskId).where("seq", ">", lifecycle.processedRoomSeq).orderBy("seq").execute()
        : [];
      if (conversation.chat_type === "group" && pending.length) {
        const first = pending[0] as (typeof pending)[number];
        const next = await trx.insertInto("tasks").values({
          conversation_id: conversation.id,
          state: current.executor_id ? "waiting_worker" : "queued",
          turn_index: current.turn_index + 1,
          trigger_message_id: first.message_id,
          conversation_disposition: null,
          disposition_reason: null,
          requester_id: first.sender_id,
          requester_role: first.sender_role,
          authorization_grant: JSON.stringify(authorizationFromMessage(first.content, first.sender_role === "owner")),
          requested_workspace_alias: current.requested_workspace_alias,
          resolved_workspace_alias: current.resolved_workspace_alias,
          preferred_executor_id: current.executor_id ?? current.preferred_executor_id,
          executor_id: current.executor_id,
          codex_thread_id: current.codex_thread_id,
          executor_home_ref: current.executor_home_ref,
          executor_profile: current.executor_profile,
          executor_config_fingerprint: current.executor_config_fingerprint,
          codex_version: current.codex_version,
          lease_token_hash: null,
          lease_expires_at: null,
          summary: null,
          completed_at: null,
          updated_at: now
        }).returning("id").executeTakeFirstOrThrow();
        await trx.updateTable("signals").set({ task_id: next.id }).where("task_id", "=", taskId).where("seq", ">", lifecycle?.processedRoomSeq ?? 0).execute();
        const pendingDeadline = lifecycle?.disposition === "awaiting_followup"
          ? new Date(now.getTime() + 24 * 60 * 60_000)
          : conversation.followup_expires_at;
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

  async expireFollowupConversations(): Promise<number> {
    const candidates = await this.db.selectFrom("conversations").select(["id", "chat_id"]).where("active", "=", true).where("followup_expires_at", "<=", new Date()).execute();
    let expired = 0;
    for (const candidate of candidates) {
      expired += await this.db.transaction().execute(async (trx) => {
        await sql`select pg_advisory_xact_lock(hashtext(${candidate.chat_id}))`.execute(trx);
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
