ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS attention_model text,
  ADD COLUMN IF NOT EXISTS attention_reasoning_effort text,
  ADD COLUMN IF NOT EXISTS execution_model text,
  ADD COLUMN IF NOT EXISTS execution_reasoning_effort text;

ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS attention_model_snapshot text,
  ADD COLUMN IF NOT EXISTS attention_reasoning_effort_snapshot text,
  ADD COLUMN IF NOT EXISTS execution_model_snapshot text,
  ADD COLUMN IF NOT EXISTS execution_reasoning_effort_snapshot text;

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS model_catalog jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS model_catalog_updated_at timestamptz;

CREATE INDEX IF NOT EXISTS task_events_type_created_idx
  ON task_events(event_type, created_at DESC);
