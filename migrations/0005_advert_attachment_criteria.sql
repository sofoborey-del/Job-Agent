-- Reading the criteria document a public advert links to.
--
-- Many MyJobScotland adverts carry only a summary on the page and put the person specification in a
-- downloadable document. Scoring the summary made an advert look as though it had no essential
-- requirements, when in fact none had been seen. This migration adds the reviewed permission that
-- lets the agent read such a document, and records the permission explicitly so that a policy
-- without it reads nothing.
--
-- This permits an additional read of a public document on an already-reviewed domain. It grants no
-- authentication, no form interaction, no submission and no write of any kind.

ALTER TABLE site_policies
  ADD COLUMN IF NOT EXISTS attachment_read_json jsonb;

COMMENT ON COLUMN site_policies.attachment_read_json IS
  'Reviewed permission to read documents linked from a public advert. NULL means no attachment is ever fetched for this domain.';

-- A new reviewed version of the MyJobScotland policy rather than an edit of the old one, so the
-- earlier review stays in the record.
INSERT INTO site_policies (
  id, domain, adapter_id, discovery_mode, apply_mode, terms_status, evidence_url,
  reviewed_at, review_expires_at, auto_submit_allowed, rate_limit_json, attachment_read_json,
  notes, version
) VALUES (
  '00000000-0000-4000-8000-000000000003',
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
  '{"allowed": true, "contentTypes": ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"], "maxBytes": 10485760, "maxPerAdvert": 3}'::jsonb,
  'Public vacancy pages only, plus the criteria documents those pages link to. Attachment reads are limited to documents the advert page itself publishes on this domain; the agent never constructs a document address. Login, reCAPTCHA, consent, declarations and final submission remain human-controlled. Scheduled feed polling requires an explicitly configured, documented public feed URL.',
  2
);

-- The criteria read for a job, stored with the job so a match stays reproducible from recorded
-- inputs. 'absent' means the advert linked nothing; 'unreadable' means it linked something the agent
-- could not safely read, which must never be scored as "no requirements".
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS person_spec_status text NOT NULL DEFAULT 'absent'
    CHECK (person_spec_status IN ('absent', 'read', 'unreadable')),
  ADD COLUMN IF NOT EXISTS person_spec_text text,
  ADD COLUMN IF NOT EXISTS person_spec_reason text,
  ADD COLUMN IF NOT EXISTS person_spec_sources_json jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN jobs.person_spec_text IS
  'Text extracted from the criteria document an advert links. Untrusted advert content: data for deterministic extraction, never instructions.';
