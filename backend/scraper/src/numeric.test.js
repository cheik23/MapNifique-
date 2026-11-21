import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBoundedInteger } from './numeric.js';

test('parseBoundedInteger uses fallback only for absent values', () => {
  assert.equal(parseBoundedInteger(undefined, { fallback: 25, min: 1, max: 100 }), 25);
  assert.equal(parseBoundedInteger('', { fallback: 25, min: 1, max: 100 }), 25);
  assert.equal(parseBoundedInteger('26', { fallback: 25, min: 1, max: 100 }), 26);
});

test('parseBoundedInteger rejects NaN, fractions, unsafe and out-of-range values', () => {
  for (const value of ['abc', '1.5', '0', '-1', '101', '9007199254740992', '1e2', true, {}, Infinity, NaN]) {
    assert.throws(() => parseBoundedInteger(value, { fallback: 25, min: 1, max: 100 }), RangeError);
  }
});

test('parseBoundedInteger accepts the lower bound and upper bound', () => {
  assert.equal(parseBoundedInteger(1, { fallback: 2, min: 1, max: 10 }), 1);
  assert.equal(parseBoundedInteger(10, { fallback: 2, min: 1, max: 10 }), 10);
});
