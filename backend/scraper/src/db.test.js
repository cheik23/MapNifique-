import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://test:test@localhost/mapnifique_test';
const { claimNextJob, refreshJobHeartbeat } = await import('./db.js');

test('claimNextJob requeues delayed failures and reclaims expired worker leases atomically', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (calls.length === 1) return { rows: [], rowCount: 0 };
      return { rows: [{ id: 42, status: 'running', attempts: 2 }] };
    },
  };

  const job = await claimNextJob(db);

  assert.equal(job.id, 42);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /attempts >= \$1/);
  assert.match(calls[0].sql, /heartbeat_at/);
  assert.match(calls[1].sql, /status='failed'.*finished_at/s);
  assert.match(calls[1].sql, /status='running'.*heartbeat_at/s);
  assert.match(calls[1].sql, /FOR UPDATE\s+SKIP LOCKED/);
  assert.match(calls[1].sql, /attempts=job\.attempts\+1/);
  assert.match(calls[1].sql, /lease_token=\$4/);
});

test('refreshJobHeartbeat reports whether a running worker still owns the job', async () => {
  let captured;
  const db = {
    async query(sql, values) {
      captured = { sql, values };
      return { rowCount: 1 };
    },
  };

  assert.equal(await refreshJobHeartbeat(42, 'lease-test', db), true);
  assert.deepEqual(captured.values, [42, 'lease-test']);
  assert.match(captured.sql, /status='running'/);
  assert.match(captured.sql, /lease_token=\$2/);
});
