import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceInput, toPublicSource, upsertSource } from './source-admin.js';

const config = {
  defaultRequestsPerMinute: 12,
  defaultSameDomainDelaySecs: 2,
  defaultMaxPages: 100,
  hardMaxPages: 2000,
};

const base = {
  id: 'example-shop',
  name: 'Example Shop',
  baseUrl: 'https://www.example.test/path',
};

test('une source nouvellement créée reste désactivée et non approuvée par défaut', () => {
  const source = normalizeSourceInput(base, config);
  assert.equal(source.enabled, false);
  assert.equal(source.licenseApproved, false);
  assert.equal(source.licenseReviewNote, null);
  assert.equal(source.baseUrl, 'https://www.example.test');
});

test('une source ne peut pas être activée sans approbation de licence explicite', () => {
  assert.throws(
    () => normalizeSourceInput({ ...base, enabled: true }, config),
    /revue de licence.*approuvée/i,
  );
});

test('une approbation de licence sans note de revue est refusée', () => {
  assert.throws(
    () => normalizeSourceInput({ ...base, licenseApproved: true }, config),
    /note documentant la revue/i,
  );
});

test('activation explicite exige enabled, licenseApproved et une justification', () => {
  const source = normalizeSourceInput({
    ...base,
    enabled: true,
    licenseApproved: true,
    licenseReviewNote: 'Conditions et droits de réutilisation vérifiés ; robots et cadence examinés.',
  }, config);
  assert.equal(source.enabled, true);
  assert.equal(source.licenseApproved, true);
  assert.match(source.licenseReviewNote, /droits de réutilisation/);
});

test('upsertSource transmet les deux opt-in et la justification dans la même écriture', async () => {
  let captured;
  const db = { query: async (sql, values) => {
    captured = { sql, values };
    return { rows: [{ id: 'example-shop', enabled: true, licenseApproved: true }] };
  } };
  const result = await upsertSource(db, {
    ...base,
    enabled: true,
    licenseApproved: true,
    licenseReviewNote: 'Revue juridique approuvée le 2026-11-20.',
  }, config);
  assert.equal(result.enabled, true);
  assert.match(captured.sql, /license_approved/);
  assert.match(captured.sql, /license_reviewed_at/);
  assert.equal(captured.values[8], true);
  assert.equal(captured.values[9], true);
  assert.equal(captured.values[10], 'Revue juridique approuvée le 2026-11-20.');
});

test('désactiver une source retire également son approbation de collecte', () => {
  const source = normalizeSourceInput({ ...base, enabled: false, licenseApproved: false }, config);
  assert.equal(source.enabled, false);
  assert.equal(source.licenseApproved, false);
  assert.equal(source.licenseReviewNote, null);
});


test('la projection publique ne divulgue jamais la note interne de revue de licence', () => {
  const result = toPublicSource({
    id: 'example-shop',
    name: 'Example Shop',
    baseUrl: 'https://www.example.test',
    enabled: false,
    licenseApproved: false,
    licenseReviewNote: 'INTERNAL-LEGAL-NOTE',
    license_review_note: 'INTERNAL-LEGAL-NOTE-SNAKE',
    requestsPerMinute: 12,
    sameDomainDelaySecs: 2,
    maxPagesPerRun: 100,
  });
  assert.equal(result.id, 'example-shop');
  assert.equal(result.enabled, false);
  assert.equal('licenseReviewNote' in result, false);
  assert.equal('license_review_note' in result, false);
  assert.equal(JSON.stringify(result).includes('INTERNAL-LEGAL-NOTE'), false);
});


test('une URL de source refuse les IP littérales, domaines internes et ports personnalisés', () => {
  for (const baseUrl of [
    'http://127.0.0.1',
    'http://192.168.1.10',
    'http://[::1]',
    'https://metadata.google.internal',
    'https://shop.example.local',
    'https://shop.example.test:8443',
  ]) {
    assert.throws(() => normalizeSourceInput({ ...base, baseUrl }, config), /nom DNS public|ports personnalisés/i);
  }
});

test('les paramètres de collecte doivent être des entiers dans les limites explicites', () => {
  for (const [field, value] of [
    ['requestsPerMinute', 'NaN'],
    ['requestsPerMinute', 0],
    ['requestsPerMinute', 120.5],
    ['requestsPerMinute', 121],
    ['sameDomainDelaySecs', -1],
    ['sameDomainDelaySecs', 60.5],
    ['maxPagesPerRun', 0],
    ['maxPagesPerRun', config.hardMaxPages + 1],
  ]) {
    assert.throws(() => normalizeSourceInput({ ...base, [field]: value }, config), /entier compris/i);
  }
});
