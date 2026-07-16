import { sql, type Transaction } from "kysely";
import type { Database } from "../db/types.js";

export const executorActiveTaskStates = ["running", "waiting_approval", "held_draft", "human_owned"] as const;

/**
 * Serialize every operation that consumes an executor slot, including calls
 * made with different (but still valid) worker session tokens.
 */
export async function lockExecutorClaim(trx: Transaction<Database>, executorId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtext(${`executor-claim:${executorId}`}))`.execute(trx);
}

/** Must only be called after lockExecutorClaim in the same transaction. */
export async function executorHasClaimCapacity(
  trx: Transaction<Database>,
  executorId: string,
  capacity: number
): Promise<boolean> {
  const usage = await trx.selectNoFrom((eb) => [
    eb.selectFrom("tasks")
      .select((task) => task.fn.countAll<number>().as("count"))
      .where("executor_id", "=", executorId)
      .where("state", "in", [...executorActiveTaskStates])
      .as("active_tasks"),
    eb.selectFrom("skill_file_sync_jobs")
      .select((job) => job.fn.countAll<number>().as("count"))
      .where("executor_id", "=", executorId)
      .where("state", "=", "running")
      .where("lease_expires_at", ">", new Date())
      .as("running_syncs"),
    eb.selectFrom("chat_thread_snapshot_jobs")
      .select((job) => job.fn.countAll<number>().as("count"))
      .where("executor_id", "=", executorId)
      .where("state", "=", "running")
      .where("lease_expires_at", ">", new Date())
      .as("running_thread_snapshots")
  ]).executeTakeFirstOrThrow();
  return Number(usage.active_tasks) + Number(usage.running_syncs) + Number(usage.running_thread_snapshots) < capacity;
}
