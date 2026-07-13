ALTER TABLE bots
  ADD COLUMN IF NOT EXISTS permission_state text NOT NULL DEFAULT 'unchecked'
    CHECK (permission_state IN ('unchecked', 'valid', 'missing', 'error')),
  ADD COLUMN IF NOT EXISTS permission_check jsonb,
  ADD COLUMN IF NOT EXISTS permission_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS bots_permission_state_idx
  ON bots(permission_state)
  WHERE deleted_at IS NULL;
