const ELIGIBLE_JOB_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM scrape_jobs
     WHERE (status='queued' AND attempts < $1)
        OR (status='failed' AND attempts < $1 AND finished_at IS NOT NULL
            AND finished_at <= NOW() - ($2::double precision * INTERVAL '1 millisecond'))
        OR (status='running' AND attempts < $1
            AND COALESCE(heartbeat_at,started_at) <= NOW() - ($3::double precision * INTERVAL '1 millisecond'))
  ) AS has_jobs
`;

export async function hasEligibleCrawlJob(db, workerConfig) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('db.query requis');
  }
  const required = [
    workerConfig?.workerJobMaxAttempts,
    workerConfig?.workerJobRetryDelayMs,
    workerConfig?.workerJobLeaseMs,
  ];
  if (!required.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    throw new TypeError('Configuration de lease du worker invalide');
  }
  const result = await db.query(ELIGIBLE_JOB_SQL, required);
  return result.rows?.[0]?.has_jobs === true;
}
