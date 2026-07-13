ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS resolved_workspace_alias text;

UPDATE tasks
SET resolved_workspace_alias = requested_workspace_alias
WHERE resolved_workspace_alias IS NULL
  AND requested_workspace_alias IS NOT NULL;

UPDATE tasks AS task
SET resolved_workspace_alias = worker.workspace_aliases ->> 0
FROM workers AS worker
WHERE task.executor_id = worker.executor_id
  AND task.resolved_workspace_alias IS NULL
  AND jsonb_typeof(worker.workspace_aliases) = 'array'
  AND jsonb_array_length(worker.workspace_aliases) = 1;

CREATE INDEX IF NOT EXISTS tasks_resolved_workspace_idx
  ON tasks (resolved_workspace_alias, created_at DESC);
