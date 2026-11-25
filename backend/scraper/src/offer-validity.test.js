import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addCalendarYears,
  applyOfferRetention,
  classifyOfferStatus,
  getDateInTimeZone,
  parseDateOnly,
} from './offer-validity.js';

test('date-only parser rejects normalized and timestamp values', () => {
  assert.equal(parseDateOnly('2026-02-28'), '2026-02-28');
  assert.equal(parseDateOnly('2026-02-29'), null);
  assert.equal(parseDateOnly('2026-02-31'), null);
  assert.equal(parseDateOnly('2026-11-14T00:00:00Z'), null);
});

test('offer end date is inclusive for the whole local calendar day', () => {
  assert.equal(classifyOfferStatus('2026-11-01', '2026-11-14', '2026-11-14'), 'active');
  assert.equal(classifyOfferStatus('2026-11-01', '2026-11-14', '2026-11-15'), 'expired');
});

test('offers without a valid end date cannot become active', () => {
  assert.equal(classifyOfferStatus('2026-11-01', null, '2026-11-14'), 'draft');
  assert.equal(classifyOfferStatus('2026-11-01', 'not-a-date', '2026-11-14'), 'draft');
});

test('future and reversed validity periods remain drafts', () => {
  assert.equal(classifyOfferStatus('2026-11-15', '2026-11-20', '2026-11-14'), 'draft');
  assert.equal(classifyOfferStatus('2026-11-21', '2026-11-20', '2026-11-14'), 'draft');
});

test('Paris calendar date accounts for UTC and daylight-saving offsets', () => {
  assert.equal(getDateInTimeZone(new Date('2026-03-28T23:30:00.000Z')), '2026-03-29');
  assert.equal(getDateInTimeZone(new Date('2026-10-25T23:30:00.000Z')), '2026-10-26');
});

test('calendar retention cutoff handles leap day without rolling into March', () => {
  assert.equal(addCalendarYears('2024-02-29', -1), '2023-02-28');
  assert.equal(addCalendarYears('2026-11-14', -1), '2025-11-14');
});

test('retention job passes deterministic Paris date cutoffs and is repeatable', async () => {
  const calls = [];
  const result = await applyOfferRetention({
    async query(sql, values) {
      calls.push({ sql, values });
      return { rowCount: 2 };
    },
  }, '2026-11-14');

  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /UPDATE offers/);
  assert.match(calls[0].sql, /valid_until < \$1::date/);
  assert.deepEqual(calls[0].values, ['2026-11-14']);
  assert.match(calls[1].sql, /DELETE FROM offers/);
  assert.match(calls[1].sql, /COALESCE\([\s\S]*created_at AT TIME ZONE 'Europe\/Paris'/);
  assert.deepEqual(calls[1].values, ['2025-11-14']);
  assert.deepEqual(result, { expired: 2, deleted: 2, cutoffDate: '2025-11-14' });
});

test('retention can be retried after an interrupted cleanup', async () => {
  let offerStatus = 'active';
  let shouldFailDelete = true;
  const pool = {
    async query(sql) {
      if (/UPDATE offers/.test(sql)) {
        const didExpire = offerStatus === 'active';
        if (didExpire) offerStatus = 'expired';
        return { rowCount: Number(didExpire) };
      }

      if (/DELETE FROM offers/.test(sql)) {
        if (shouldFailDelete) {
          shouldFailDelete = false;
          throw new Error('temporary database interruption');
        }
        const didDelete = offerStatus === 'expired';
        if (didDelete) offerStatus = 'deleted';
        return { rowCount: Number(didDelete) };
      }

      throw new Error('unexpected SQL');
    },
  };

  await assert.rejects(applyOfferRetention(pool, '2026-11-14'), /interruption/);
  assert.equal(offerStatus, 'expired');
  const retry = await applyOfferRetention(pool, '2026-11-14');
  assert.equal(retry.expired, 0);
  assert.equal(retry.deleted, 1);
  assert.equal(offerStatus, 'deleted');
});
