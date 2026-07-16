CREATE TABLE IF NOT EXISTS chat_thread_snapshot_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_context_id uuid NOT NULL REFERENCES chat_contexts(id) ON DELETE CASCADE,
  executor_id text NOT NULL REFERENCES workers(executor_id),
  codex_thread_id text NOT NULL,
  requested_by text NOT NULL,
  state text NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued', 'running', 'completed', 'failed', 'superseded')),
  lease_token_hash text,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  protocol_source text,
  thread_metadata jsonb,
  turn_count integer NOT NULL DEFAULT 0 CHECK (turn_count >= 0),
  item_count integer NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  last_error text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_thread_snapshot_jobs_active_context_idx
  ON chat_thread_snapshot_jobs(chat_context_id)
  WHERE state IN ('queued', 'running');
CREATE UNIQUE INDEX IF NOT EXISTS chat_thread_snapshot_jobs_current_context_idx
  ON chat_thread_snapshot_jobs(chat_context_id)
  WHERE state = 'completed';
CREATE INDEX IF NOT EXISTS chat_thread_snapshot_jobs_executor_queue_idx
  ON chat_thread_snapshot_jobs(executor_id, requested_at)
  WHERE state = 'queued';

CREATE TABLE IF NOT EXISTS chat_thread_snapshot_turns (
  job_id uuid NOT NULL REFERENCES chat_thread_snapshot_jobs(id) ON DELETE CASCADE,
  turn_index integer NOT NULL CHECK (turn_index >= 0),
  turn_id text NOT NULL,
  status text NOT NULL,
  started_at_epoch bigint,
  completed_at_epoch bigint,
  duration_ms bigint,
  error jsonb,
  raw_turn jsonb NOT NULL,
  PRIMARY KEY (job_id, turn_index)
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_thread_snapshot_turns_job_turn_idx
  ON chat_thread_snapshot_turns(job_id, turn_id);

CREATE TABLE IF NOT EXISTS chat_thread_snapshot_items (
  job_id uuid NOT NULL REFERENCES chat_thread_snapshot_jobs(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  turn_id text,
  item_index integer CHECK (item_index IS NULL OR item_index >= 0),
  item_id text NOT NULL,
  item_type text NOT NULL,
  raw_item jsonb NOT NULL,
  PRIMARY KEY (job_id, ordinal)
);

CREATE INDEX IF NOT EXISTS chat_thread_snapshot_items_job_page_idx
  ON chat_thread_snapshot_items(job_id, ordinal DESC);
CREATE INDEX IF NOT EXISTS chat_thread_snapshot_items_job_turn_idx
  ON chat_thread_snapshot_items(job_id, turn_id, item_index);
