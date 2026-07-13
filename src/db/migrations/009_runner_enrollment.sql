ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS runner_version text,
  ADD COLUMN IF NOT EXISTS architecture text,
  ADD COLUMN IF NOT EXISTS registration_source text NOT NULL DEFAULT 'unregistered';

ALTER TABLE workers DROP CONSTRAINT IF EXISTS workers_registration_source_check;
ALTER TABLE workers ADD CONSTRAINT workers_registration_source_check
  CHECK (registration_source IN ('unregistered', 'quick_install'));

-- 历史执行器没有动态设备凭据，迁移后只保留任务关联记录，不再允许领取任务。
UPDATE workers
SET operational_mode = 'disabled', status = 'offline', updated_at = now()
WHERE registration_source = 'unregistered';

CREATE TABLE IF NOT EXISTS worker_enrollment_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  executor_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_enrollment_tokens_expiry_idx
  ON worker_enrollment_tokens (expires_at DESC);

CREATE TABLE IF NOT EXISTS worker_device_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  executor_id text NOT NULL REFERENCES workers(executor_id) ON DELETE CASCADE,
  credential_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS worker_device_credentials_executor_idx
  ON worker_device_credentials (executor_id, revoked_at);
