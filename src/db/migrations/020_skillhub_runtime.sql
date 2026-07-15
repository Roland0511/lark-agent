CREATE TABLE IF NOT EXISTS skillhub_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_url text NOT NULL,
  namespace text NOT NULL,
  slug text NOT NULL,
  version text NOT NULL,
  registry_fingerprint text NOT NULL,
  archive_sha256 text NOT NULL CHECK (archive_sha256 ~ '^[a-f0-9]{64}$'),
  archive_path text NOT NULL,
  archive_size bigint NOT NULL CHECK (archive_size > 0 AND archive_size <= 104857600),
  skill_name text NOT NULL,
  description text NOT NULL,
  dependencies jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (registry_url, namespace, slug, version, registry_fingerprint)
);

CREATE INDEX IF NOT EXISTS skillhub_packages_coordinate_idx
  ON skillhub_packages(namespace, slug, created_at DESC);

CREATE TABLE IF NOT EXISTS bot_skill_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  chat_context_id uuid REFERENCES chat_contexts(id) ON DELETE CASCADE,
  package_id uuid NOT NULL REFERENCES skillhub_packages(id),
  namespace text NOT NULL,
  slug text NOT NULL,
  created_by text NOT NULL,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS bot_skill_bindings_active_scope_coordinate_idx
  ON bot_skill_bindings(bot_id, COALESCE(chat_context_id, '00000000-0000-0000-0000-000000000000'::uuid), namespace, slug)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS bot_skill_bindings_bot_scope_idx
  ON bot_skill_bindings(bot_id, chat_context_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS skill_runtime_environment_revisions (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bot_skill_bindings(id) ON DELETE CASCADE,
  chat_context_id uuid REFERENCES chat_contexts(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (name ~ '^[A-Za-z_][A-Za-z0-9_]*$'),
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'absent')),
  key_id text,
  nonce text,
  ciphertext text,
  auth_tag text,
  value_size bigint NOT NULL CHECK (value_size >= 0 AND value_size <= 16384),
  revision integer NOT NULL CHECK (revision > 0),
  superseded_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (desired_state = 'present' AND key_id IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL AND value_size > 0)
    OR
    (desired_state = 'absent' AND key_id IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL AND value_size = 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_runtime_environment_active_idx
  ON skill_runtime_environment_revisions(binding_id, COALESCE(chat_context_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS skill_runtime_environment_revision_idx
  ON skill_runtime_environment_revisions(binding_id, COALESCE(chat_context_id, '00000000-0000-0000-0000-000000000000'::uuid), name, revision);

CREATE TABLE IF NOT EXISTS skill_runtime_file_revisions (
  id uuid PRIMARY KEY,
  binding_id uuid NOT NULL REFERENCES bot_skill_bindings(id) ON DELETE CASCADE,
  chat_context_id uuid REFERENCES chat_contexts(id) ON DELETE CASCADE,
  target_path text NOT NULL,
  target_path_key text NOT NULL,
  desired_state text NOT NULL CHECK (desired_state IN ('present', 'absent')),
  key_id text,
  nonce text,
  ciphertext text,
  auth_tag text,
  content_sha256 text,
  content_size bigint NOT NULL CHECK (content_size >= 0 AND content_size <= 1048576),
  revision integer NOT NULL CHECK (revision > 0),
  superseded_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (desired_state = 'present' AND key_id IS NOT NULL AND nonce IS NOT NULL AND ciphertext IS NOT NULL AND auth_tag IS NOT NULL AND content_sha256 IS NOT NULL)
    OR
    (desired_state = 'absent' AND key_id IS NULL AND nonce IS NULL AND ciphertext IS NULL AND auth_tag IS NULL AND content_sha256 IS NULL AND content_size = 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_runtime_files_active_idx
  ON skill_runtime_file_revisions(binding_id, COALESCE(chat_context_id, '00000000-0000-0000-0000-000000000000'::uuid), target_path_key)
  WHERE superseded_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS skill_runtime_files_revision_idx
  ON skill_runtime_file_revisions(binding_id, COALESCE(chat_context_id, '00000000-0000-0000-0000-000000000000'::uuid), target_path_key, revision);

CREATE TABLE IF NOT EXISTS skill_runtime_file_states (
  chat_context_id uuid NOT NULL REFERENCES chat_contexts(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL REFERENCES bot_skill_bindings(id) ON DELETE CASCADE,
  target_path text NOT NULL,
  desired_file_revision_id uuid NOT NULL REFERENCES skill_runtime_file_revisions(id) ON DELETE CASCADE,
  desired_revision integer NOT NULL,
  applied_revision integer,
  actual_sha256 text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'pending_force', 'applied', 'pending_delete', 'deleted', 'drift', 'conflict', 'error')),
  last_error text,
  checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_context_id, binding_id, target_path)
);

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS skill_set_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS skill_set_fingerprint text,
  ADD COLUMN IF NOT EXISTS runtime_config_snapshot jsonb NOT NULL DEFAULT '{"environment":[],"files":[]}'::jsonb,
  ADD COLUMN IF NOT EXISTS runtime_config_fingerprint text,
  ADD COLUMN IF NOT EXISTS user_skills_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS executor_workspace_mapping_fingerprint text
    CHECK (executor_workspace_mapping_fingerprint IS NULL OR executor_workspace_mapping_fingerprint ~ '^[a-f0-9]{64}$');

ALTER TABLE chat_contexts
  ADD COLUMN IF NOT EXISTS desired_skill_set_fingerprint text,
  ADD COLUMN IF NOT EXISTS applied_skill_set_fingerprint text,
  ADD COLUMN IF NOT EXISTS skills_synced_at timestamptz,
  ADD COLUMN IF NOT EXISTS skills_sync_error text,
  ADD COLUMN IF NOT EXISTS executor_workspace_mapping_fingerprint text
    CHECK (executor_workspace_mapping_fingerprint IS NULL OR executor_workspace_mapping_fingerprint ~ '^[a-f0-9]{64}$');

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS user_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS user_skills_fingerprint text,
  ADD COLUMN IF NOT EXISTS user_skills_scan_status text NOT NULL DEFAULT 'unknown'
    CHECK (user_skills_scan_status IN ('unknown', 'ready', 'stale', 'error')),
  ADD COLUMN IF NOT EXISTS user_skills_truncated boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS user_skills_scanned_at timestamptz,
  ADD COLUMN IF NOT EXISTS user_skills_scan_error text,
  ADD COLUMN IF NOT EXISTS workspace_mapping_fingerprint text
    CHECK (workspace_mapping_fingerprint IS NULL OR workspace_mapping_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD COLUMN IF NOT EXISTS upgrade_drain_token_hash text,
  ADD COLUMN IF NOT EXISTS upgrade_drain_previous_mode text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workers_upgrade_drain_valid' AND conrelid = 'workers'::regclass
  ) THEN
    ALTER TABLE workers ADD CONSTRAINT workers_upgrade_drain_valid CHECK (
      (upgrade_drain_token_hash IS NULL AND upgrade_drain_previous_mode IS NULL)
      OR (
        upgrade_drain_token_hash IS NOT NULL
        AND upgrade_drain_previous_mode IS NOT NULL
        AND upgrade_drain_token_hash ~ '^[a-f0-9]{64}$'
        AND upgrade_drain_previous_mode IN ('enabled', 'maintenance', 'disabled')
      )
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS skill_admin_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_open_id text NOT NULL,
  action text NOT NULL,
  bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  binding_id uuid REFERENCES bot_skill_bindings(id) ON DELETE SET NULL,
  chat_context_id uuid REFERENCES chat_contexts(id) ON DELETE SET NULL,
  target_name text,
  revision integer,
  result text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS skill_admin_audit_events_time_idx
  ON skill_admin_audit_events(created_at DESC);

CREATE TABLE IF NOT EXISTS skill_file_sync_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_context_id uuid NOT NULL REFERENCES chat_contexts(id) ON DELETE CASCADE,
  executor_id text NOT NULL REFERENCES workers(executor_id),
  desired_fingerprint text NOT NULL,
  leased_fingerprint text,
  payload jsonb NOT NULL,
  leased_payload jsonb,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'completed', 'failed')),
  lease_token_hash text,
  lease_expires_at timestamptz,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS skill_file_sync_jobs_active_context_idx
  ON skill_file_sync_jobs(chat_context_id)
  WHERE state IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS skill_file_sync_jobs_executor_queue_idx
  ON skill_file_sync_jobs(executor_id, created_at)
  WHERE state = 'queued';
