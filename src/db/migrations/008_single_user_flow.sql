DROP TABLE IF EXISTS admin_audit_events;

DELETE FROM admin_sessions WHERE role <> 'owner';
DELETE FROM admin_login_tokens WHERE role <> 'owner';
ALTER TABLE admin_sessions DROP CONSTRAINT IF EXISTS admin_sessions_role_check;
ALTER TABLE admin_sessions ADD CONSTRAINT admin_sessions_role_check CHECK (role = 'owner');
ALTER TABLE admin_login_tokens DROP CONSTRAINT IF EXISTS admin_login_tokens_role_check;
ALTER TABLE admin_login_tokens ADD CONSTRAINT admin_login_tokens_role_check CHECK (role = 'owner');

CREATE INDEX IF NOT EXISTS signals_decision_created_idx
  ON signals (decision, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS drafts_state_created_idx
  ON drafts (state, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS task_events_task_created_idx
  ON task_events (task_id, created_at, id);
CREATE INDEX IF NOT EXISTS task_output_updates_task_created_idx
  ON task_output_updates (task_id, created_at, id);
