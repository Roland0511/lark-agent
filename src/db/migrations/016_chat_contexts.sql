CREATE TABLE IF NOT EXISTS chat_contexts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_id text NOT NULL,
  chat_type text NOT NULL CHECK (chat_type IN ('p2p', 'group')),
  codex_thread_id text,
  executor_id text REFERENCES workers(executor_id),
  executor_home_ref text,
  executor_profile text,
  executor_config_fingerprint text,
  codex_version text,
  workspace_root_alias text,
  state text NOT NULL DEFAULT 'uninitialized'
    CHECK (state IN ('uninitialized', 'ready', 'blocked')),
  blocked_reason text,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  last_compacted_at timestamptz,
  auto_compaction_count integer NOT NULL DEFAULT 0 CHECK (auto_compaction_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, chat_id)
);

CREATE INDEX IF NOT EXISTS chat_contexts_bot_activity_idx
  ON chat_contexts(bot_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS chat_contexts_type_activity_idx
  ON chat_contexts(chat_type, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS chat_contexts_thread_idx
  ON chat_contexts(codex_thread_id)
  WHERE codex_thread_id IS NOT NULL;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS chat_context_id uuid;

-- Every historical bot/chat pair receives exactly one durable context.  The
-- latest conversation determines the stable chat type and activity timestamp.
INSERT INTO chat_contexts (bot_id, chat_id, chat_type, last_activity_at, updated_at)
SELECT DISTINCT ON (bot_id, chat_id)
  bot_id,
  chat_id,
  chat_type,
  updated_at,
  updated_at
FROM conversations
ORDER BY bot_id, chat_id, updated_at DESC, created_at DESC
ON CONFLICT (bot_id, chat_id) DO NOTHING;

-- Prefer a thread from an unfinished task; otherwise retain the most recently
-- updated historical thread.  All pinned runtime fields come from that same
-- task so a thread can never be resumed under a silently different profile.
WITH selected_thread AS (
  SELECT
    context.id AS chat_context_id,
    selected.codex_thread_id,
    selected.executor_id,
    selected.executor_home_ref,
    selected.executor_profile,
    selected.executor_config_fingerprint,
    selected.codex_version,
    COALESCE(selected.resolved_workspace_alias, selected.requested_workspace_alias) AS workspace_root_alias
  FROM chat_contexts context
  JOIN LATERAL (
    SELECT task.*
    FROM conversations conversation
    JOIN tasks task ON task.conversation_id = conversation.id
    WHERE conversation.bot_id = context.bot_id
      AND conversation.chat_id = context.chat_id
      AND task.codex_thread_id IS NOT NULL
    ORDER BY
      (task.state IN ('queued', 'waiting_worker', 'running', 'waiting_input', 'waiting_approval', 'held_draft', 'human_owned')) DESC,
      task.updated_at DESC,
      task.created_at DESC
    LIMIT 1
  ) selected ON true
)
UPDATE chat_contexts context
SET
  codex_thread_id = selected.codex_thread_id,
  executor_id = selected.executor_id,
  executor_home_ref = selected.executor_home_ref,
  executor_profile = selected.executor_profile,
  executor_config_fingerprint = selected.executor_config_fingerprint,
  codex_version = selected.codex_version,
  workspace_root_alias = selected.workspace_root_alias,
  state = CASE
    WHEN selected.executor_id IS NOT NULL
      AND selected.executor_home_ref IS NOT NULL
      AND selected.executor_profile IS NOT NULL
      AND selected.executor_config_fingerprint IS NOT NULL
      AND selected.workspace_root_alias IS NOT NULL
    THEN 'ready'
    ELSE 'blocked'
  END,
  blocked_reason = CASE
    WHEN selected.executor_id IS NOT NULL
      AND selected.executor_home_ref IS NOT NULL
      AND selected.executor_profile IS NOT NULL
      AND selected.executor_config_fingerprint IS NOT NULL
      AND selected.workspace_root_alias IS NOT NULL
    THEN NULL
    ELSE '历史 Thread 缺少完整的固定执行环境，无法安全恢复'
  END,
  updated_at = now()
FROM selected_thread selected
WHERE context.id = selected.chat_context_id;

UPDATE conversations conversation
SET chat_context_id = context.id
FROM chat_contexts context
WHERE context.bot_id = conversation.bot_id
  AND context.chat_id = conversation.chat_id
  AND conversation.chat_context_id IS NULL;

-- A bot/chat may historically have several unfinished conversations.  Once a
-- single durable context is selected, every unfinished task must use that
-- context's exact Thread and runtime identity; otherwise the new claim guard
-- would correctly reject the stale task forever.
UPDATE tasks task
SET
  requested_workspace_alias = context.workspace_root_alias,
  resolved_workspace_alias = context.workspace_root_alias,
  preferred_executor_id = context.executor_id,
  executor_id = context.executor_id,
  codex_thread_id = context.codex_thread_id,
  executor_home_ref = context.executor_home_ref,
  executor_profile = context.executor_profile,
  executor_config_fingerprint = context.executor_config_fingerprint,
  codex_version = context.codex_version,
  state = CASE WHEN context.state = 'blocked' THEN 'waiting_input' ELSE task.state END,
  summary = CASE WHEN context.state = 'blocked' THEN context.blocked_reason ELSE task.summary END,
  lease_token_hash = CASE WHEN context.state = 'blocked' THEN NULL ELSE task.lease_token_hash END,
  lease_expires_at = CASE WHEN context.state = 'blocked' THEN NULL ELSE task.lease_expires_at END,
  revision = task.revision + 1,
  updated_at = now()
FROM conversations conversation
JOIN chat_contexts context ON context.id = conversation.chat_context_id
WHERE task.conversation_id = conversation.id
  AND task.state IN ('queued', 'waiting_worker', 'running', 'waiting_input', 'waiting_approval', 'held_draft', 'human_owned')
  AND context.codex_thread_id IS NOT NULL;

-- Keep direct SQL/bootstrap callers safe during a rolling upgrade while the
-- application is being switched to explicitly supplying chat_context_id.
CREATE OR REPLACE FUNCTION ensure_conversation_chat_context()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chat_context_id IS NULL THEN
    INSERT INTO chat_contexts (bot_id, chat_id, chat_type, last_activity_at, updated_at)
    VALUES (NEW.bot_id, NEW.chat_id, NEW.chat_type, COALESCE(NEW.updated_at, now()), COALESCE(NEW.updated_at, now()))
    ON CONFLICT (bot_id, chat_id) DO UPDATE
      SET last_activity_at = GREATEST(chat_contexts.last_activity_at, EXCLUDED.last_activity_at),
          updated_at = GREATEST(chat_contexts.updated_at, EXCLUDED.updated_at)
    RETURNING id INTO NEW.chat_context_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS conversations_ensure_chat_context ON conversations;
CREATE TRIGGER conversations_ensure_chat_context
BEFORE INSERT ON conversations
FOR EACH ROW EXECUTE FUNCTION ensure_conversation_chat_context();

ALTER TABLE conversations ALTER COLUMN chat_context_id SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'conversations_chat_context_id_fkey'
      AND conrelid = 'conversations'::regclass
  ) THEN
    ALTER TABLE conversations
      ADD CONSTRAINT conversations_chat_context_id_fkey
      FOREIGN KEY (chat_context_id) REFERENCES chat_contexts(id);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS conversations_chat_context_idx
  ON conversations(chat_context_id, created_at DESC);

CREATE TABLE IF NOT EXISTS chat_context_compactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_context_id uuid NOT NULL REFERENCES chat_contexts(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id),
  codex_thread_id text NOT NULL,
  codex_turn_id text NOT NULL,
  codex_item_id text,
  notification_type text NOT NULL,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE chat_context_compactions
  DROP CONSTRAINT IF EXISTS chat_context_compactions_chat_context_id_codex_turn_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS chat_context_compactions_context_item_idx
  ON chat_context_compactions(chat_context_id, codex_item_id)
  WHERE codex_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS chat_context_compactions_context_legacy_turn_idx
  ON chat_context_compactions(chat_context_id, codex_turn_id)
  WHERE codex_item_id IS NULL;
CREATE INDEX IF NOT EXISTS chat_context_compactions_context_time_idx
  ON chat_context_compactions(chat_context_id, occurred_at DESC);
