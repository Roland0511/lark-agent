ALTER TABLE signals
  ADD COLUMN IF NOT EXISTS sender_type text NOT NULL DEFAULT 'user',
  ADD COLUMN IF NOT EXISTS sender_bot_id uuid REFERENCES bots(id),
  ADD COLUMN IF NOT EXISTS sender_display_name text,
  ADD COLUMN IF NOT EXISTS ingress_source text NOT NULL DEFAULT 'lark',
  ADD COLUMN IF NOT EXISTS origin_message_id text,
  ADD COLUMN IF NOT EXISTS bot_dialogue_depth integer NOT NULL DEFAULT 0;

UPDATE signals
SET origin_message_id = message_id
WHERE origin_message_id IS NULL;

ALTER TABLE signals
  ALTER COLUMN origin_message_id SET NOT NULL,
  ADD CONSTRAINT signals_sender_type_check CHECK (sender_type IN ('user', 'bot')),
  ADD CONSTRAINT signals_ingress_source_check CHECK (ingress_source IN ('lark', 'internal', 'history')),
  ADD CONSTRAINT signals_bot_dialogue_depth_check CHECK (bot_dialogue_depth >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS signals_bot_message_idx
  ON signals(bot_id, message_id);

CREATE TABLE IF NOT EXISTS bot_dialogue_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  max_consecutive_depth integer NOT NULL DEFAULT 30 CHECK (max_consecutive_depth BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO bot_dialogue_settings(id, max_consecutive_depth)
VALUES (1, 30)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS bot_dialogue_guards (
  chat_id text NOT NULL,
  origin_message_id text NOT NULL,
  source_task_id uuid NOT NULL REFERENCES tasks(id),
  reached_depth integer NOT NULL,
  notification_outbox_id uuid REFERENCES outbox_messages(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chat_id, origin_message_id)
);

CREATE INDEX IF NOT EXISTS signals_sender_bot_created_idx
  ON signals(sender_bot_id, created_at DESC)
  WHERE sender_bot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS signals_origin_depth_idx
  ON signals(origin_message_id, bot_dialogue_depth DESC);
