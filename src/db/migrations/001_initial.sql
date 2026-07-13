CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS processed_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'processed',
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id text NOT NULL,
  chat_type text NOT NULL,
  root_message_id text NOT NULL,
  thread_id text,
  room_seq integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  status_card_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chat_id, root_message_id)
);

CREATE TABLE IF NOT EXISTS workers (
  executor_id text PRIMARY KEY,
  display_name text NOT NULL,
  home_ref text NOT NULL,
  codex_profile text NOT NULL,
  config_fingerprint text NOT NULL,
  codex_version text NOT NULL,
  capacity integer NOT NULL DEFAULT 1 CHECK (capacity > 0),
  workspace_aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'online',
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  state text NOT NULL,
  requester_id text NOT NULL,
  requester_role text NOT NULL,
  authorization_grant jsonb NOT NULL,
  requested_workspace_alias text,
  preferred_executor_id text,
  executor_id text REFERENCES workers(executor_id),
  codex_thread_id text,
  executor_home_ref text,
  executor_profile text,
  executor_config_fingerprint text,
  codex_version text,
  lease_token_hash text,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0,
  summary text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS tasks_claim_idx ON tasks(state, created_at);
CREATE INDEX IF NOT EXISTS tasks_executor_idx ON tasks(executor_id, state);

CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  task_id uuid NOT NULL REFERENCES tasks(id),
  event_id text NOT NULL REFERENCES processed_events(event_id),
  seq integer NOT NULL,
  message_id text NOT NULL,
  sender_id text NOT NULL,
  sender_role text NOT NULL,
  message_type text NOT NULL,
  content text NOT NULL,
  preview text NOT NULL,
  priority integer NOT NULL DEFAULT 50,
  decision text NOT NULL DEFAULT 'pending',
  decision_rationale text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  UNIQUE(conversation_id, seq),
  UNIQUE(event_id)
);

CREATE INDEX IF NOT EXISTS signals_task_seq_idx ON signals(task_id, seq);

CREATE TABLE IF NOT EXISTS task_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  event_type text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  conversation_id uuid NOT NULL REFERENCES conversations(id),
  base_room_seq integer NOT NULL,
  observed_room_seq integer NOT NULL,
  content text NOT NULL,
  state text NOT NULL,
  hold_count integer NOT NULL DEFAULT 0,
  force_requested boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  request_id text NOT NULL,
  method text NOT NULL,
  summary text NOT NULL,
  payload jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending',
  decided_by text,
  decided_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, request_id)
);

CREATE TABLE IF NOT EXISTS outbox_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  draft_id uuid REFERENCES drafts(id),
  target_message_id text NOT NULL,
  content text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'pending',
  platform_message_id text,
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);

CREATE TABLE IF NOT EXISTS action_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id),
  action_key text NOT NULL,
  action_type text NOT NULL,
  request_digest text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id, action_key)
);

CREATE TABLE IF NOT EXISTS chat_policies (
  chat_id text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  preferred_executor_id text,
  workspace_alias text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
