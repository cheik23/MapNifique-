import test from 'node:test';
import assert from 'node:assert/strict';
import { runOfferSource, upsertOffer } from './offers-sync.js';

const baseOffer = {
  sourceId: 'official-test', externalId: 'offer-1', title: 'Offre test',
  offerType: 'promotion', scope: 'brand', brandKey: 'test',
  sourceUrl: 'https://example.test/offer', status: 'draft',
};

test('upsertOffer persists a store-scoped placeId instead of hardcoding NULL', async () => {
  let captured;
  const db = { query: async (sql, values) => { captured = { sql, values }; return { rows: [{ id: 4 }] }; } };
  const row = await upsertOffer(db, { ...baseOffer, scope: 'store', placeId: 42 });
  assert.equal(row.id, 4);
  assert.match(captured.sql, /INSERT INTO offers/);
  assert.equal(captured.values[2], 42);
});

test('upsertOffer refuses store scope without a valid placeId', async () => {
  let called = false;
  await assert.rejects(upsertOffer({ query: async () => { called = true; } }, { ...baseOffer, scope: 'store' }), /placeId valide/);
  assert.equal(called, false);
});

test('upsertOffer keeps brand offers unbound to a physical store', async () => {
  let values;
  await upsertOffer({ query: async (_sql, params) => { values = params; return { rows: [{ id: 1 }] }; } }, {
    ...baseOffer, placeId: 42,
  });
  assert.equal(values[2], null);
});

test('runOfferSource records and returns a failed collection instead of swallowing it', async () => {
  const calls = [];
  const logger = { log() {}, warn() {}, error() {} };
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/INSERT INTO offer_sync_runs/.test(sql)) return { rows: [{ id: 19 }] };
    if (/UPDATE offer_sync_runs/.test(sql)) return { rowCount: 1 };
    throw new Error('unexpected query');
  } };
  const result = await runOfferSource({
    db, sourceId: 'official-test', collector: async () => { throw new Error('fixture failure'); },
    dryRun: false, logger,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /fixture failure/);
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /status='failed'/);
});

test('runOfferSource reports a journal failure instead of hiding it', async () => {
  let updates = 0;
  const result = await runOfferSource({
    db: { query: async (sql) => {
      if (/INSERT INTO offer_sync_runs/.test(sql)) return { rows: [{ id: 20 }] };
      if (/UPDATE offer_sync_runs/.test(sql)) { updates += 1; throw new Error('journal unavailable'); }
      throw new Error('unexpected query');
    } },
    sourceId: 'official-test',
    collector: async () => { throw new Error('collector failed'); },
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /collector failed/);
  assert.match(result.journalError, /journal unavailable/);
  assert.equal(updates, 1);
});

test('runOfferSource writes offers and success journal in one reserved transaction', async () => {
  const operations = [];
  const client = {
    async query(sql) {
      const normalized = sql.trim().split(/\s+/).slice(0, 3).join(' ');
      operations.push(normalized);
      if (/INSERT INTO offers/.test(sql)) return { rows: [{ id: 4 }] };
      return { rowCount: 1 };
    },
    release() { operations.push('RELEASE'); },
  };
  const db = {
    async query(sql) {
      if (/INSERT INTO offer_sync_runs/.test(sql)) return { rows: [{ id: 21 }] };
      throw new Error('pool.query inattendu');
    },
    async connect() { operations.push('CONNECT'); return client; },
  };
  const result = await runOfferSource({
    db, sourceId: 'official-test', collector: async () => ({ offers: [baseOffer], warnings: ['one page skipped'] }),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'partial');
  assert.equal(result.offersUpserted, 1);
  assert.equal(operations[0], 'CONNECT');
  assert.equal(operations[1], 'BEGIN');
  assert.ok(operations.some((value) => value.startsWith('UPDATE offer_sync_runs')));
  assert.equal(operations.at(-2), 'COMMIT');
  assert.equal(operations.at(-1), 'RELEASE');
});

test('runOfferSource rolls back the complete source batch when one offer upsert fails', async () => {
  const operations = [];
  let persisted = 0;
  const client = {
    async query(sql) {
      const command = sql.trim().split(/\s+/).slice(0, 2).join(' ');
      operations.push(command);
      if (/INSERT INTO offers/.test(sql)) {
        if (++persisted === 2) throw new Error('second offer rejected');
        return { rows: [{ id: 10 }] };
      }
      return { rowCount: 1 };
    },
    release() { operations.push('RELEASE'); },
  };
  const db = {
    async query(sql) {
      if (/INSERT INTO offer_sync_runs/.test(sql)) return { rows: [{ id: 22 }] };
      if (/UPDATE offer_sync_runs/.test(sql)) return { rowCount: 1 };
      throw new Error('unexpected pool query');
    },
    async connect() { return client; },
  };
  const result = await runOfferSource({
    db,
    sourceId: 'official-test',
    collector: async () => ({ offers: [baseOffer, { ...baseOffer, externalId: 'offer-2' }], warnings: [] }),
    logger: { log() {}, warn() {}, error() {} },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /second offer rejected/);
  assert.ok(operations.includes('BEGIN'));
  assert.ok(operations.includes('ROLLBACK'));
  assert.equal(operations.includes('COMMIT'), false);
  assert.equal(operations.at(-1), 'RELEASE');
});


test('upsertOffer rejects brand/online offers without a brandKey', async () => {
  let called = false;
  for (const scope of ['brand', 'online']) {
    await assert.rejects(
      upsertOffer({ query: async () => { called = true; } }, { ...baseOffer, scope, brandKey: '' }),
      /brandKey/,
    );
  }
  assert.equal(called, false);
});
