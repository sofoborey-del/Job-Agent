CREATE TABLE portal_accounts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  portal_key text NOT NULL,
  login_identifier_fact_key text NOT NULL,
  credential_mode text NOT NULL DEFAULT 'user_entered_each_session'
    CHECK (credential_mode = 'user_entered_each_session'),
  status text NOT NULL
    CHECK (status IN ('not_connected', 'login_required', 'connected', 'expired', 'disabled')),
  last_user_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, portal_key)
);

CREATE TABLE portal_sessions (
  id uuid PRIMARY KEY,
  portal_account_id uuid NOT NULL REFERENCES portal_accounts(id),
  encrypted_object_key text NOT NULL,
  browser_engine text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'expired', 'revoked', 'invalid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX portal_sessions_one_active_idx
  ON portal_sessions (portal_account_id)
  WHERE status = 'active';

CREATE TABLE portal_source_cursors (
  user_id uuid NOT NULL REFERENCES users(id),
  portal_key text NOT NULL,
  cursor text,
  last_discovered_at timestamptz,
  last_success_at timestamptz,
  last_error_code text,
  PRIMARY KEY (user_id, portal_key)
);
