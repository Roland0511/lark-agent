ALTER TABLE chat_contexts
  ADD COLUMN IF NOT EXISTS peer_open_id text,
  ADD COLUMN IF NOT EXISTS peer_display_name text,
  ADD COLUMN IF NOT EXISTS peer_identity_checked_at timestamptz;

UPDATE chat_contexts AS context
SET peer_open_id = source.sender_id
FROM (
  SELECT DISTINCT ON (conversation.chat_context_id)
    conversation.chat_context_id,
    signal.sender_id
  FROM conversations AS conversation
  JOIN signals AS signal ON signal.conversation_id = conversation.id
  WHERE conversation.chat_type = 'p2p'
    AND signal.sender_type = 'user'
    AND signal.sender_id <> ''
  ORDER BY conversation.chat_context_id, signal.created_at DESC
) AS source
WHERE context.id = source.chat_context_id
  AND context.chat_type = 'p2p'
  AND context.peer_open_id IS NULL;

CREATE INDEX IF NOT EXISTS chat_contexts_peer_open_id_idx
  ON chat_contexts(bot_id, peer_open_id)
  WHERE chat_type = 'p2p' AND peer_open_id IS NOT NULL;

-- Permission requirements changed in this release. Force every active bot to
-- pass the new policy before its message consumer may start again.
UPDATE bots
SET permission_state = 'unchecked',
    permission_check = NULL,
    permission_checked_at = NULL,
    updated_at = now()
WHERE deleted_at IS NULL;
