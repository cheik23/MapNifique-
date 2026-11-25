import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IdentityConflictError,
  buildDiscoveredProduct,
  classifyCandidates,
  finalizeJob,
  stageProducts,
  resolveBlockedCandidate,
  persistConflict,
  withTransaction,
} from './stage.js';
import { mergeCandidates } from './identity.js';

function fakePool(handler) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      return handler(sql, params, calls);
    },
    release() {
      calls.push({ sql: '__release__' });
    },
  };
  return {
    pool: {
      async connect() {
        calls.push({ sql: '__connect__' });
        return client;
      },
    },
    calls,
  };
}

const jobRow = { id: 7, source_id: 'shop', status: 'running', lease_token: 'lease-1' };

test('withTransaction : BEGIN/COMMIT sur le même client, release systématique', async () => {
  const { pool, calls } = fakePool(async (sql) => ({ rows: [] }));
  const result = await withTransaction(pool, async (client) => {
    await client.query('SELECT 1');
    return 'ok';
  });

  assert.equal(result, 'ok');
  assert.equal(calls[0].sql, '__connect__');
  assert.match(calls[1].sql, /^BEGIN$/);
  assert.match(calls[calls.length - 2].sql, /^COMMIT$/);
  assert.equal(calls[calls.length - 1].sql, '__release__');
  assert.equal(calls.filter((call) => call.sql === 'SELECT 1').length, 1);
});

test('withTransaction : ROLLBACK puis release sur erreur', async () => {
  const { pool, calls } = fakePool(async () => ({ rows: [] }));
  await assert.rejects(
    () => withTransaction(pool, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  const sqls = calls.map((call) => call.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.equal(sqls.includes('COMMIT'), false);
  assert.equal(sqls[sqls.length - 1], '__release__');
});

test('finalizeJob sans candidat : aucune écriture, COMMIT, lease vérifié', async () => {
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    return { rows: [] };
  });

  const result = await finalizeJob({ pool, jobId: 7, leaseToken: 'lease-1' });
  assert.deepEqual(result, { products: 0, observations: 0, groups: 0, candidates: 0 });

  const sqls = calls.map((call) => call.sql.trim());
  assert.equal(sqls[0], '__connect__');
  assert.equal(sqls[1], 'BEGIN');
  assert.ok(sqls.some((sql) => /FROM scrape_jobs[\s\S]*FOR UPDATE/.test(sql)));
  assert.ok(sqls.some((sql) => /^COMMIT$/.test(sql)));
  assert.equal(sqls[sqls.length - 1], '__release__');
});

test('finalizeJob : lease invalide bloque avant toute écriture', async () => {
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) {
      return { rows: [{ ...jobRow, lease_token: 'autre-lease' }] };
    }
    return { rows: [] };
  });

  await assert.rejects(
    () => finalizeJob({ pool, jobId: 7, leaseToken: 'lease-1' }),
    (error) => error.code === 'MN002',
  );
  const sqls = calls.map((call) => call.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.equal(sqls.includes('COMMIT'), false);
  assert.equal(sqls[sqls.length - 1], '__release__');
});

test('finalizeJob : conflit de GTIN sur une composante ⇒ rollback complet', async () => {
  const candidates = [
    {
      id: 1,
      discovery_key: 'd1',
      identity_key: 'g:04006381333931',
      identifiers: [
        { namespace: 'url', scope: 'source', sourceId: 'shop', value: 'https://shop.example/p/a' },
        { namespace: 'gtin', scope: 'global', sourceId: null, value: '04006381333931' },
      ],
      identity: { name: 'A', variant: {} },
      image_url: null,
      name: 'A',
      brand: null,
      product_url: 'https://shop.example/p/a',
      discovered_from: 'https://shop.example/c',
      status: 'staged',
    },
    {
      id: 2,
      discovery_key: 'd2',
      identity_key: 'g:04006381333932',
      identifiers: [
        { namespace: 'url', scope: 'source', sourceId: 'shop', value: 'https://shop.example/p/a' },
        { namespace: 'gtin', scope: 'global', sourceId: null, value: '04006381333932' },
      ],
      identity: { name: 'A bis', variant: {} },
      image_url: null,
      name: 'A bis',
      brand: null,
      product_url: 'https://shop.example/p/a',
      discovered_from: 'https://shop.example/c',
      status: 'staged',
    },
  ];

  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/status='blocked'/.test(sql) || /block_reason IS NOT NULL/.test(sql)) return { rows: [] };
    if (/FROM product_candidates c/.test(sql) && /status IN/.test(sql)) return { rows: candidates };
    return { rows: [] };
  });

  let recorded = null;
  await assert.rejects(
    () => finalizeJob({
      pool,
      jobId: 7,
      leaseToken: 'lease-1',
      identityConflictRecorder: async (detail) => { recorded = detail; },
    }),
    (error) => error instanceof IdentityConflictError && error.code === 'MN003',
  );

  assert.ok(recorded);
  assert.equal(recorded.conflicts[0].kind, 'gtin-conflict');
  const sqls = calls.map((call) => call.sql);
  assert.ok(sqls.includes('ROLLBACK'));
  assert.equal(sqls.includes('COMMIT'), false);
  assert.equal(sqls[sqls.length - 1], '__release__');
});

test('stageProducts : aucune page produit ⇒ aucun accès base', async () => {
  const { pool, calls } = fakePool(async () => ({ rows: [] }));
  const counters = await stageProducts({
    pool,
    jobId: 7,
    leaseToken: 'lease-1',
    sourceId: 'shop',
    products: [],
  });
  assert.deepEqual(counters, {
    candidatesCreated: 0,
    candidatesUpdated: 0,
    observationsAdded: 0,
    observationSourcesAdded: 0,
    candidateSourcesAdded: 0,
    blocked: 0,
  });
  assert.equal(calls.length, 0);
});

test('buildDiscoveredProduct + merge : deux prix, un candidat, deux observations', () => {
  const extracted = {
    name: 'Café moulu',
    productUrl: 'https://shop.example/p/cafe',
    productUrlEvidence: 'jsonld-product-url',
    discoveredFrom: 'https://shop.example/catalogue',
    price: 5.2,
    currency: 'EUR',
    priceScope: 'unknown',
    method: 'jsonld',
    jsonldIndex: 0,
  };
  const second = {
    ...extracted,
    price: 6.1,
    storeCode: 'Lyon',
  };

  const [merged] = mergeCandidates([
    buildDiscoveredProduct(extracted, { sourceId: 'shop' }),
    buildDiscoveredProduct(second, { sourceId: 'shop' }),
  ]);

  assert.equal(merged.identityKey, 'u:https://shop.example/p/cafe');
  assert.equal(merged.observations.length, 2);
  assert.equal(new Set(merged.observations.map((observation) => observation.fingerprint)).size, 2);
});

test('buildDiscoveredProduct : la provenance pointe la bonne observation', () => {
  const product = buildDiscoveredProduct({
    name: 'Lessive',
    productUrl: 'https://shop.example/p/lessive',
    productUrlEvidence: 'jsonld-product-url',
    discoveredFrom: 'https://shop.example/catalogue',
    cardUrl: 'https://shop.example/p/lessive',
    price: 7.99,
    currency: null,
    method: 'jsonld',
    jsonldIndex: 3,
  }, { sourceId: 'shop' });

  assert.equal(product.observations[0].sources.length, 1);
  assert.equal(product.observations[0].sources[0].jsonldIndex, 3);
  assert.equal(product.observations[0].currency, null);
  assert.equal(product.discoveredFrom, 'https://shop.example/catalogue');
});

test('classifyCandidates : URL partagée fusionne, variantes partielles enrichissent', () => {
  const candidates = [
    {
      id: 1,
      identityKey: 'u:https://shop.example/p/1',
      identity: { variant: { size: 'XL' } },
      identifiers: [{ namespace: 'url', scope: 'source', value: 'https://shop.example/p/1' }],
      observations: [],
    },
    {
      id: 2,
      identityKey: 'u:https://shop.example/p/1',
      identity: { variant: { color: 'Bleu' } },
      identifiers: [{ namespace: 'url', scope: 'source', value: 'https://shop.example/p/1' }],
      observations: [],
    },
  ];

  const { groups, conflicts } = classifyCandidates(candidates);
  assert.equal(conflicts.length, 0);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].variants, { size: 'XL', color: 'Bleu' });
});

test('classifyCandidates : variantes contradictoires bloquantes', () => {
  const candidates = [
    {
      id: 1,
      identityKey: 'g:04006381333931',
      identity: { variant: { size: 'XL' } },
      identifiers: [
        { namespace: 'gtin', scope: 'global', value: '04006381333931' },
        { namespace: 'url', scope: 'source', value: 'https://shop.example/p/1' },
      ],
      observations: [],
    },
    {
      id: 2,
      identityKey: 'g:04006381333931',
      identity: { variant: { size: 'M' } },
      identifiers: [
        { namespace: 'gtin', scope: 'global', value: '04006381333931' },
        { namespace: 'url', scope: 'source', value: 'https://shop.example/p/1' },
      ],
      observations: [],
    },
  ];

  const { conflicts } = classifyCandidates(candidates);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].kind, 'variant-conflict');
  assert.equal(conflicts[0].field, 'size');
});

test('classifyCandidates : SKU partagé avec GTIN contradictoires bloqué', () => {
  const candidates = [
    {
      id: 1,
      identityKey: 'g:04006381333931',
      identity: { variant: {} },
      identifiers: [
        { namespace: 'gtin', scope: 'global', value: '04006381333931' },
        { namespace: 'sku', scope: 'source', value: 'SKU-1' },
      ],
      observations: [],
    },
    {
      id: 2,
      identityKey: 'g:04006381333932',
      identity: { variant: {} },
      identifiers: [
        { namespace: 'gtin', scope: 'global', value: '04006381333932' },
        { namespace: 'sku', scope: 'source', value: 'SKU-1' },
      ],
      observations: [],
    },
  ];

  const { conflicts } = classifyCandidates(candidates);
  assert.equal(conflicts.some((conflict) => conflict.kind === 'gtin-conflict'), true);
});

test('classifyCandidates : produits distincts sans identifiant partagé restent séparés', () => {
  const { groups, conflicts } = classifyCandidates([
    {
      id: 1,
      identityKey: 'u:https://shop.example/p/a',
      identity: { variant: {} },
      identifiers: [{ namespace: 'url', scope: 'source', value: 'https://shop.example/p/a' }],
      observations: [],
    },
    {
      id: 2,
      identityKey: 'u:https://shop.example/p/b',
      identity: { variant: {} },
      identifiers: [{ namespace: 'url', scope: 'source', value: 'https://shop.example/p/b' }],
      observations: [],
    },
  ]);
  assert.equal(conflicts.length, 0);
  assert.equal(groups.length, 2);
});


test('stageProducts conserve les nouvelles observations d’un candidat bloqué sans le réactiver', async () => {
  const candidate = {
    id: 91, identity_key: 'u:https://shop.example/p/tea', identifiers: [],
    identity: { name: 'Thé', variant: {} }, status: 'blocked', product_id: null,
    block_reason: 'variant-conflict',
  };
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/COUNT\(\*\)::int AS total FROM product_candidates/.test(sql)) return { rows: [{ total: 1 }] };
    if (/INSERT INTO product_candidates/.test(sql)) return { rows: [] };
    if (/SELECT id, identity_key, identifiers, identity, status/.test(sql)) return { rows: [candidate] };
    if (/INSERT INTO product_candidate_observations/.test(sql)) return { rows: [{ id: 501 }] };
    if (/INSERT INTO product_candidate_observation_sources/.test(sql)) return { rows: [{ id: 601 }] };
    if (/INSERT INTO product_candidate_sources/.test(sql)) return { rows: [{ id: 701 }] };
    return { rows: [] };
  });
  const result = await stageProducts({
    pool, jobId: 7, leaseToken: 'lease-1', sourceId: 'shop',
    products: [{
      name: 'Thé', productUrl: 'https://shop.example/p/tea',
      discoveredFrom: 'https://shop.example/category', price: 4.2, currency: 'EUR',
      method: 'css', evidence: 'css-card-link',
    }],
  });
  assert.equal(result.blocked, 1);
  assert.equal(result.observationsAdded, 1);
  assert.ok(calls.some((call) => /INSERT INTO product_candidate_observations/.test(call.sql)));
  assert.equal(calls.some((call) => /SET status='staged'/.test(call.sql)), false);
});

test('identity moins forte : anomalie enregistrée et observation/provenance conservées', async () => {
  const storedCandidate = {
    id: 94, identity_key: 'g:04006381333931', identifiers: [{ namespace: 'gtin', value: '04006381333931' }],
    identity: { name: 'Thé', variant: {} }, status: 'staged', product_id: null,
    block_reason: null, name: 'Thé', brand: null, product_url: 'https://shop.example/p/tea',
    discovered_from: 'https://shop.example/category',
  };
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/COUNT\(\*\)::int AS total FROM product_candidates/.test(sql)) return { rows: [{ total: 1 }] };
    if (/INSERT INTO product_candidates/.test(sql)) return { rows: [] };
    if (/SELECT id, identity_key, identifiers, identity, status, product_id, block_reason/.test(sql)) return { rows: [storedCandidate] };
    if (/SELECT id, identity_key, identifiers, name, brand, product_url/.test(sql)) return { rows: [storedCandidate] };
    if (/INSERT INTO product_identity_anomalies/.test(sql)) return { rows: [{ id: 88 }] };
    if (/INSERT INTO product_candidate_observations/.test(sql)) return { rows: [{ id: 502 }] };
    if (/INSERT INTO product_candidate_observation_sources/.test(sql)) return { rows: [{ id: 602 }] };
    if (/INSERT INTO product_candidate_sources/.test(sql)) return { rows: [{ id: 702 }] };
    return { rows: [] };
  });
  const result = await stageProducts({
    pool, jobId: 7, leaseToken: 'lease-1', sourceId: 'shop',
    products: [{
      name: 'Thé', productUrl: 'https://shop.example/p/tea',
      discoveredFrom: 'https://shop.example/category', price: 4.2, currency: 'EUR',
      method: 'css', evidence: 'css-card-link',
    }],
  });
  assert.equal(result.blocked, 1);
  assert.equal(result.observationsAdded, 1);
  assert.ok(calls.some((call) => /INSERT INTO product_identity_anomalies/.test(call.sql)));
  assert.ok(calls.some((call) => /INSERT INTO product_candidate_observations/.test(call.sql)));
});

test('finalizeJob refuse explicitement les candidats bloqués', async () => {
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/status='blocked'/.test(sql)) return { rows: [{ id: 91 }] };
    return { rows: [] };
  });
  let recorded = null;
  await assert.rejects(() => finalizeJob({
    pool, jobId: 7, leaseToken: 'lease-1',
    identityConflictRecorder: async (detail) => { recorded = detail; },
  }), (error) => error instanceof IdentityConflictError && error.detail.kind === 'blocked-candidates');
  assert.deepEqual(recorded.candidateIds, [91]);
  assert.ok(calls.some((call) => /status='blocked'/.test(call.sql)));
  assert.equal(calls.some((call) => /status IN \('staged','classified','blocked'\)/.test(call.sql)), false);
});

test('persistConflict refuse un worker dont le lease est périmé', async () => {
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [{ ...jobRow, lease_token: 'stale' }] };
    return { rows: [] };
  });
  await assert.rejects(() => persistConflict(pool, 7, 'lease-1', { kind: 'test', candidateIds: [4] }), (error) => error.code === 'MN002');
  assert.equal(calls.some((call) => /INSERT INTO product_identity_anomalies/.test(call.sql)), false);
});

test('résolution humaine requise avant réactivation du candidat bloqué', async () => {
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/FROM product_identity_anomalies/.test(sql)) return { rows: [{ id: 12, candidate_id: 91, reviewed_at: null, detail: {} }] };
    if (/FROM product_candidates/.test(sql) && /FOR UPDATE/.test(sql)) return { rows: [{ id: 91, status: 'blocked', block_reason: 'variant-conflict' }] };
    if (/COUNT\(\*\).*product_identity_anomalies/.test(sql)) return { rows: [{ total: 0 }] };
    if (/UPDATE product_candidates/.test(sql)) return { rows: [{ id: 91 }] };
    return { rows: [] };
  });
  const result = await resolveBlockedCandidate({
    pool, jobId: 7, leaseToken: 'lease-1', candidateId: 91, anomalyId: 12,
    resolution: { action: 'retry', reviewer: 'operator', note: 'Contrôle manuel effectué.' },
  });
  assert.equal(result.status, 'staged');
  assert.ok(calls.some((call) => /reviewed_at=NOW\(\)/.test(call.sql)));
});

test('revue admin : un job échoué est remis en file après résolution explicite', async () => {
  const failedJob = { ...jobRow, status: 'failed', lease_token: null };
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [failedJob] };
    if (/FROM product_identity_anomalies/.test(sql)) return { rows: [{ id: 14, candidate_id: 93, reviewed_at: null, detail: {} }] };
    if (/FROM product_candidates/.test(sql) && /FOR UPDATE/.test(sql)) {
      return { rows: [{ id: 93, status: 'blocked', block_reason: 'variant-conflict' }] };
    }
    if (/COUNT\(\*\).*product_identity_anomalies/.test(sql)) return { rows: [{ total: 0 }] };
    if (/UPDATE scrape_jobs/.test(sql)) return { rows: [{ id: 7 }], rowCount: 1 };
    return { rows: [] };
  });
  const result = await resolveBlockedCandidate({
    pool, jobId: 7, candidateId: 93, anomalyId: 14, adminReview: true,
    resolution: { action: 'retry', reviewer: 'admin', note: 'Identité corrigée et contrôlée.' },
  });
  assert.equal(result.status, 'staged');
  assert.equal(result.jobRequeued, true);
  assert.ok(calls.some((call) => /SET status='queued', attempts=0/.test(call.sql)));
});

test('résolution confirm-same-product conserve la décision réelle dans l’audit', async () => {
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/FROM product_identity_anomalies/.test(sql)) return { rows: [{
      id: 13, candidate_id: 92, reviewed_at: null,
      detail: {
        incomingKey: 'g:04006381333931',
        incomingIdentity: { name: 'Savon', brand: 'Marque', category: null, variant: { size: 'M' } },
        incomingIdentifiers: [{ namespace: 'gtin', value: '04006381333931', scope: 'global', sourceId: null }],
        incomingProductUrl: 'https://shop.example/p/savon',
      },
    }] };
    if (/FROM product_candidates/.test(sql) && /FOR UPDATE/.test(sql)) {
      return { rows: [{
        id: 92, status: 'finalized', block_reason: 'post-finalization-identity-change',
        identity_key: 'u:https://shop.example/p/savon', identifiers: [],
        identity: { name: 'Savon', variant: {} }, product_url: 'https://shop.example/p/savon',
      }] };
    }
    if (/COUNT\(\*\).*product_identity_anomalies/.test(sql)) return { rows: [{ total: 0 }] };
    return { rows: [] };
  });
  const result = await resolveBlockedCandidate({
    pool, jobId: 7, leaseToken: 'lease-1', candidateId: 92, anomalyId: 13,
    resolution: { action: 'confirm-same-product', reviewer: 'operator', note: 'GTIN et variantes vérifiés manuellement.' },
  });
  assert.equal(result.status, 'finalized');
  const reviewCall = calls.find((call) => /UPDATE product_identity_anomalies/.test(call.sql));
  assert.equal(JSON.parse(reviewCall.params[1]).resolution.action, 'confirm-same-product');
  const promotionCall = calls.find((call) => /UPDATE product_candidates[\s\S]*SET identity_key/.test(call.sql));
  assert.ok(promotionCall);
  assert.equal(promotionCall.params[1], 'g:04006381333931');
});

test('observation ajoutée après finalisation : le staging conserve son rattachement en attente', () => {
  const discovered = buildDiscoveredProduct({
    name: 'Soda', productUrl: 'https://shop.example/p/soda',
    discoveredFrom: 'https://shop.example/categorie', price: 1.2, currency: 'EUR', method: 'css',
  }, { sourceId: 'shop' });
  assert.equal(discovered.observations.length, 1);
  assert.equal(discovered.observations[0].price, 1.2);
  assert.equal(discovered.observations[0].sources.length, 1);
});


test('finalizeJob reprend une observation non consommée d’un candidat finalisé', async () => {
  const candidate = {
    id: 44, discovery_key: 'discovery-44', identity_key: 'u:https://shop.example/p/tea',
    identifiers: [{ namespace: 'url', scope: 'source', sourceId: 'shop', value: 'https://shop.example/p/tea' }],
    identity: { name: 'Thé', brand: null, category: null, variant: {} }, name: 'Thé', brand: null,
    category: null, image_url: null, product_url: 'https://shop.example/p/tea',
    discovered_from: 'https://shop.example/categorie', status: 'finalized', product_id: 55, block_reason: null,
  };
  const observation = {
    id: 101, candidate_id: 44, product_observation_id: null, fingerprint: 'fp-101', store_code: null,
    price: '4.20', regular_price: null, currency: 'EUR', promotion: null, availability: null,
    price_scope: 'unknown', source_url: 'https://shop.example/categorie', observed_at: new Date('2026-11-19T10:00:00Z'),
  };
  const { pool, calls } = fakePool(async (sql) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/status='blocked'/.test(sql) || /block_reason IS NOT NULL/.test(sql)) return { rows: [] };
    if (/FROM product_candidates c/.test(sql) && /status IN/.test(sql)) return { rows: [candidate] };
    if (/SELECT c\.id FROM product_candidates c/.test(sql)) return { rows: [] };
    if (/FROM product_candidate_observations/.test(sql) && /product_observation_id IS NULL/.test(sql)) return { rows: [observation] };
    if (/FROM product_candidate_observation_sources/.test(sql)) return { rows: [{
      observation_id: 101, method: 'css', discovered_from: 'https://shop.example/categorie',
      discovered_url: 'https://shop.example/p/tea', evidence: 'css-card-link', jsonld_index: -1, selector_index: 2,
    }] };
    if (/INSERT INTO product_identifiers/.test(sql)) return { rows: [{ id: 800 }] };
    if (/FROM product_identifiers/.test(sql)) return { rows: [] };
    if (/FROM products WHERE source_id/.test(sql)) return { rows: [] };
    if (/SELECT id, gtin, name, brand, category, image_url, identity/.test(sql)) return { rows: [{
      id: 55, gtin: null, name: 'Thé', brand: null, category: null, image_url: null,
      identity: { name: 'Thé', variant: {} },
    }] };
    if (/INSERT INTO price_observations/.test(sql)) return { rows: [{ id: 901 }] };
    if (/UPDATE product_candidate_observations/.test(sql)) return { rows: [{ id: 101 }], rowCount: 1 };
    return { rows: [] };
  });
  const result = await finalizeJob({ pool, jobId: 7, leaseToken: 'lease-1' });
  assert.equal(result.observations, 1);
  assert.ok(calls.some((call) => /SET product_observation_id=\$2/.test(call.sql)));
  assert.ok(calls.some((call) => /^COMMIT$/.test(call.sql.trim())));
});


test('persistConflict crée une anomalie révisable par candidat lié', async () => {
  const inserted = [];
  const { pool } = fakePool(async (sql, params) => {
    if (/FROM scrape_jobs/.test(sql)) return { rows: [jobRow] };
    if (/FROM product_candidates/.test(sql)) return { rows: [
      { id: 10, identity_key: 'u:https://shop.example/p/1', status: 'staged' },
      { id: 11, identity_key: 'u:https://shop.example/p/1', status: 'staged' },
    ] };
    if (/INSERT INTO product_identity_anomalies/.test(sql)) { inserted.push(params[2]); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  });
  await persistConflict(pool, 7, 'lease-1', { kind: 'variant-conflict', candidateIds: [10, 11] });
  assert.deepEqual(inserted, [10, 11]);
});
