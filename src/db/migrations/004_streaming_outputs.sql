DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'status_card_message_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'conversations' AND column_name = 'response_message_id') THEN
    ALTER TABLE conversations RENAME COLUMN status_card_message_id TO response_message_id;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS task_outputs (
  task_id uuid PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  transport text NOT NULL DEFAULT 'cardkit' CHECK (transport IN ('cardkit', 'markdown_fallback')),
  card_id text,
  message_id text,
  element_id text NOT NULL DEFAULT 'answer',
  sequence integer NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'streaming', 'held', 'completed', 'failed', 'unknown')),
  visible_phase text CHECK (visible_phase IS NULL OR visible_phase IN ('commentary', 'final', 'error')),
  current_content text,
  current_content_hash text,
  last_ordinal integer NOT NULL DEFAULT 0,
  last_error text,
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_output_updates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  operation text NOT NULL CHECK (operation IN ('create_card', 'send_card', 'update_content', 'close_stream')),
  sequence integer,
  request_uuid text NOT NULL UNIQUE,
  content text,
  content_hash text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'unknown', 'failed')),
  attempt integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE(task_id, sequence)
);

ALTER TABLE outbox_messages ADD COLUMN IF NOT EXISTS operation_kind text NOT NULL DEFAULT 'message_send';

CREATE INDEX IF NOT EXISTS task_outputs_state_idx ON task_outputs(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS task_output_updates_state_idx ON task_output_updates(state, created_at DESC);
