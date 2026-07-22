ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS bot_config_revision_snapshot integer,
  ADD COLUMN IF NOT EXISTS role_instructions_snapshot text,
  ADD COLUMN IF NOT EXISTS attention_model_snapshot text,
  ADD COLUMN IF NOT EXISTS attention_reasoning_effort_snapshot text,
  ADD COLUMN IF NOT EXISTS execution_model_snapshot text,
  ADD COLUMN IF NOT EXISTS execution_reasoning_effort_snapshot text;

UPDATE tasks AS task
SET bot_config_revision_snapshot = conversation.bot_config_revision,
    role_instructions_snapshot = conversation.role_instructions_snapshot,
    attention_model_snapshot = conversation.attention_model_snapshot,
    attention_reasoning_effort_snapshot = conversation.attention_reasoning_effort_snapshot,
    execution_model_snapshot = conversation.execution_model_snapshot,
    execution_reasoning_effort_snapshot = conversation.execution_reasoning_effort_snapshot
FROM conversations AS conversation
WHERE conversation.id = task.conversation_id
  AND task.bot_config_revision_snapshot IS NULL;
