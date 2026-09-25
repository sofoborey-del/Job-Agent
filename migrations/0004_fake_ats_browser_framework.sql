-- Phase 2: browser framework against a local fake ATS only.
-- Nothing in this migration enables a production application form or automatic submission.
-- The submit guard below permits at most one final action per attempt, on the fake ATS only.

ALTER TABLE applications
  ADD COLUMN adapter_id text,
  ADD COLUMN adapter_version text,
  ADD COLUMN target_kind text NOT NULL DEFAULT 'fake_ats'
    CHECK (target_kind IN ('fake_ats')),
  ADD COLUMN pause_reason text,
  ADD COLUMN takeover_requested_at timestamptz,
  ADD COLUMN correlation_id uuid,
  ADD COLUMN current_attempt_no integer NOT NULL DEFAULT 0 CHECK (current_attempt_no >= 0);

CREATE TABLE application_attempts (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  target_origin text NOT NULL,
  status text NOT NULL CHECK (
    status IN ('running', 'paused', 'awaiting_approval', 'submitting', 'submitted',
               'submission_unknown', 'failed', 'cancelled')
  ),
  pause_reason text,
  checkpoint_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  checkpoint_version integer NOT NULL DEFAULT 1 CHECK (checkpoint_version > 0),
  answer_manifest_hash text,
  session_ref text,
  lease_owner text,
  lease_expires_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (application_id, attempt_no)
);

CREATE INDEX application_attempts_status_idx ON application_attempts (status);

-- One row per observed form control. The answer is encrypted; the label, type and source are
-- ordinary metadata used by the review screen and the policy checks.
CREATE TABLE application_fields (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  step_id text NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  control_type text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  sensitive boolean NOT NULL DEFAULT false,
  mapped_intent text,
  mapping_confidence numeric(4,3) CHECK (mapping_confidence IS NULL OR mapping_confidence BETWEEN 0 AND 1),
  answer_source text NOT NULL CHECK (
    answer_source IN ('verified_fact', 'application_scoped_answer', 'approved_document',
                      'unresolved', 'human_only', 'not_applicable')
  ),
  answer_ciphertext bytea,
  answer_hash text,
  -- A short, non-reversible preview for the review screen. Never set for a sensitive field.
  answer_preview text,
  evidence_fact_ids uuid[] NOT NULL DEFAULT '{}',
  validation_status text NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending', 'accepted', 'rejected')),
  validation_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, step_id, field_key)
);

-- A question is raised whenever the agent may not answer for itself.
CREATE TABLE application_questions (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  step_id text NOT NULL,
  field_key text NOT NULL,
  reason text NOT NULL CHECK (
    reason IN ('unknown_field', 'missing_evidence', 'sensitive_question', 'expired_fact',
               'unverified_fact', 'use_policy_forbids', 'ambiguous_mapping', 'human_only_step',
               'validation_rejected')
  ),
  prompt text NOT NULL,
  response_kind text NOT NULL CHECK (
    response_kind IN ('text', 'choice', 'boolean', 'number', 'human_action')
  ),
  allowed_values text[] NOT NULL DEFAULT '{}',
  state text NOT NULL CHECK (state IN ('open', 'answered', 'declined', 'expired', 'superseded')),
  answer_ciphertext bytea,
  answer_scope text CHECK (answer_scope IS NULL OR answer_scope IN ('application_only', 'save_to_profile')),
  response_version integer NOT NULL DEFAULT 0 CHECK (response_version >= 0),
  correlation_id uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE INDEX application_questions_open_idx ON application_questions (application_id)
  WHERE state = 'open';
CREATE UNIQUE INDEX application_questions_answer_idem_idx
  ON application_questions (id, response_version);

-- Approval binds to the exact review manifest. One unconsumed approval per snapshot hash.
CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  approver text NOT NULL CHECK (approver IN ('user')),
  snapshot_hash text NOT NULL CHECK (length(snapshot_hash) = 64),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX approvals_one_live_per_snapshot_idx
  ON approvals (application_id, snapshot_hash)
  WHERE decision = 'approved' AND consumed_at IS NULL;

-- A submit intent is one-use, short-lived, and bound to both the attempt and the snapshot.
CREATE TABLE submit_intents (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  approval_id uuid NOT NULL REFERENCES approvals(id),
  token_hash text NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  snapshot_hash text NOT NULL CHECK (length(snapshot_hash) = 64),
  target_origin text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  result text CHECK (result IS NULL OR result IN ('submitted', 'unknown', 'failed')),
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX submit_intents_one_live_per_attempt_idx
  ON submit_intents (attempt_id)
  WHERE consumed_at IS NULL;

-- The ledger is the durable record that a final action was reserved, so a restart before or after
-- the click can never produce a second submission.
CREATE TABLE submission_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  application_id uuid NOT NULL REFERENCES applications(id),
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  local_date date NOT NULL,
  mode text NOT NULL CHECK (mode IN ('fake_ats_approved')),
  status text NOT NULL CHECK (status IN ('reserved', 'confirmed', 'unknown', 'released')),
  idempotency_key text NOT NULL UNIQUE,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (application_id)
);

CREATE TABLE receipts (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  provider_reference text NOT NULL,
  confirmation_url_hash text,
  artifact_ref text,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, provider_reference)
);

-- Artefacts stay inside the worker boundary; only their metadata is recorded here.
CREATE TABLE browser_artifacts (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES application_attempts(id),
  kind text NOT NULL CHECK (kind IN ('screenshot', 'trace', 'validation_log', 'page_fingerprint')),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  redacted boolean NOT NULL DEFAULT true,
  bytes integer NOT NULL CHECK (bytes >= 0),
  retain_until timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX browser_artifacts_attempt_idx ON browser_artifacts (attempt_id);

-- The fake ATS is the only adapter permitted to receive a final action in this phase.
INSERT INTO site_policies (
  id, domain, adapter_id, discovery_mode, apply_mode, terms_status, evidence_url,
  reviewed_at, review_expires_at, auto_submit_allowed, rate_limit_json, notes, version
) VALUES (
  '00000000-0000-4000-8000-000000000002',
  'fake-ats.localhost',
  'fake-ats',
  'disabled',
  'manual_only',
  'reviewed_allowed',
  'https://localhost/fake-ats-is-local-test-software',
  now(),
  now() + interval '3650 days',
  false,
  '{"requests": 120, "windowSeconds": 60}'::jsonb,
  'Local test software bundled with this repository. It is not a real employer or ATS. It exists so the browser framework can be exercised without touching any production application form.',
  1
);
