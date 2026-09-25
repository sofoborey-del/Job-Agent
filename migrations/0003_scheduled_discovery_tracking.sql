-- Phase 1B: scheduled read-only discovery, persisted job tracking, and notification delivery.
-- Discovery-only. Nothing in this migration enables browser automation or job submission.

-- Versioned configuration. Every match decision records the exact configuration it used.
CREATE TABLE configuration_versions (
  id uuid PRIMARY KEY,
  version integer NOT NULL CHECK (version > 0),
  config_hash text NOT NULL CHECK (length(config_hash) = 64),
  config_json jsonb NOT NULL,
  created_by text NOT NULL CHECK (created_by IN ('system', 'user')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (version),
  UNIQUE (config_hash)
);

-- Reviewed public sources. A source stays disabled until a reviewed site policy exists.
ALTER TABLE sources
  ADD COLUMN source_key text,
  ADD COLUMN site_policy_domain text,
  ADD COLUMN config_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN feed_url text,
  ADD COLUMN schedule_interval_seconds integer
    CHECK (schedule_interval_seconds IS NULL OR schedule_interval_seconds >= 900),
  ADD COLUMN next_run_at timestamptz,
  ADD COLUMN max_items_per_run integer NOT NULL DEFAULT 25
    CHECK (max_items_per_run BETWEEN 1 AND 200),
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  ADD COLUMN circuit_open_until timestamptz,
  ADD COLUMN paused_reason text,
  ADD COLUMN lease_owner text,
  ADD COLUMN lease_expires_at timestamptz,
  ADD COLUMN config_version_id uuid REFERENCES configuration_versions(id),
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by text;

CREATE UNIQUE INDEX sources_source_key_idx ON sources (source_key);
CREATE INDEX sources_due_idx ON sources (next_run_at) WHERE enabled;

-- One row per attempted discovery run. The idempotency key makes reruns of the same
-- scheduled slot harmless.
CREATE TABLE discovery_runs (
  id uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id),
  trigger text NOT NULL CHECK (trigger IN ('scheduled', 'manual', 'manual_url')),
  idempotency_key text NOT NULL,
  correlation_id uuid NOT NULL,
  config_version_id uuid REFERENCES configuration_versions(id),
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'skipped')),
  skip_reason text,
  error_code text,
  fetched_count integer NOT NULL DEFAULT 0 CHECK (fetched_count >= 0),
  new_count integer NOT NULL DEFAULT 0 CHECK (new_count >= 0),
  changed_count integer NOT NULL DEFAULT 0 CHECK (changed_count >= 0),
  unchanged_count integer NOT NULL DEFAULT 0 CHECK (unchanged_count >= 0),
  duplicate_count integer NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  closed_count integer NOT NULL DEFAULT 0 CHECK (closed_count >= 0),
  error_count integer NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (source_id, idempotency_key)
);

CREATE INDEX discovery_runs_source_started_idx ON discovery_runs (source_id, started_at DESC);

-- Immutable snapshot of every distinct version of a source record we have seen.
CREATE TABLE source_job_snapshots (
  id uuid PRIMARY KEY,
  source_job_id uuid NOT NULL REFERENCES source_jobs(id),
  discovery_run_id uuid NOT NULL REFERENCES discovery_runs(id),
  content_hash text NOT NULL CHECK (length(content_hash) = 64),
  normalised_json jsonb NOT NULL,
  captured_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_job_id, content_hash)
);

ALTER TABLE source_jobs
  ADD COLUMN source_key text,
  ADD COLUMN canonical_url text,
  ADD COLUMN processing_status text NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'normalised', 'matched', 'failed', 'skipped')),
  ADD COLUMN processing_error_code text,
  ADD COLUMN last_discovery_run_id uuid REFERENCES discovery_runs(id),
  ADD COLUMN closed_at timestamptz;

CREATE INDEX source_jobs_processing_idx ON source_jobs (processing_status);

-- Canonical jobs gain a deduplication fingerprint and version bookkeeping.
ALTER TABLE jobs
  ADD COLUMN fingerprint text,
  ADD COLUMN salary_source_text text,
  ADD COLUMN employment_types text[] NOT NULL DEFAULT '{}',
  ADD COLUMN contract_type text,
  ADD COLUMN hours text,
  ADD COLUMN work_pattern text,
  ADD COLUMN external_id text,
  ADD COLUMN source_key text,
  ADD COLUMN duplicate_of_job_id uuid REFERENCES jobs(id),
  ADD COLUMN first_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();

-- One canonical row per vacancy. The version increases in place when the advert changes, and
-- source_job_snapshots keeps every version so a past decision stays reproducible.
CREATE UNIQUE INDEX jobs_canonical_url_idx ON jobs (canonical_url);
-- Duplicate detection across differing URLs: same employer, title, location and closing date.
CREATE UNIQUE INDEX jobs_fingerprint_idx ON jobs (fingerprint) WHERE fingerprint IS NOT NULL;
CREATE INDEX jobs_closes_at_idx ON jobs (closes_at);

CREATE UNIQUE INDEX companies_canonical_name_idx ON companies (lower(canonical_name));
CREATE UNIQUE INDEX job_requirements_job_text_idx
  ON job_requirements (job_id, md5(requirement_text));

-- The user-facing tracker. One row per canonical job, with lifecycle and review state kept apart
-- so that an automatic lifecycle change never silently overwrites a human review decision.
CREATE TABLE job_tracking (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  lifecycle_status text NOT NULL
    CHECK (lifecycle_status IN ('open', 'changed', 'closed', 'expired', 'duplicate')),
  review_status text NOT NULL
    CHECK (review_status IN ('discovered', 'rejected', 'shortlisted', 'reviewed', 'archived')),
  decided_by text NOT NULL CHECK (decided_by IN ('system', 'user')),
  status_reason text,
  duplicate_of_job_id uuid REFERENCES jobs(id),
  last_match_run_id uuid REFERENCES match_runs(id),
  score integer CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  salary_gate text CHECK (salary_gate IS NULL OR salary_gate IN ('pass', 'reject', 'unknown')),
  needs_rematch boolean NOT NULL DEFAULT true,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  UNIQUE (user_id, job_id)
);

CREATE INDEX job_tracking_review_idx ON job_tracking (user_id, review_status, score DESC);
CREATE INDEX job_tracking_lifecycle_idx ON job_tracking (user_id, lifecycle_status);

-- Append-only tracker history so every state change is explainable after the fact.
CREATE TABLE job_tracking_events (
  id uuid PRIMARY KEY,
  job_tracking_id uuid NOT NULL REFERENCES job_tracking(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  event_type text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('user', 'system', 'worker')),
  from_lifecycle_status text,
  to_lifecycle_status text,
  from_review_status text,
  to_review_status text,
  reason text NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_tracking_id, sequence)
);

-- Match runs become reproducible: the exact job version, profile snapshot, matcher version and
-- configuration version form the idempotency key.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'match_runs'::regclass
     AND contype = 'u';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE match_runs DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

ALTER TABLE match_runs
  ADD COLUMN job_version integer NOT NULL DEFAULT 1 CHECK (job_version > 0),
  ADD COLUMN profile_snapshot_hash text,
  ADD COLUMN config_version_id uuid REFERENCES configuration_versions(id),
  ADD COLUMN discovery_run_id uuid REFERENCES discovery_runs(id),
  ADD COLUMN salary_gate text CHECK (salary_gate IS NULL OR salary_gate IN ('pass', 'reject', 'unknown')),
  ADD COLUMN correlation_id uuid,
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX match_runs_idempotency_idx ON match_runs (idempotency_key);
CREATE INDEX match_runs_job_idx ON match_runs (job_id, created_at DESC);

-- Outbox delivery gains deduplication, bounded retries and dead-letter visibility.
ALTER TABLE outbox_events
  ADD COLUMN channel text NOT NULL DEFAULT 'discord',
  ADD COLUMN dedupe_key text,
  ADD COLUMN max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
  ADD COLUMN last_error_code text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN correlation_id uuid;

CREATE UNIQUE INDEX outbox_events_dedupe_idx ON outbox_events (dedupe_key);
CREATE INDEX outbox_events_dead_letter_idx ON outbox_events (dead_lettered_at)
  WHERE dead_lettered_at IS NOT NULL;

-- Global kill switch and quiet hours. A single row.
CREATE TABLE agent_runtime_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused boolean NOT NULL DEFAULT false,
  paused_reason text,
  paused_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO agent_runtime_state (id, paused) VALUES (true, false);

-- A reviewed site-policy record for the one portal already in the codebase. Discovery is limited
-- to public pages and any feed the user explicitly configures; applying stays human-controlled.
INSERT INTO site_policies (
  id, domain, adapter_id, discovery_mode, apply_mode, terms_status, evidence_url,
  reviewed_at, review_expires_at, auto_submit_allowed, rate_limit_json, notes, version
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'myjobscotland.gov.uk',
  'myjobscotland',
  'manual_url',
  'prefill_only',
  'permission_required',
  'https://myjobscotland.gov.uk/disclaimer',
  now(),
  now() + interval '90 days',
  false,
  '{"requests": 10, "windowSeconds": 60}'::jsonb,
  'Public vacancy pages only. Login, reCAPTCHA, consent, declarations and final submission remain human-controlled. Scheduled feed polling requires an explicitly configured, documented public feed URL.',
  1
);
