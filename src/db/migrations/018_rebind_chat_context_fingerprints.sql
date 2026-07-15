-- Runner 0.3.1 replaces the overly broad whole-config hash with a stable
-- continuity fingerprint. Rebind blocked contexts only when their pinned
-- executor is online and every other durable identity still matches.
WITH rebound AS (
  UPDATE chat_contexts context
  SET
    executor_config_fingerprint = worker.config_fingerprint,
    codex_version = worker.codex_version,
    state = 'ready',
    blocked_reason = NULL,
    updated_at = now()
  FROM workers worker
  WHERE context.state = 'blocked'
    AND context.executor_id = worker.executor_id
    AND context.codex_thread_id IS NOT NULL
    AND context.executor_home_ref = worker.home_ref
    AND context.executor_profile = worker.codex_profile
    AND context.workspace_root_alias IS NOT NULL
    AND worker.workspace_aliases ? context.workspace_root_alias
    AND worker.capabilities ? 'chat_context_v1'
    AND worker.operational_mode = 'enabled'
    AND worker.deleted_at IS NULL
    AND worker.last_seen_at >= now() - interval '2 minutes'
    AND worker.runner_version = '0.3.1'
  RETURNING context.id
)
INSERT INTO chat_context_recovery_attempts (
  chat_context_id,
  actor_open_id,
  state_before,
  state_after,
  result,
  failed_check_keys,
  checked_at
)
SELECT id, 'system:migration-018', 'blocked', 'ready', 'recovered', '[]'::jsonb, now()
FROM rebound;
