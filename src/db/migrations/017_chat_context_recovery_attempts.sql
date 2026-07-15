CREATE TABLE IF NOT EXISTS chat_context_recovery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_context_id uuid NOT NULL REFERENCES chat_contexts(id) ON DELETE CASCADE,
  actor_open_id text NOT NULL,
  state_before text NOT NULL CHECK (state_before IN ('uninitialized', 'ready', 'blocked')),
  state_after text NOT NULL CHECK (state_after IN ('uninitialized', 'ready', 'blocked')),
  result text NOT NULL CHECK (result IN ('recovered', 'already_ready', 'check_failed', 'uninitialized')),
  failed_check_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_context_recovery_attempts_context_time_idx
  ON chat_context_recovery_attempts(chat_context_id, checked_at DESC);
