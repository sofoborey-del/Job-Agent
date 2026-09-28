-- A reviewed site policy for the documented Adzuna job search API.
--
-- Evidence: https://developer.adzuna.com/docs/terms_of_service lists the permitted uses of the API
-- as publishing Adzuna ad listings, publishing Jobsworth salary estimates, and personal research.
-- This agent is a single person's private job search running on their own machine: it publishes
-- nothing, it is not operated by a commercial, government or academic organisation, and it stores
-- only what that person's own tracker needs. The same page publishes the default rate allowance
-- (25/minute, 250/day, 1000/week, 2500/month); the shipped six-hourly schedule of at most 25
-- results stays far inside it.
--
-- Scope. This grants a read of one documented JSON endpoint. It grants no authentication to any
-- employer system, no form interaction, no submission, and no write of any kind. It does not
-- permit reading the third-party advert pages that Adzuna's redirect_url points at: those are
-- unreviewed domains and remain out of scope.
--
-- apply_mode is manual_only: Adzuna is a discovery source, never an application route.
--
-- The source itself ships disabled and additionally cannot run without a personal application key
-- in the local .env, so this migration switches nothing on by itself.

INSERT INTO site_policies (
  id, domain, adapter_id, discovery_mode, apply_mode, terms_status, evidence_url,
  reviewed_at, review_expires_at, auto_submit_allowed, rate_limit_json, attachment_read_json,
  notes, version
) VALUES (
  '00000000-0000-4000-8000-000000000004',
  'api.adzuna.com',
  'adzuna',
  'official_api',
  'manual_only',
  'reviewed_allowed',
  'https://developer.adzuna.com/docs/terms_of_service',
  now(),
  now() + interval '90 days',
  false,
  '{"requests": 20, "windowSeconds": 60}'::jsonb,
  NULL,
  'Documented public search API, read-only, personal single-user use. Responses carry only an excerpt of each advert, so no person specification can be established from this source and every result is marked as truncated. Attachment reading is deliberately NULL: this source links to unreviewed third-party domains and none of them may be fetched. Requires ADZUNA_APP_ID and ADZUNA_APP_KEY in the local .env; without them the source refuses to run.',
  1
);
