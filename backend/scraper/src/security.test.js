import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {
  createRequestRateLimiter,
  isValidAdminToken,
  safeRequestLogSerializer,
} from './security.js';

function makeReply() {
  return {
    headers: {},
    statusCode: 200,
    payload: undefined,
    header(name, value) {
      this.headers[name] = value;
      return this;
    },
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return payload;
    },
  };
}

test('admin token validation requires a configured exact token', () => {
  assert.equal(isValidAdminToken('', 'guess'), false);
  assert.equal(isValidAdminToken('configured-token', ''), false);
  assert.equal(isValidAdminToken('configured-token', 'configured-toke'), false);
  assert.equal(isValidAdminToken('configured-token', 'different-token'), false);
  assert.equal(isValidAdminToken('configured-token', 'configured-token'), true);
});

test('request log serializer removes coordinates and request headers', () => {
  const serialized = safeRequestLogSerializer({
    method: 'GET',
    url: '/api/discover?lat=48.85&lon=2.35&radiusM=1000',
    headers: { authorization: 'should-not-be-logged' },
    ip: '203.0.113.1',
  });

  assert.deepEqual(serialized, { method: 'GET', url: '/api/discover' });
});

test('request log serializer prefers the route template over raw query data', () => {
  const serialized = safeRequestLogSerializer({
    method: 'GET',
    url: '/api/places/42?lat=48.85&lon=2.35',
    routeOptions: { url: '/api/places/:id' },
  });

  assert.deepEqual(serialized, { method: 'GET', url: '/api/places/:id' });
});

test('rate limiter allows the configured count and then returns 429', async () => {
  let timestamp = 1_000_000;
  const limiter = createRequestRateLimiter({
    now: () => timestamp,
    windowMs: 10_000,
    publicLimit: 2,
  });
  const request = {
    method: 'GET',
    url: '/api/places?lat=48.85&lon=2.35',
    ip: '203.0.113.10',
  };

  const first = makeReply();
  const second = makeReply();
  const third = makeReply();
  await limiter(request, first);
  await limiter(request, second);
  await limiter(request, third);

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(third.statusCode, 429);
  assert.equal(third.headers['Retry-After'], '10');
  assert.equal(third.payload.error, 'Trop de requêtes. Réessaie dans un instant.');

  timestamp += 10_000;
  const afterReset = makeReply();
  await limiter(request, afterReset);
  assert.equal(afterReset.statusCode, 200);
});

test('search and admin endpoints use their own stricter buckets', async () => {
  const limiter = createRequestRateLimiter({
    now: () => 20_000,
    windowMs: 60_000,
    publicLimit: 5,
    searchLimit: 1,
    adminLimit: 1,
  });
  const makeRequest = (method, url, routeUrl, ip = '203.0.113.11') => ({
    method,
    url,
    routeOptions: routeUrl ? { url: routeUrl } : undefined,
    ip,
  });

  const searchFirst = makeReply();
  const searchSecond = makeReply();
  await limiter(makeRequest('GET', '/api/search/intelligent?q=Sephora'), searchFirst);
  await limiter(makeRequest('GET', '/api/search/intelligent?q=Lidl'), searchSecond);
  assert.equal(searchSecond.statusCode, 429);

  const adminFirst = makeReply();
  const adminSecond = makeReply();
  await limiter(makeRequest('POST', '/api/offers'), adminFirst);
  await limiter(makeRequest('POST', '/api/offers'), adminSecond);
  assert.equal(adminSecond.statusCode, 429);
  assert.equal(adminSecond.headers['RateLimit-Limit'], '1');

  const crawlStatusFirst = makeReply();
  const crawlStatusSecond = makeReply();
  await limiter(makeRequest('GET', '/api/crawls/123', '/api/crawls/:id', '203.0.113.12'), crawlStatusFirst);
  await limiter(makeRequest('GET', '/api/crawls/124', '/api/crawls/:id', '203.0.113.12'), crawlStatusSecond);
  assert.equal(crawlStatusFirst.statusCode, 200);
  assert.equal(crawlStatusSecond.statusCode, 429);
  assert.equal(crawlStatusSecond.headers['RateLimit-Limit'], '1');

  const publicRequest = makeReply();
  await limiter(makeRequest('GET', '/api/products'), publicRequest);
  assert.equal(publicRequest.statusCode, 200);
  assert.equal(publicRequest.headers['RateLimit-Limit'], '5');
});

test('rate limiter keeps client state bounded', async () => {
  const limiter = createRequestRateLimiter({
    now: () => 30_000,
    maxClients: 2,
  });

  for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
    await limiter({ method: 'GET', url: '/health', ip }, makeReply());
  }

  assert.equal(limiter.bucketCount, 2);
});

test('Fastify stops route execution after the rate limit response', async () => {
  const app = Fastify();
  let routeCalls = 0;
  app.addHook('onRequest', createRequestRateLimiter({ publicLimit: 1 }));
  app.get('/public', async () => {
    routeCalls += 1;
    return { ok: true };
  });

  try {
    const first = await app.inject({ method: 'GET', url: '/public' });
    const second = await app.inject({ method: 'GET', url: '/public' });

    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 429);
    assert.equal(routeCalls, 1);
  } finally {
    await app.close();
  }
});
