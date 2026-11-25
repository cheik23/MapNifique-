import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPlacesSchemaReady, registerPlaceRoutes } from './places-api.js';
import { getDateInTimeZone } from './offer-validity.js';

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
}

function makeReply() {
  return {
    statusCode: 200,
    payload: undefined,
    code(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return payload; },
  };
}

test('assertPlacesSchemaReady vérifie le schéma sans exécuter de DDL', async () => {
  const calls = [];
  const db = { query: async (sql, values) => {
    calls.push({ sql, values });
    if (/information_schema\.columns/i.test(sql)) return { rows: [] };
    return { rows: [{ restrictive_place_fk: true, store_place_required: true, non_store_place_null: true, brand_key_required: true, source_license_review_required: true, source_enable_requires_approval: true }] };
  } };
  const result = await assertPlacesSchemaReady(db);
  assert.equal(result.ready, true);
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /information_schema\.columns/i);
  assert.match(calls[1].sql, /pg_constraint/i);
  for (const call of calls) {
    assert.doesNotMatch(call.sql, /CREATE TABLE|ALTER TABLE|DROP TABLE|TRUNCATE|DELETE FROM/i);
  }
});

test('assertPlacesSchemaReady bloque le démarrage si la migration lieux/offres manque', async () => {
  const db = { query: async (sql) => {
    if (/information_schema\.columns/i.test(sql)) {
      return { rows: [{ missing: 'places.lat' }, { missing: 'offers.place_id' }] };
    }
    throw new Error('La deuxième requête ne doit pas être exécutée.');
  } };
  await assert.rejects(assertPlacesSchemaReady(db), (error) => {
    assert.equal(error.code, 'PLACES_SCHEMA_NOT_READY');
    assert.deepEqual(error.missing, ['places.lat', 'offers.place_id']);
    return true;
  });
});

test('GET /api/places validates coordinates and builds a bounded nearby search', async () => {
  const app = makeApp();
  let capturedSql = '';
  let capturedValues = [];
  const pool = { query: async (sql, values = []) => {
    capturedSql = sql;
    capturedValues = values;
    return { rows: [{ id: 7, name: 'Sephora', lat: 48.85, lon: 2.35 }] };
  } };
  registerPlaceRoutes(app, pool);
  const handler = app.routes.get('GET /api/places');
  const result = await handler({ query: { lat: '48.85', lon: '2.35', radiusM: '3000', q: 'Sephora', limit: '12' } }, makeReply());
  assert.equal(result.places.length, 1);
  assert.match(capturedSql, /p\.lat BETWEEN/);
  assert.match(capturedSql, /distance_m/);
  assert.ok(capturedValues.includes(3000));
  assert.ok(capturedValues.includes(12));
});

test('GET /api/places rejects an invalid coordinate pair', async () => {
  const app = makeApp();
  registerPlaceRoutes(app, { query: async () => { throw new Error('database should not be called'); } });
  const reply = makeReply();
  await app.routes.get('GET /api/places')({ query: { lat: '48.85' } }, reply);
  assert.equal(reply.statusCode, 400);
});

test('GET /api/offers returns four empty offer groups when no merchant is selected', async () => {
  const app = makeApp();
  registerPlaceRoutes(app, { query: async () => { throw new Error('database should not be called'); } });
  const result = await app.routes.get('GET /api/offers')({ query: {} }, makeReply());
  assert.deepEqual(result, { storeOffers: [], brandOffers: [], onlineOffers: [], cashbackOffers: [] });
});

test('GET /api/offers/brands includes active store-scoped promotions', async () => {
  const app = makeApp();
  let capturedSql = '';
  const pool = { query: async (sql) => {
    capturedSql = sql;
    return { rows: [{ brandKey: 'super-u' }, { brandKey: 'lidl' }] };
  } };
  registerPlaceRoutes(app, pool);
  const result = await app.routes.get('GET /api/offers/brands')();
  assert.deepEqual(result.brands, ['super-u', 'lidl']);
  assert.match(capturedSql, /scope IN \(\s*'store','brand','online'\s*\)/);
  assert.match(capturedSql, /status='active'/);
  assert.match(capturedSql, /verified_at IS NOT NULL/);
});

test('GET /api/offers supports the selected nearby radius for store-specific offers', async () => {
  const app = makeApp();
  let capturedSql = '';
  let capturedValues = [];
  const pool = { query: async (sql, values) => {
    capturedSql = sql;
    capturedValues = values;
    return { rows: [{ id: 8, scope: 'store', placeId: 42, storeLat: 48.85, storeLon: 2.35 }] };
  } };
  registerPlaceRoutes(app, pool);
  const result = await app.routes.get('GET /api/offers')({
    query: { merchantKey: 'lidl', lat: '48.85', lon: '2.35', radiusM: '5000' },
  }, makeReply());
  assert.equal(result.storeOffers.length, 1);
  assert.equal(capturedValues[5], 5000);
  assert.match(capturedSql, /<= \$6/);
  assert.match(capturedSql, /storeLat|p\.lat AS \"storeLat\"/);
});

test('GET /api/offers returns disjoint scope and cashback groups', async () => {
  const app = makeApp();
  const pool = { query: async () => ({ rows: [
    { id: 1, scope: 'store', offerType: 'promotion' },
    { id: 2, scope: 'brand', offerType: 'promotion' },
    { id: 3, scope: 'online', offerType: 'promotion' },
    { id: 4, scope: 'store', offerType: 'cashback' },
    { id: 5, scope: 'brand', offerType: 'cashback' },
  ] }) };
  registerPlaceRoutes(app, pool);
  const result = await app.routes.get('GET /api/offers')({ query: { merchantKey: 'lidl' } }, makeReply());
  assert.deepEqual(result.storeOffers.map((offer) => offer.id), [1]);
  assert.deepEqual(result.brandOffers.map((offer) => offer.id), [2]);
  assert.deepEqual(result.onlineOffers.map((offer) => offer.id), [3]);
  assert.deepEqual(result.cashbackOffers.map((offer) => offer.id), [4, 5]);
  const allIds = Object.values(result).flat().map((offer) => offer.id);
  assert.equal(new Set(allIds).size, allIds.length);
});

test('GET /api/discover matches local brand keys for pipe-separated brand queries', async () => {
  const app = makeApp();
  let capturedSql = '';
  let capturedValues = [];
  const pool = { query: async (sql, values) => {
    capturedSql = sql;
    capturedValues = values;
    return { rows: [{ id: 1, name: 'Super U', brandKey: 'super-u', lat: 48.851, lon: 2.351 }] };
  } };
  const priorFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ elements: [] }) });
  try {
    registerPlaceRoutes(app, pool);
    const result = await app.routes.get('GET /api/discover')({ query: {
      q: 'lidl|super-u', localOnly: '1', lat: '48.851', lon: '2.351', radiusM: '3000', limit: '20',
    }, log: { warn() {} } }, makeReply());
    assert.equal(result.places.length, 1);
    assert.match(capturedSql, /p\.brand_key = ANY\(\$5::text\[\]\)/);
    assert.deepEqual(capturedValues[3], ['%lidl%', '%super-u%']);
    assert.deepEqual(capturedValues[4], ['lidl', 'super-u']);
  } finally {
    globalThis.fetch = priorFetch;
  }
});

test('POST /api/offers requires the private administrator token', async () => {
  const prior = process.env.PLACES_ADMIN_TOKEN;
  delete process.env.PLACES_ADMIN_TOKEN;
  try {
    const app = makeApp();
    registerPlaceRoutes(app, { query: async () => { throw new Error('database should not be called'); } });
    const reply = makeReply();
    await app.routes.get('POST /api/offers')({ body: {}, headers: {} }, reply);
    assert.equal(reply.statusCode, 401);
    assert.match(reply.payload.error, /administrateur/i);
  } finally {
    if (prior !== undefined) process.env.PLACES_ADMIN_TOKEN = prior;
  }
});

test('POST /api/offers rejects an impossible date before writing to the database', async () => {
  const prior = process.env.PLACES_ADMIN_TOKEN;
  process.env.PLACES_ADMIN_TOKEN = 'test-only-admin-token';
  try {
    const app = makeApp();
    let queryCount = 0;
    registerPlaceRoutes(app, { query: async () => { queryCount += 1; return { rows: [] }; } });
    const reply = makeReply();
    await app.routes.get('POST /api/offers')({
      headers: { 'x-admin-token': 'test-only-admin-token' },
      body: {
        sourceId: 'official-test',
        externalId: 'official-test:offer-1',
        title: 'Promotion vérifiée',
        sourceUrl: 'https://example.com/offre',
        scope: 'brand',
        offerType: 'promotion',
        brandKey: 'example',
        validUntil: '2026-02-31',
      },
    }, reply);

    assert.equal(reply.statusCode, 400);
    assert.match(reply.payload.error, /YYYY-MM-DD/);
    assert.equal(queryCount, 0);
  } finally {
    if (prior === undefined) delete process.env.PLACES_ADMIN_TOKEN;
    else process.env.PLACES_ADMIN_TOKEN = prior;
  }
});

test('POST /api/offers stores date-only values and requires a valid end date to activate', async () => {
  const prior = process.env.PLACES_ADMIN_TOKEN;
  process.env.PLACES_ADMIN_TOKEN = 'test-only-admin-token';
  try {
    const app = makeApp();
    let capturedValues;
    registerPlaceRoutes(app, {
      query: async (_sql, values) => {
        capturedValues = values;
        return { rows: [{ id: 4, title: 'Promotion vérifiée', status: 'active' }] };
      },
    });

    const request = {
      headers: { 'x-admin-token': 'test-only-admin-token' },
      body: {
        sourceId: 'official-test',
        externalId: 'official-test:offer-1',
        title: 'Promotion vérifiée',
        sourceUrl: 'https://example.com/offre',
        scope: 'brand',
        offerType: 'promotion',
        brandKey: 'example',
        validFrom: getDateInTimeZone(),
        validUntil: getDateInTimeZone(),
        status: 'active',
        verifiedAt: '2026-11-14T10:00:00.000Z',
      },
    };
    const reply = makeReply();
    await app.routes.get('POST /api/offers')(request, reply);

    assert.equal(reply.statusCode, 201);
    assert.equal(capturedValues[14], getDateInTimeZone());
    assert.equal(capturedValues[15], getDateInTimeZone());
    assert.equal(capturedValues[16], 'active');
    assert.equal(capturedValues[1], 'official-test:offer-1');

    const withoutExternalId = makeReply();
    await app.routes.get('POST /api/offers')({
      ...request,
      body: { ...request.body, externalId: '' },
    }, withoutExternalId);
    assert.equal(withoutExternalId.statusCode, 400);
    assert.match(withoutExternalId.payload.error, /externalId/);

    const noEndDate = makeReply();
    await app.routes.get('POST /api/offers')({
      ...request,
      body: { ...request.body, validUntil: null },
    }, noEndDate);
    assert.equal(noEndDate.statusCode, 400);
    assert.match(noEndDate.payload.error, /validUntil/);
  } finally {
    if (prior === undefined) delete process.env.PLACES_ADMIN_TOKEN;
    else process.env.PLACES_ADMIN_TOKEN = prior;
  }
});


test('POST /api/offers rejects a placeId on brand and online scopes', async () => {
  const prior = process.env.PLACES_ADMIN_TOKEN;
  process.env.PLACES_ADMIN_TOKEN = 'test-only-admin-token';
  try {
    const app = makeApp();
    let queryCount = 0;
    registerPlaceRoutes(app, { query: async () => { queryCount += 1; return { rows: [] }; } });
    for (const scope of ['brand', 'online']) {
      const reply = makeReply();
      await app.routes.get('POST /api/offers')({
        headers: { 'x-admin-token': 'test-only-admin-token' },
        body: {
          sourceId: 'official-test', externalId: `official-test:${scope}-place-id`,
          title: 'Offre test', sourceUrl: 'https://example.com/offre',
          scope, offerType: 'promotion', brandKey: 'example', placeId: 42,
        },
      }, reply);
      assert.equal(reply.statusCode, 400);
      assert.match(reply.payload.error, /ne doit pas être liée à un magasin/i);
    }
    assert.equal(queryCount, 0);
  } finally {
    if (prior === undefined) delete process.env.PLACES_ADMIN_TOKEN;
    else process.env.PLACES_ADMIN_TOKEN = prior;
  }
});
