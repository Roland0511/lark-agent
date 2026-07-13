ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS workers_active_display_name_idx
  ON workers (display_name)
  WHERE deleted_at IS NULL;
