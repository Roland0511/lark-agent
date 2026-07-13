CREATE TABLE IF NOT EXISTS admin_login_tokens (
  token_hash text PRIMARY KEY,
  open_id text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'operator')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_login_tokens_expiry_idx ON admin_login_tokens(expires_at);
CREATE INDEX IF NOT EXISTS admin_login_tokens_open_id_idx ON admin_login_tokens(open_id, created_at DESC);

DROP TABLE IF EXISTS admin_oauth_states;
