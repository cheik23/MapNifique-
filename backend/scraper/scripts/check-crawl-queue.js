import { appendFile } from 'node:fs/promises';
import { initDb, pool } from '../src/db.js';
import { config } from '../src/config.js';
import { hasEligibleCrawlJob } from '../src/worker-queue.js';

const output = process.env.GITHUB_OUTPUT;

try {
  await initDb();
  const hasJobs = await hasEligibleCrawlJob(pool, config);
  console.log(`CRAWL_QUEUE_HAS_ELIGIBLE_JOB=${hasJobs}`);
  if (output) await appendFile(output, `has_jobs=${hasJobs}
`, 'utf8');
} catch (error) {
  console.error('[worker-queue] Préflight impossible :', error.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
