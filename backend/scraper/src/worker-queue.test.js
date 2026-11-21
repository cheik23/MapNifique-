import test from 'node:test';
import assert from 'node:assert/strict';
import { hasEligibleCrawlJob } from './worker-queue.js';

const workerConfig = {
  workerJobMaxAttempts: 3,
  workerJobRetryDelayMs: 300000,
  workerJobLeaseMs: 900000,
};

test('worker queue preflight reports eligible queued/retry/stale jobs', async () => {
  let call;
  const db = {
    async query(sql, params) {
      call = { sql, params };
      return { rows: [{ has_jobs: true }] };
    },
  };
  assert.equal(await hasEligibleCrawlJob(db, workerConfig), true);
  assert.match(call.sql, /status='queued'/);
  assert.match(call.sql, /status='failed'/);
  assert.match(call.sql, /status='running'/);
  assert.deepEqual(call.params, [3, 300000, 900000]);
});

test('worker queue preflight skips browser installation when the queue is empty', async () => {
  const db = { async query() { return { rows: [{ has_jobs: false }] }; } };
  assert.equal(await hasEligibleCrawlJob(db, workerConfig), false);
});

test('worker queue preflight rejects invalid database/config inputs', async () => {
  await assert.rejects(() => hasEligibleCrawlJob(null, workerConfig), TypeError);
  await assert.rejects(() => hasEligibleCrawlJob({ query() {} }, {}), TypeError);
});
