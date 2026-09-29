-- Applying by email, for vacancies whose advert explicitly instructs it.
--
-- This is deliberately a separate domain from `applications`, which is the browser path. That table
-- is constrained to target_kind 'fake_ats' and carries the browser submit guard; widening it would
-- put a real outbound action behind machinery that was reviewed for a local test target. Nothing
-- here can drive a browser, open an employer portal, or reach any site.
--
-- The one outbound action this adds is sending one message, to an address the advert itself
-- publishes, through the applicant's own authorised email provider, after an explicit single-use
-- approval bound to a review manifest hash. There is no automatic send and no retry: a send that
-- did not clearly succeed is recorded as uncertain and waits for the person.

CREATE TABLE email_applications (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  state text NOT NULL CHECK (state IN (
    'awaiting_approval', 'approved', 'sending', 'sent', 'send_uncertain', 'failed', 'rejected'
  )),
  -- The employer's published address. Not applicant data, and needed for dedupe and audit.
  recipient text NOT NULL,
  recipient_domain text NOT NULL,
  -- Carries the vacancy only. The applicant's name is deliberately not in the subject, so this
  -- column holds nothing personal.
  subject text NOT NULL,
  -- The message body is applicant data and is stored encrypted, exactly like a CV or a form answer.
  body_ciphertext bytea NOT NULL,
  body_sha256 text NOT NULL CHECK (length(body_sha256) = 64),
  body_characters integer NOT NULL CHECK (body_characters > 0),
  attachment_document_id uuid,
  attachment_filename text,
  attachment_sha256 text CHECK (attachment_sha256 IS NULL OR length(attachment_sha256) = 64),
  -- The review manifest, and its hash. The manifest records the body by hash, never in clear text.
  manifest_hash text NOT NULL CHECK (length(manifest_hash) = 64),
  manifest_json jsonb NOT NULL,
  -- The verified email-application instruction: the exact sentence, the recipient it named, where
  -- it was read from, and what corroborated it. Untrusted advert content, recorded as evidence.
  instruction_json jsonb NOT NULL,
  -- Bound to the advert that was read. A later version of the advert invalidates the review.
  job_version integer NOT NULL CHECK (job_version > 0),
  job_content_hash text NOT NULL,
  closes_at timestamptz,
  salary_gate text NOT NULL CHECK (salary_gate IN ('pass', 'reject', 'unknown')),
  -- True only when the person explicitly overrode the configured salary floor for this vacancy.
  salary_override boolean NOT NULL DEFAULT false,
  failure_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- One email application per vacancy, per person. This is the primary deduplication control.
  UNIQUE (user_id, job_id)
);

CREATE INDEX email_applications_state_idx ON email_applications (user_id, state);

-- Approval is single-use and binds to the exact manifest hash that was shown.
CREATE TABLE email_application_approvals (
  id uuid PRIMARY KEY,
  email_application_id uuid NOT NULL REFERENCES email_applications(id),
  manifest_hash text NOT NULL CHECK (length(manifest_hash) = 64),
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  -- Who approved, as an opaque channel reference. No Discord user id is stored here.
  approver_channel text NOT NULL CHECK (approver_channel IN ('discord', 'local')),
  reason text,
  -- The chat interaction that carried the decision, so a replayed command is harmless.
  request_id text,
  correlation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX email_approvals_one_live_per_manifest_idx
  ON email_application_approvals (email_application_id, manifest_hash)
  WHERE decision = 'approved' AND consumed_at IS NULL;

CREATE UNIQUE INDEX email_approvals_request_idx
  ON email_application_approvals (request_id)
  WHERE request_id IS NOT NULL;

-- The durable record that a send was reserved, so a crash between reserving and sending can never
-- produce a second message. It also carries the Europe/London calendar date the daily cap counts.
CREATE TABLE email_send_ledger (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  email_application_id uuid NOT NULL REFERENCES email_applications(id),
  approval_id uuid NOT NULL REFERENCES email_application_approvals(id),
  local_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('reserved', 'sent', 'uncertain', 'released')),
  idempotency_key text NOT NULL UNIQUE,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (email_application_id)
);

CREATE INDEX email_send_ledger_day_idx ON email_send_ledger (user_id, local_date);

-- The provider's own acknowledgement. 'user_report' exists for the reconciliation path, where the
-- person checked their sent mail themselves after an uncertain send.
CREATE TABLE email_receipts (
  id uuid PRIMARY KEY,
  email_application_id uuid NOT NULL REFERENCES email_applications(id) UNIQUE,
  provider text NOT NULL,
  provider_message_id text NOT NULL,
  provider_thread_id text,
  evidence_source text NOT NULL CHECK (evidence_source IN ('provider_receipt', 'user_report')),
  accepted_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
