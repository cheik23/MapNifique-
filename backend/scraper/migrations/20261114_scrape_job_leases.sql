-- Apply manually before deploying code that claims jobs using heartbeat_at.
-- Existing jobs are preserved. A running job's start time becomes its first
-- heartbeat so that jobs abandoned before this migration can be reclaimed.
BEGIN;

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS heartbeat_at TIMESTAMPTZ;

ALTER TABLE scrape_jobs
  ADD COLUMN IF NOT EXISTS lease_token TEXT;

UPDATE scrape_jobs
   SET heartbeat_at=started_at
 WHERE heartbeat_at IS NULL
   AND status='running'
   AND started_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS scrape_jobs_lease_idx
  ON scrape_jobs(status,heartbeat_at);

COMMIT;
