import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL ||= 'postgresql://test:test@127.0.0.1:5432/mapnifique_test';
const { buildApp } = await import('./app.js');

const testConfig = {
  trustedProxyIps: [],
  rateLimits: { windowMs: 60_000, publicLimit: 20, searchLimit: 10, adminLimit: 5, maxClients: 100 },
  corsOrigins: ['https://mapnifique.pages.dev'],
  defaultMaxPages: 100,
  hardMaxPages: 2000,
};

function fakePool() {
  return {
    async query(sql) {
      if (String(sql).includes('schema_state')) return { rows: [{ version: 2 }], rowCount: 1 };
      if (String(sql).includes('NOW() AS database_time')) return { rows: [{ database_time: '2026-11-21T00:00:00.000Z' }], rowCount: 1 };
      if (String(sql).includes('FROM sources ORDER BY name')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
  };
}

test('buildApp exposes health through Fastify inject without opening a listening socket', async () => {
  const app = await buildApp({ databasePool: fakePool(), runtimeConfig: testConfig, adminToken: 'test-admin-token', logger: false });
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'ok');
    assert.equal(response.json().schema.version, 2);
  } finally {
    await app.close();
  }
});

test('buildApp exposes nearby-coordinate validation and the Pages CORS origin', async () => {
  const app = await buildApp({ databasePool: fakePool(), runtimeConfig: testConfig, adminToken: 'test-admin-token', logger: false });
  try {
    const invalid = await app.inject({ method: 'GET', url: '/api/places?lat=91&lon=0', headers: { origin: 'https://mapnifique.pages.dev' } });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.headers['access-control-allow-origin'], 'https://mapnifique.pages.dev');
  } finally {
    await app.close();
  }
});
