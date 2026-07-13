ALTER TABLE conversations ADD COLUMN IF NOT EXISTS followup_expires_at timestamptz;

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS turn_index integer NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS trigger_message_id text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS conversation_disposition text;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS disposition_reason text;

UPDATE tasks t
SET trigger_message_id = c.root_message_id
FROM conversations c
WHERE c.id = t.conversation_id
  AND t.trigger_message_id IS NULL;

ALTER TABLE tasks ALTER COLUMN trigger_message_id SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tasks_conversation_disposition_check'
  ) THEN
    ALTER TABLE tasks ADD CONSTRAINT tasks_conversation_disposition_check
      CHECK (conversation_disposition IS NULL OR conversation_disposition IN ('complete', 'awaiting_followup'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS tasks_conversation_turn_idx
  ON tasks(conversation_id, turn_index);
CREATE INDEX IF NOT EXISTS conversations_followup_expiry_idx
  ON conversations(followup_expires_at)
  WHERE active = true AND followup_expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_trigger_message_idx
  ON tasks(trigger_message_id);
