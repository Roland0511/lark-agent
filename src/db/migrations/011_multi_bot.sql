CREATE TABLE IF NOT EXISTS bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL UNIQUE,
  profile_name text UNIQUE,
  bot_open_id text,
  display_name text NOT NULL,
  role_instructions text NOT NULL DEFAULT '',
  owner_open_id text,
  default_executor_id text REFERENCES workers(executor_id),
  default_workspace_alias text,
  enabled boolean NOT NULL DEFAULT true,
  is_system boolean NOT NULL DEFAULT false,
  config_revision integer NOT NULL DEFAULT 1,
  credential_state text NOT NULL DEFAULT 'verified'
    CHECK (credential_state IN ('pending', 'verified', 'error')),
  credential_error text,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bots (
  id, app_id, profile_name, display_name, enabled, is_system, credential_state
) VALUES (
  '00000000-0000-0000-0000-000000000001', '__legacy__', NULL, 'Lark Agent', true, true, 'verified'
) ON CONFLICT (id) DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS bots_single_system_idx
  ON bots (is_system) WHERE is_system = true AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bots_active_idx
  ON bots (enabled, display_name) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS bot_chat_bindings (
  bot_id uuid NOT NULL REFERENCES bots(id),
  chat_id text NOT NULL,
  chat_name text,
  enabled boolean NOT NULL DEFAULT true,
  preferred_executor_id text REFERENCES workers(executor_id),
  workspace_alias text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, chat_id)
);

CREATE TABLE IF NOT EXISTS bot_owner_binding_tokens (
  token_hash text PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_owner_binding_tokens_expiry_idx
  ON bot_owner_binding_tokens (expires_at);

ALTER TABLE processed_events ADD COLUMN IF NOT EXISTS bot_id uuid REFERENCES bots(id);
UPDATE processed_events SET bot_id = '00000000-0000-0000-0000-000000000001' WHERE bot_id IS NULL;
ALTER TABLE processed_events ALTER COLUMN bot_id SET NOT NULL;
ALTER TABLE processed_events ALTER COLUMN bot_id SET DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE signals ADD COLUMN IF NOT EXISTS bot_id uuid REFERENCES bots(id);
UPDATE signals SET bot_id = '00000000-0000-0000-0000-000000000001' WHERE bot_id IS NULL;
ALTER TABLE signals ALTER COLUMN bot_id SET NOT NULL;
ALTER TABLE signals ALTER COLUMN bot_id SET DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_id uuid REFERENCES bots(id);
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS bot_config_revision integer NOT NULL DEFAULT 1;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS role_instructions_snapshot text NOT NULL DEFAULT '';
UPDATE conversations SET bot_id = '00000000-0000-0000-0000-000000000001' WHERE bot_id IS NULL;
ALTER TABLE conversations ALTER COLUMN bot_id SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN bot_id SET DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bot_id uuid REFERENCES bots(id);
UPDATE tasks SET bot_id = '00000000-0000-0000-0000-000000000001' WHERE bot_id IS NULL;
ALTER TABLE tasks ALTER COLUMN bot_id SET NOT NULL;
ALTER TABLE tasks ALTER COLUMN bot_id SET DEFAULT '00000000-0000-0000-0000-000000000001';

ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_event_id_fkey;
ALTER TABLE signals DROP CONSTRAINT IF EXISTS signals_event_id_key;
ALTER TABLE processed_events DROP CONSTRAINT IF EXISTS processed_events_pkey;
ALTER TABLE processed_events ADD PRIMARY KEY (bot_id, event_id);
ALTER TABLE signals ADD CONSTRAINT signals_bot_event_fkey
  FOREIGN KEY (bot_id, event_id) REFERENCES processed_events(bot_id, event_id);
CREATE UNIQUE INDEX IF NOT EXISTS signals_bot_event_idx ON signals(bot_id, event_id);

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_chat_id_root_message_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS conversations_bot_root_idx
  ON conversations(bot_id, chat_id, root_message_id);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_active_group_bot_idx
  ON conversations(bot_id, chat_id)
  WHERE chat_type = 'group' AND active = true;

CREATE INDEX IF NOT EXISTS tasks_bot_created_idx ON tasks(bot_id, created_at DESC);
CREATE INDEX IF NOT EXISTS conversations_bot_chat_idx ON conversations(bot_id, chat_id, created_at DESC);
