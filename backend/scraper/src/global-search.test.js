import test from 'node:test';
import assert from 'node:assert/strict';
import { registerGlobalSearchRoutes } from './global-search.js';

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
  };
}

function makeReply() {
  return {
    statusCode: 200,
    payload: undefined,
    code(code) {
      this.statusCode = code;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

test('Recherche globale fonctionne sans coordonnées GPS', async () => {
  const app = makeApp();
  let capturedSql = '';
  let capturedValues = [];

  const pool = {
    query: async (sql, values) => {
      capturedSql = sql;
      capturedValues = values;
      return {
        rows: [{
          places: [{ id: 'osm-N-123', name: 'Sephora' }],
          total: '1',
        }],
      };
    },
  };

  registerGlobalSearchRoutes(app, pool);

  const result = await app.routes.get('GET /api/search/places')({
    query: { q: 'Sephora', mode: 'global', limit: '12' },
  }, makeReply());

  assert.equal(result.mode, 'global');
  assert.equal(result.total, 1);
  assert.equal(result.places[0].name, 'Sephora');
  assert.match(capturedSql, /public\.osm_places/);
  assert.match(capturedSql, /public\.places/);
  assert.doesNotMatch(capturedSql, /COALESCE\(\s*p\.location/);
  assert.match(capturedSql, /ST_SetSRID\(ST_MakePoint\(p\.lon,p\.lat\),4326\)::geography/);
  assert.doesNotMatch(capturedSql, /ST_DWithin/);
  assert.ok(capturedValues.includes('Sephora'));
});

test('Recherche de proximité exige des coordonnées valides', async () => {
  const app = makeApp();
  registerGlobalSearchRoutes(app, {
    query: async () => {
      throw new Error('La base ne doit pas être appelée');
    },
  });

  const reply = makeReply();

  await app.routes.get('GET /api/search/places')({
    query: { q: 'pharmacie', mode: 'nearby', lat: '48.85' },
  }, reply);

  assert.equal(reply.statusCode, 400);
});

test('Recherche de proximité applique réellement le rayon PostGIS', async () => {
  const app = makeApp();
  let capturedSql = '';
  let capturedValues = [];

  const pool = {
    query: async (sql, values) => {
      capturedSql = sql;
      capturedValues = values;
      return {
        rows: [{ places: [], total: '0' }],
      };
    },
  };

  registerGlobalSearchRoutes(app, pool);

  const result = await app.routes.get('GET /api/search/places')({
    query: {
      q: 'pharmacie',
      mode: 'nearby',
      lat: '48.85',
      lon: '2.35',
      radiusM: '3000',
    },
  }, makeReply());

  assert.equal(result.mode, 'nearby');
  assert.match(capturedSql, /ST_DWithin/);
  assert.ok(capturedValues.includes(48.85));
  assert.ok(capturedValues.includes(2.35));
  assert.ok(capturedValues.includes(3000));
});

test('Recherche mondiale refuse un mode inconnu', async () => {
  const app = makeApp();
  registerGlobalSearchRoutes(app, {
    query: async () => {
      throw new Error('La base ne doit pas être appelée');
    },
  });

  const reply = makeReply();

  await app.routes.get('GET /api/search/places')({
    query: { mode: 'inconnu' },
  }, reply);

  assert.equal(reply.statusCode, 400);
  assert.match(reply.payload.error, /Mode invalide/);
});
