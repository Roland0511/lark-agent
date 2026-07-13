ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 0;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS operational_mode text NOT NULL DEFAULT 'enabled'
  CHECK (operational_mode IN ('enabled', 'maintenance', 'disabled'));

CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  open_id text NOT NULL,
  display_name text,
  role text NOT NULL CHECK (role IN ('owner', 'operator')),
  csrf_token text NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_open_id text NOT NULL,
  actor_role text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  reason text NOT NULL,
  outcome text NOT NULL,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS admin_audit_idempotency_idx
  ON admin_audit_events(actor_open_id, action, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND outcome = 'success';

CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  kind text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('warning', 'critical')),
  title text NOT NULL,
  summary text NOT NULL,
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'resolved')),
  related_type text,
  related_id text,
  occurrence_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  notification_message_id text,
  last_notified_at timestamptz,
  last_notification_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_state_updated_idx ON tasks(state, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS tasks_created_id_idx ON tasks(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS approvals_state_created_idx ON approvals(state, created_at DESC);
CREATE INDEX IF NOT EXISTS outbox_state_created_idx ON outbox_messages(state, created_at DESC);
CREATE INDEX IF NOT EXISTS incidents_state_severity_idx ON incidents(state, severity, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit_events(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry_idx ON admin_sessions(expires_at);
