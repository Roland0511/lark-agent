ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS manager_version text,
  ADD COLUMN IF NOT EXISTS manager_last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS available_profiles jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS device_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  executor_id text NOT NULL REFERENCES workers(executor_id),
  command_type text NOT NULL
    CHECK (command_type IN ('status', 'start', 'stop', 'restart', 'logs', 'switch_profile')),
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
  requested_by text NOT NULL,
  previous_operational_mode text
    CHECK (previous_operational_mode IS NULL OR previous_operational_mode IN ('enabled', 'maintenance', 'disabled')),
  lease_token_hash text,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  result jsonb,
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS device_commands_active_executor_idx
  ON device_commands(executor_id)
  WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS device_commands_executor_history_idx
  ON device_commands(executor_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS profile_switch_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id uuid NOT NULL UNIQUE REFERENCES device_commands(id) ON DELETE CASCADE,
  executor_id text NOT NULL REFERENCES workers(executor_id),
  source_profile text NOT NULL,
  source_config_fingerprint text NOT NULL,
  target_profile text NOT NULL,
  target_config_fingerprint text,
  state text NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing', 'ready', 'switching', 'committing', 'succeeded', 'rolling_back', 'rolled_back', 'failed')),
  context_count integer NOT NULL DEFAULT 0 CHECK (context_count >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS profile_switch_contexts (
  migration_id uuid NOT NULL REFERENCES profile_switch_migrations(id) ON DELETE CASCADE,
  chat_context_id uuid NOT NULL REFERENCES chat_contexts(id) ON DELETE CASCADE,
  bot_app_id text NOT NULL,
  workspace_root_alias text,
  source_thread_id text NOT NULL,
  target_thread_id text,
  snapshot_job_id uuid REFERENCES chat_thread_snapshot_jobs(id),
  migration_summary text,
  summary_sha256 text,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'snapshotting', 'ready', 'imported', 'failed')),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (migration_id, chat_context_id)
);

CREATE INDEX IF NOT EXISTS profile_switch_contexts_context_idx
  ON profile_switch_contexts(chat_context_id, created_at DESC);
