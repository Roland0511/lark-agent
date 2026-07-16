import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "../db/types.js";
import type {
  ThreadSnapshotChunk,
  ThreadSnapshotComplete,
  ThreadSnapshotFailure
} from "../shared/contracts.js";
import { randomToken, sha256 } from "../shared/crypto.js";
import { AppError } from "../shared/errors.js";
import type { WorkerPrincipal } from "./auth.js";
import type { AdminEventBus } from "./admin-events.js";
import { executorHasClaimCapacity, lockExecutorClaim } from "./executor-claim-lock.js";

const SNAPSHOT_LEASE_SECONDS = 60;
const SNAPSHOT_QUEUE_TIMEOUT_MS = 10 * 60_000;
const SNAPSHOT_MAX_ATTEMPTS = 3;

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function workerAvailability(value: Date | string): "online" | "stale" | "offline" {
  const age = Date.now() - new Date(value).getTime();
  return age <= 45_000 ? "online" : age <= 90_000 ? "stale" : "offline";
}

function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

function cursorFor(ordinal: number): string {
  return Buffer.from(String(ordinal), "utf8").toString("base64url");
}

function ordinalFromCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) throw new Error("invalid cursor");
    const ordinal = Number(decoded);
    if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("invalid cursor");
    return ordinal;
  } catch {
    throw new AppError("Thread 快照分页游标无效", 400, "invalid_thread_snapshot_cursor");
  }
}

function turnCursorFor(turnIndex: number): string {
  return Buffer.from(String(turnIndex), "utf8").toString("base64url");
}

function turnIndexFromCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf8");
    if (!/^\d+$/.test(decoded)) throw new Error("invalid cursor");
    const turnIndex = Number(decoded);
    if (!Number.isSafeInteger(turnIndex) || turnIndex < 0) throw new Error("invalid cursor");
    return turnIndex;
  } catch {
    throw new AppError("Thread 回合摘要分页游标无效", 400, "invalid_thread_summary_cursor");
  }
}

function capabilities(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => `${JSON.stringify(key)}:${stable(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameNullableNumber(left: number | string | bigint | null, right: number | null): boolean {
  if (left === null || right === null) return left === null && right === null;
  return Number(left) === right;
}

function sameNullableTimestamp(left: Date | string | null, right: string | null | undefined): boolean {
  if (left === null || right == null) return left === null && right == null;
  return new Date(left).getTime() === new Date(right).getTime();
}

export class ThreadSnapshotService {
  constructor(private readonly db: Kysely<Database>, private readonly events: AdminEventBus) {}

  private async expireJobs(): Promise<void> {
    const now = new Date();
    const { expiredRunning, exhausted, timedOut } = await this.db.transaction().execute(async (trx) => {
      const expiredRunning = await trx.updateTable("chat_thread_snapshot_jobs").set({
        state: "queued", lease_token_hash: null, lease_expires_at: null,
        last_error: "上一次 Thread 快照租约已过期，正在重试", updated_at: now
      }).where("state", "=", "running").where("lease_expires_at", "<", now).where("attempt", "<", SNAPSHOT_MAX_ATTEMPTS)
        .returning(["id", "chat_context_id"]).execute();
      const exhausted = await trx.updateTable("chat_thread_snapshot_jobs").set({
        state: "failed", lease_token_hash: null, lease_expires_at: null,
        last_error: `Thread 快照连续 ${SNAPSHOT_MAX_ATTEMPTS} 次租约过期`, updated_at: now
      }).where("state", "=", "running").where("lease_expires_at", "<", now).where("attempt", ">=", SNAPSHOT_MAX_ATTEMPTS)
        .returning(["id", "chat_context_id"]).execute();
      const resetIds = [...expiredRunning, ...exhausted].map((row) => row.id);
      if (resetIds.length) {
        await trx.deleteFrom("chat_thread_snapshot_items").where("job_id", "in", resetIds).execute();
        await trx.deleteFrom("chat_thread_snapshot_turns").where("job_id", "in", resetIds).execute();
      }
      const timedOut = await trx.updateTable("chat_thread_snapshot_jobs").set({
        state: "failed", last_error: "等待原执行器读取 Thread 超过 10 分钟", updated_at: now
      }).where("state", "=", "queued").where("requested_at", "<", new Date(now.getTime() - SNAPSHOT_QUEUE_TIMEOUT_MS))
        .returning(["id", "chat_context_id"]).execute();
      return { expiredRunning, exhausted, timedOut };
    });
    for (const contextId of new Set([...expiredRunning, ...exhausted, ...timedOut].map((row) => row.chat_context_id))) {
      this.events.publish("chat_context", contextId);
    }
  }

  async enqueue(contextId: string, actorOpenId: string): Promise<{ jobId: string; state: string; existing: boolean }> {
    const result = await this.db.transaction().execute(async (trx) => {
      await sql`select pg_advisory_xact_lock(hashtext(${`thread-snapshot:${contextId}`}))`.execute(trx);
      const context = await trx.selectFrom("chat_contexts").select([
        "id", "codex_thread_id", "executor_id", "state"
      ]).where("id", "=", contextId).forUpdate().executeTakeFirst();
      if (!context) throw new AppError("聊天记忆不存在", 404, "chat_context_not_found");
      if (context.state === "uninitialized" || !context.codex_thread_id || !context.executor_id) {
        throw new AppError("聊天记忆尚未建立可读取的 Codex Thread", 409, "thread_snapshot_uninitialized");
      }
      const worker = await trx.selectFrom("workers").select(["executor_id", "capabilities", "deleted_at"])
        .where("executor_id", "=", context.executor_id).executeTakeFirst();
      if (!worker || worker.deleted_at) throw new AppError("原执行器不存在，无法读取 Thread", 409, "thread_snapshot_executor_missing");
      if (!capabilities(worker.capabilities).includes("thread_snapshot_v1")) {
        throw new AppError("原执行器版本尚不支持 Thread 快照，请先升级 Runner", 409, "thread_snapshot_unsupported");
      }
      const existing = await trx.selectFrom("chat_thread_snapshot_jobs").select(["id", "state"])
        .where("chat_context_id", "=", contextId).where("state", "in", ["queued", "running"]).executeTakeFirst();
      if (existing) return { jobId: existing.id, state: existing.state, existing: true };
      await trx.deleteFrom("chat_thread_snapshot_jobs").where("chat_context_id", "=", contextId)
        .where("state", "in", ["failed", "superseded"]).execute();
      const inserted = await trx.insertInto("chat_thread_snapshot_jobs").values({
        chat_context_id: context.id, executor_id: context.executor_id, codex_thread_id: context.codex_thread_id,
        requested_by: actorOpenId, state: "queued", lease_token_hash: null, lease_expires_at: null,
        protocol_source: null, thread_metadata: null, last_error: null, started_at: null, completed_at: null
      }).returning(["id", "state"]).executeTakeFirstOrThrow();
      return { jobId: inserted.id, state: inserted.state, existing: false };
    });
    this.events.publish("chat_context", contextId);
    return result;
  }

  async claim(principal: WorkerPrincipal): Promise<{
    id: string;
    chatContextId: string;
    threadId: string;
    leaseToken: string;
    leaseExpiresAt: string;
    attempt: number;
    summaryEnabled: boolean;
    summaryModel: string | null;
    summaryReasoningEffort: string | null;
  } | null> {
    await this.expireJobs();
    const token = randomToken();
    const leaseExpiresAt = new Date(Date.now() + SNAPSHOT_LEASE_SECONDS * 1_000);
    const result = await this.db.transaction().execute(async (trx) => {
      await lockExecutorClaim(trx, principal.executorId);
      const worker = await trx.selectFrom("workers").select([
        "capacity", "operational_mode", "home_ref", "codex_profile", "config_fingerprint",
        "workspace_mapping_fingerprint", "capabilities", "upgrade_drain_token_hash", "deleted_at"
      ]).where("executor_id", "=", principal.executorId).forUpdate().executeTakeFirst();
      if (!worker || worker.deleted_at) return null;
      if (worker.home_ref !== principal.homeRef || worker.codex_profile !== principal.codexProfile || worker.config_fingerprint !== principal.configFingerprint
        || worker.workspace_mapping_fingerprint !== (principal.workspaceMappingFingerprint ?? null)) {
        throw new AppError("worker configuration changed; create a new session", 409, "worker_config_changed");
      }
      if (worker.upgrade_drain_token_hash || !["enabled", "maintenance"].includes(worker.operational_mode)
        || !capabilities(worker.capabilities).includes("thread_snapshot_v1")) return null;
      if (!await executorHasClaimCapacity(trx, principal.executorId, worker.capacity)) return null;
      const claimed = await sql<{
        id: string; chat_context_id: string; codex_thread_id: string; attempt: number;
      }>`
        WITH candidate AS (
          SELECT job.id
          FROM chat_thread_snapshot_jobs job
          JOIN chat_contexts context ON context.id = job.chat_context_id
          WHERE job.executor_id = ${principal.executorId}
            AND job.state = 'queued'
            AND context.state IN ('ready', 'blocked')
            AND context.executor_id = ${principal.executorId}
            AND context.codex_thread_id = job.codex_thread_id
            AND context.executor_home_ref = ${principal.homeRef}
            AND context.executor_profile = ${principal.codexProfile}
            AND context.executor_config_fingerprint = ${principal.configFingerprint}
            AND context.executor_workspace_mapping_fingerprint IS NOT DISTINCT FROM ${principal.workspaceMappingFingerprint ?? null}
          ORDER BY job.requested_at
          FOR UPDATE OF job, context SKIP LOCKED
          LIMIT 1
        )
        UPDATE chat_thread_snapshot_jobs job
        SET state = 'running', lease_token_hash = ${sha256(token)}, lease_expires_at = ${leaseExpiresAt},
            attempt = attempt + 1, started_at = COALESCE(started_at, now()), last_error = NULL, updated_at = now()
        FROM candidate WHERE job.id = candidate.id
        RETURNING job.id, job.chat_context_id, job.codex_thread_id, job.attempt
      `.execute(trx);
      const job = claimed.rows[0] ?? null;
      if (!job) return null;
      const summaryEnabled = capabilities(worker.capabilities).includes("thread_turn_summary_v1");
      const policy = summaryEnabled ? await trx.selectFrom("chat_contexts")
        .innerJoin("bots", "bots.id", "chat_contexts.bot_id")
        .select(["bots.attention_model", "bots.attention_reasoning_effort"])
        .where("chat_contexts.id", "=", job.chat_context_id).executeTakeFirstOrThrow() : null;
      return {
        ...job,
        summaryEnabled,
        summaryModel: policy?.attention_model ?? null,
        summaryReasoningEffort: policy?.attention_reasoning_effort ?? null
      };
    });
    if (!result) return null;
    this.events.publish("chat_context", result.chat_context_id);
    return {
      id: result.id, chatContextId: result.chat_context_id, threadId: result.codex_thread_id,
      leaseToken: token, leaseExpiresAt: leaseExpiresAt.toISOString(), attempt: result.attempt,
      summaryEnabled: result.summaryEnabled, summaryModel: result.summaryModel,
      summaryReasoningEffort: result.summaryReasoningEffort
    };
  }

  async heartbeat(executorId: string, jobId: string, leaseToken: string): Promise<{ leaseExpiresAt: string }> {
    const leaseExpiresAt = new Date(Date.now() + SNAPSHOT_LEASE_SECONDS * 1_000);
    const updated = await this.db.updateTable("chat_thread_snapshot_jobs").set({ lease_expires_at: leaseExpiresAt, updated_at: new Date() })
      .where("id", "=", jobId).where("executor_id", "=", executorId).where("state", "=", "running")
      .where("lease_token_hash", "=", sha256(leaseToken)).where("lease_expires_at", ">", new Date())
      .returning("id").executeTakeFirst();
    if (!updated) throw new AppError("Thread 快照租约无效或已过期", 409, "invalid_thread_snapshot_lease");
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  }

  private async lockedJob(
    trx: Transaction<Database>, executorId: string, jobId: string, leaseToken: string
  ) {
    const job = await trx.selectFrom("chat_thread_snapshot_jobs").selectAll()
      .where("id", "=", jobId).where("executor_id", "=", executorId).where("state", "=", "running")
      .where("lease_token_hash", "=", sha256(leaseToken)).where("lease_expires_at", ">", new Date())
      .forUpdate().executeTakeFirst();
    if (!job) throw new AppError("Thread 快照租约无效或已过期", 409, "invalid_thread_snapshot_lease");
    return job;
  }

  async previousAiSummaries(
    executorId: string,
    jobId: string,
    leaseToken: string,
    cursor: string | undefined,
    limit: number
  ) {
    const before = turnIndexFromCursor(cursor);
    return this.db.transaction().execute(async (trx) => {
      const job = await this.lockedJob(trx, executorId, jobId, leaseToken);
      const previous = await trx.selectFrom("chat_thread_snapshot_jobs").select("id")
        .where("chat_context_id", "=", job.chat_context_id).where("state", "=", "completed")
        .executeTakeFirst();
      if (!previous) return { summaries: [], nextCursor: null };
      let query = trx.selectFrom("chat_thread_snapshot_turns")
        .select(["turn_index", "turn_id", "summary", "summary_model", "summary_generated_at"])
        .where("job_id", "=", previous.id).where("summary_source", "=", "ai").where("summary", "is not", null);
      if (before !== null) query = query.where("turn_index", "<", before);
      const rows = await query.orderBy("turn_index", "desc").limit(limit + 1).execute();
      const hasMore = rows.length > limit;
      const page = rows.slice(0, limit);
      return {
        summaries: page.map((turn) => ({
          turnId: turn.turn_id,
          summary: turn.summary as string,
          summaryModel: turn.summary_model,
          summaryGeneratedAt: iso(turn.summary_generated_at) as string
        })),
        nextCursor: hasMore && page.length ? turnCursorFor(page.at(-1)!.turn_index) : null
      };
    });
  }

  async uploadChunk(executorId: string, jobId: string, leaseToken: string, chunk: ThreadSnapshotChunk): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await this.lockedJob(trx, executorId, jobId, leaseToken);
      for (const turn of chunk.turns) {
        const existing = await trx.selectFrom("chat_thread_snapshot_turns").selectAll()
          .where("job_id", "=", jobId).where("turn_index", "=", turn.turnIndex).executeTakeFirst();
        if (existing) {
          const matches = existing.turn_id === turn.turnId && existing.status === turn.status
            && sameNullableNumber(existing.started_at_epoch, turn.startedAt) && sameNullableNumber(existing.completed_at_epoch, turn.completedAt)
            && sameNullableNumber(existing.duration_ms, turn.durationMs) && stable(existing.error) === stable(turn.error)
            && stable(existing.raw_turn) === stable(turn.raw) && existing.summary === (turn.summary ?? null)
            && existing.summary_source === (turn.summarySource ?? null) && existing.summary_model === (turn.summaryModel ?? null)
            && sameNullableTimestamp(existing.summary_generated_at, turn.summaryGeneratedAt);
          if (!matches) throw new AppError("重复的 Thread 回合分块内容不一致", 409, "thread_snapshot_chunk_conflict");
          continue;
        }
        await trx.insertInto("chat_thread_snapshot_turns").values({
          job_id: jobId, turn_index: turn.turnIndex, turn_id: turn.turnId, status: turn.status,
          started_at_epoch: turn.startedAt, completed_at_epoch: turn.completedAt, duration_ms: turn.durationMs,
          error: json(turn.error), raw_turn: json(turn.raw), summary: turn.summary ?? null,
          summary_source: turn.summarySource ?? null, summary_model: turn.summaryModel ?? null,
          summary_generated_at: turn.summaryGeneratedAt ? new Date(turn.summaryGeneratedAt) : null
        }).execute();
      }
      for (const item of chunk.items) {
        const existing = await trx.selectFrom("chat_thread_snapshot_items").selectAll()
          .where("job_id", "=", jobId).where("ordinal", "=", item.ordinal).executeTakeFirst();
        if (existing) {
          const matches = existing.turn_id === item.turnId && sameNullableNumber(existing.item_index, item.itemIndex)
            && existing.item_id === item.itemId && existing.item_type === item.itemType && stable(existing.raw_item) === stable(item.raw);
          if (!matches) throw new AppError("重复的 Thread Item 分块内容不一致", 409, "thread_snapshot_chunk_conflict");
          continue;
        }
        await trx.insertInto("chat_thread_snapshot_items").values({
          job_id: jobId, ordinal: item.ordinal, turn_id: item.turnId, item_index: item.itemIndex,
          item_id: item.itemId, item_type: item.itemType, raw_item: json(item.raw)
        }).execute();
      }
      await trx.updateTable("chat_thread_snapshot_jobs").set({ updated_at: new Date() }).where("id", "=", jobId).execute();
    });
  }

  private async assertCurrentIdentity(trx: Transaction<Database>, principal: WorkerPrincipal, job: {
    chat_context_id: string; executor_id: string; codex_thread_id: string;
  }): Promise<void> {
    const context = await trx.selectFrom("chat_contexts").select([
      "executor_id", "codex_thread_id", "executor_home_ref", "executor_profile",
      "executor_config_fingerprint", "executor_workspace_mapping_fingerprint", "state"
    ]).where("id", "=", job.chat_context_id).forUpdate().executeTakeFirst();
    const matched = context && context.state !== "uninitialized" && context.executor_id === job.executor_id
      && context.codex_thread_id === job.codex_thread_id && context.executor_home_ref === principal.homeRef
      && context.executor_profile === principal.codexProfile && context.executor_config_fingerprint === principal.configFingerprint
      && context.executor_workspace_mapping_fingerprint === (principal.workspaceMappingFingerprint ?? null);
    if (!matched) throw new AppError("聊天记忆固定环境已变化，拒绝保存 Thread 快照", 409, "thread_snapshot_identity_changed");
  }

  async complete(principal: WorkerPrincipal, jobId: string, leaseToken: string, body: ThreadSnapshotComplete): Promise<void> {
    const contextId = await this.db.transaction().execute(async (trx) => {
      const job = await this.lockedJob(trx, principal.executorId, jobId, leaseToken);
      await this.assertCurrentIdentity(trx, principal, job);
      const metadata = body.threadMetadata && typeof body.threadMetadata === "object" ? body.threadMetadata as Record<string, unknown> : {};
      if (metadata.id !== job.codex_thread_id) throw new AppError("Thread 快照返回了不同的 Thread ID", 409, "thread_snapshot_thread_mismatch");
      const [turns, items] = await Promise.all([
        trx.selectFrom("chat_thread_snapshot_turns").select([
          sql<number>`count(*)::int`.as("count"), sql<number | null>`min(turn_index)::int`.as("min"), sql<number | null>`max(turn_index)::int`.as("max")
        ]).where("job_id", "=", job.id).executeTakeFirstOrThrow(),
        trx.selectFrom("chat_thread_snapshot_items").select([
          sql<number>`count(*)::int`.as("count"), sql<number | null>`min(ordinal)::int`.as("min"), sql<number | null>`max(ordinal)::int`.as("max")
        ]).where("job_id", "=", job.id).executeTakeFirstOrThrow()
      ]);
      const turnsContiguous = body.turnCount === 0 ? turns.count === 0 : turns.count === body.turnCount && turns.min === 0 && turns.max === body.turnCount - 1;
      const itemsContiguous = body.itemCount === 0 ? items.count === 0 : items.count === body.itemCount && items.min === 0 && items.max === body.itemCount - 1;
      if (!turnsContiguous || !itemsContiguous) throw new AppError("Thread 快照分块不完整", 409, "thread_snapshot_incomplete");
      await trx.updateTable("chat_thread_snapshot_jobs").set({ state: "superseded", updated_at: new Date() })
        .where("chat_context_id", "=", job.chat_context_id).where("state", "=", "completed").execute();
      const completed = await trx.updateTable("chat_thread_snapshot_jobs").set({
        state: "completed", protocol_source: body.protocolSource, thread_metadata: json(body.threadMetadata),
        turn_count: body.turnCount, item_count: body.itemCount, last_error: null,
        lease_token_hash: null, lease_expires_at: null, completed_at: new Date(), updated_at: new Date()
      }).where("id", "=", job.id).where("state", "=", "running").returning("id").executeTakeFirst();
      if (!completed) throw new AppError("Thread 快照状态已变化", 409, "thread_snapshot_state_changed");
      await trx.deleteFrom("chat_thread_snapshot_jobs").where("chat_context_id", "=", job.chat_context_id)
        .where("state", "in", ["superseded", "failed"]).execute();
      return job.chat_context_id;
    });
    this.events.publish("chat_context", contextId);
  }

  async fail(executorId: string, jobId: string, leaseToken: string, body: ThreadSnapshotFailure): Promise<void> {
    const contextId = await this.db.transaction().execute(async (trx) => {
      const job = await this.lockedJob(trx, executorId, jobId, leaseToken);
      await trx.deleteFrom("chat_thread_snapshot_items").where("job_id", "=", job.id).execute();
      await trx.deleteFrom("chat_thread_snapshot_turns").where("job_id", "=", job.id).execute();
      await trx.updateTable("chat_thread_snapshot_jobs").set({
        state: "failed", last_error: body.summary, lease_token_hash: null, lease_expires_at: null, updated_at: new Date()
      }).where("id", "=", job.id).execute();
      return job.chat_context_id;
    });
    this.events.publish("chat_context", contextId);
  }

  async view(contextId: string, cursor: string | undefined, limit: number) {
    await this.expireJobs();
    const context = await this.db.selectFrom("chat_contexts").select("id").where("id", "=", contextId).executeTakeFirst();
    if (!context) throw new AppError("聊天记忆不存在", 404, "chat_context_not_found");
    const [snapshot, refresh] = await Promise.all([
      this.db.selectFrom("chat_thread_snapshot_jobs").selectAll().where("chat_context_id", "=", contextId)
        .where("state", "=", "completed").executeTakeFirst(),
      this.db.selectFrom("chat_thread_snapshot_jobs").select(["id", "executor_id", "state", "attempt", "last_error", "requested_at", "started_at", "updated_at"])
        .where("chat_context_id", "=", contextId).where("state", "in", ["queued", "running", "failed"])
        .orderBy("requested_at", "desc").executeTakeFirst()
    ]);
    const refreshWorker = refresh ? await this.db.selectFrom("workers").select(["last_seen_at", "runner_version"])
      .where("executor_id", "=", refresh.executor_id).executeTakeFirst() : null;
    const refreshView = refresh ? {
      id: refresh.id, state: refresh.state, attempt: refresh.attempt, error: refresh.last_error,
      requestedAt: iso(refresh.requested_at), startedAt: iso(refresh.started_at), updatedAt: iso(refresh.updated_at),
      executorAvailability: refreshWorker ? workerAvailability(refreshWorker.last_seen_at) : "offline",
      executorLastSeenAt: iso(refreshWorker?.last_seen_at ?? null), runnerVersion: refreshWorker?.runner_version ?? null
    } : null;
    if (!snapshot) {
      return { snapshot: null, refresh: refreshView, items: [], turns: [], nextCursor: null };
    }
    const before = ordinalFromCursor(cursor);
    let itemQuery = this.db.selectFrom("chat_thread_snapshot_items").selectAll().where("job_id", "=", snapshot.id);
    if (before !== null) itemQuery = itemQuery.where("ordinal", "<", before);
    const rows = await itemQuery.orderBy("ordinal", "desc").limit(limit + 1).execute();
    const hasMore = rows.length > limit;
    const pageDescending = rows.slice(0, limit);
    const page = [...pageDescending].reverse();
    const turnIds = [...new Set(page.map((item) => item.turn_id).filter((value): value is string => Boolean(value)))];
    const turns = turnIds.length ? await this.db.selectFrom("chat_thread_snapshot_turns").selectAll()
      .where("job_id", "=", snapshot.id).where("turn_id", "in", turnIds).orderBy("turn_index").execute() : [];
    return {
      snapshot: {
        id: snapshot.id, threadId: snapshot.codex_thread_id, executorId: snapshot.executor_id,
        protocolSource: snapshot.protocol_source, thread: snapshot.thread_metadata,
        turnCount: snapshot.turn_count, itemCount: snapshot.item_count,
        requestedAt: iso(snapshot.requested_at), startedAt: iso(snapshot.started_at), completedAt: iso(snapshot.completed_at)
      },
      refresh: refreshView,
      items: page.map((item) => ({
        ordinal: item.ordinal, turnId: item.turn_id, itemIndex: item.item_index,
        itemId: item.item_id, itemType: item.item_type, raw: item.raw_item
      })),
      turns: turns.map((turn) => ({
        turnIndex: turn.turn_index, turnId: turn.turn_id, status: turn.status,
        startedAt: turn.started_at_epoch, completedAt: turn.completed_at_epoch,
        durationMs: turn.duration_ms, error: turn.error, raw: turn.raw_turn,
        summary: turn.summary, summarySource: turn.summary_source, summaryModel: turn.summary_model,
        summaryGeneratedAt: iso(turn.summary_generated_at)
      })),
      nextCursor: hasMore && pageDescending.length ? cursorFor(pageDescending.at(-1)!.ordinal) : null
    };
  }
}
