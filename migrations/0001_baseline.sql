CREATE TABLE users (
  id uuid PRIMARY KEY,
  timezone text NOT NULL DEFAULT 'Europe/London',
  status text NOT NULL CHECK (status IN ('active', 'paused', 'deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE knowledge_facts (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  key text NOT NULL,
  value_ciphertext bytea,
  status text NOT NULL CHECK (status IN ('verified', 'unverified', 'unknown', 'declined')),
  source text NOT NULL CHECK (source IN ('user', 'cv', 'document', 'derived')),
  source_ref text,
  sensitivity text NOT NULL CHECK (sensitivity IN ('normal', 'personal', 'high_risk')),
  use_policy text NOT NULL CHECK (use_policy IN ('auto_fill', 'ask_each_time', 'never_auto_fill')),
  allowed_purposes text[] NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  verified_at timestamptz,
  expires_at timestamptz,
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, key, version)
);

CREATE INDEX knowledge_facts_active_idx
  ON knowledge_facts (user_id, key)
  WHERE valid_to IS NULL;

CREATE TABLE knowledge_fact_versions (
  user_id uuid NOT NULL REFERENCES users(id),
  key text NOT NULL,
  last_version integer NOT NULL CHECK (last_version > 0),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  object_key text NOT NULL,
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  mime_type text NOT NULL,
  approved boolean NOT NULL DEFAULT false,
  malware_scan_status text NOT NULL CHECK (
    malware_scan_status IN ('pending', 'clean', 'rejected', 'error')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, type, version)
);

CREATE TABLE sources (
  id uuid PRIMARY KEY,
  adapter_type text NOT NULL,
  display_name text NOT NULL,
  config_ref text NOT NULL,
  cursor text,
  enabled boolean NOT NULL DEFAULT false,
  last_success_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE source_jobs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  external_id text NOT NULL,
  raw_object_key text,
  content_hash text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_id)
);

CREATE TABLE companies (
  id uuid PRIMARY KEY,
  canonical_name text NOT NULL,
  domains text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  canonical_url text NOT NULL,
  title text NOT NULL,
  description text NOT NULL,
  location_json jsonb NOT NULL,
  employment_type text,
  salary_min_minor bigint,
  salary_max_minor bigint,
  salary_currency char(3),
  salary_basis text,
  salary_confidence numeric(4,3) CHECK (salary_confidence BETWEEN 0 AND 1),
  posted_at timestamptz,
  closes_at timestamptz,
  content_hash text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('open', 'closed', 'unknown')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (canonical_url, version)
);

CREATE TABLE job_aliases (
  source_job_id uuid PRIMARY KEY REFERENCES source_jobs(id),
  job_id uuid NOT NULL REFERENCES jobs(id)
);

CREATE TABLE job_requirements (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs(id),
  category text NOT NULL,
  requirement_text text NOT NULL,
  mandatory boolean NOT NULL,
  normalised_value jsonb,
  evidence_excerpt text NOT NULL,
  evidence_location text,
  extraction_confidence numeric(4,3) NOT NULL CHECK (extraction_confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE site_policies (
  id uuid PRIMARY KEY,
  domain text NOT NULL,
  adapter_id text,
  discovery_mode text NOT NULL,
  apply_mode text NOT NULL,
  terms_status text NOT NULL,
  evidence_url text NOT NULL,
  reviewed_at timestamptz NOT NULL,
  review_expires_at timestamptz NOT NULL,
  auto_submit_allowed boolean NOT NULL DEFAULT false,
  rate_limit_json jsonb,
  notes text,
  version integer NOT NULL CHECK (version > 0),
  UNIQUE (domain, version)
);

CREATE TABLE match_runs (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  profile_snapshot_version integer NOT NULL,
  matcher_version text NOT NULL,
  policy_version text NOT NULL,
  hard_gate_result text NOT NULL,
  score integer NOT NULL CHECK (score BETWEEN 0 AND 100),
  evidence_coverage numeric(4,3) NOT NULL CHECK (evidence_coverage BETWEEN 0 AND 1),
  decision_confidence numeric(4,3) NOT NULL CHECK (decision_confidence BETWEEN 0 AND 1),
  action text NOT NULL,
  explanation_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id, profile_snapshot_version, matcher_version, policy_version)
);

CREATE TABLE requirement_matches (
  id uuid PRIMARY KEY,
  match_run_id uuid NOT NULL REFERENCES match_runs(id),
  requirement_id uuid NOT NULL REFERENCES job_requirements(id),
  outcome text NOT NULL CHECK (outcome IN ('met', 'not_met', 'unknown', 'not_applicable')),
  evidence_fact_ids uuid[] NOT NULL DEFAULT '{}',
  confidence numeric(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  explanation text NOT NULL,
  UNIQUE (match_run_id, requirement_id)
);

CREATE TABLE applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  match_run_id uuid REFERENCES match_runs(id),
  current_state text NOT NULL,
  state_version integer NOT NULL DEFAULT 1 CHECK (state_version > 0),
  policy_version text NOT NULL,
  submit_mode text NOT NULL CHECK (submit_mode IN ('approval_required', 'auto')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, job_id)
);

CREATE TABLE application_events (
  id uuid PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('user', 'system', 'worker')),
  correlation_id uuid NOT NULL,
  causation_id uuid,
  payload_json jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (application_id, sequence)
);

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  payload_json jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX outbox_events_pending_idx
  ON outbox_events (available_at)
  WHERE published_at IS NULL;

CREATE TABLE inbox_events (
  producer text NOT NULL,
  event_id text NOT NULL,
  payload_hash text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (producer, event_id)
);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  actor_type text NOT NULL,
  actor_id text,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  result text NOT NULL,
  policy_version text,
  correlation_id uuid NOT NULL,
  metadata_json jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now()
);
