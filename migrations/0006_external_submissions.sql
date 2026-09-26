-- User-reported real submissions are not fake-ATS attempts or verified provider receipts.
CREATE TABLE external_submissions (
  user_id uuid NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  provider_reference text NOT NULL,
  submitted_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  evidence_source text NOT NULL DEFAULT 'user_report' CHECK (evidence_source = 'user_report'),
  PRIMARY KEY (user_id, job_id)
);
