-- Distinguish an aggregator excerpt from an employer's complete advert after persistence.
ALTER TABLE jobs ADD COLUMN description_completeness text NOT NULL DEFAULT 'full'
  CHECK (description_completeness IN ('full', 'snippet'));
