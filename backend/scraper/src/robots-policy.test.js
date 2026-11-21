import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchRespectingRobots, isRobotsAllowed, parseRobotsTxt } from './robots-policy.js';

test('robots.txt applique le groupe spécifique et Allow gagne à longueur égale', () => {
  const wildcard = parseRobotsTxt(`
User-agent: *
Disallow: /private
Disallow: /catalog/
Allow: /catalog/public
`);
  assert.equal(isRobotsAllowed(wildcard, 'https://shop.example/private'), false);
  assert.equal(isRobotsAllowed(wildcard, 'https://shop.example/catalog/item'), false);
  assert.equal(isRobotsAllowed(wildcard, 'https://shop.example/catalog/public/item'), true);

  const specific = parseRobotsTxt(`
User-agent: *
Disallow: /private

User-agent: MapNifique
Disallow: /catalog/
Allow: /catalog/public
Disallow: /catalog/public/blocked
Allow: /catalog/public/blocked/item$
`);
  // Un groupe dédié à MapNifique remplace le groupe générique.
  assert.equal(isRobotsAllowed(specific, 'https://shop.example/private'), true);
  assert.equal(isRobotsAllowed(specific, 'https://shop.example/catalog/item'), false);
  assert.equal(isRobotsAllowed(specific, 'https://shop.example/catalog/public/item'), true);
  assert.equal(isRobotsAllowed(specific, 'https://shop.example/catalog/public/blocked/item'), true);
  assert.equal(isRobotsAllowed(specific, 'https://shop.example/catalog/public/blocked/other'), false);
});

test('robots.txt respecte les jokers et les règles spécifiques à MapNifique', () => {
  const policy = parseRobotsTxt(`
User-agent: *
Disallow: /tmp*

User-agent: MapNifique
Allow: /tmp/public$
`);
  assert.equal(isRobotsAllowed(policy, 'https://shop.example/tmp/file'), true);
  assert.equal(isRobotsAllowed(policy, 'https://shop.example/tmp/public'), true);
});

test('robots.txt sans règle correspondante autorise les URL non interdites', () => {
  const policy = parseRobotsTxt('User-agent: Googlebot\nDisallow: /');
  assert.equal(isRobotsAllowed(policy, 'https://shop.example/product/1'), true);
});

test('fetchRespectingRobots bloque par défaut un robots.txt absent ou illisible', async () => {
  let pageFetched = false;
  const fakeFetch = async (url) => url.endsWith('/robots.txt')
    ? { ok: false, status: 404, body: { cancel: async () => {} } }
    : (pageFetched = true, { ok: true });
  await assert.rejects(
    fetchRespectingRobots('https://shop.example/product/1', {}, { fetchImpl: fakeFetch, cache: new Map() }),
    /HTTP 404.*collecte bloquée par défaut/i,
  );
  assert.equal(pageFetched, false);
});

test('fetchRespectingRobots ne télécharge jamais une URL interdite', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) return { ok: true, status: 200, text: async () => 'User-agent: *\nDisallow: /private' };
    return { ok: true, status: 200 };
  };
  await assert.rejects(
    fetchRespectingRobots('https://shop.example/private/offer', {}, { fetchImpl: fakeFetch, cache: new Map() }),
    /Robots.txt interdit/i,
  );
  assert.deepEqual(calls, ['https://shop.example/robots.txt']);
});

test('fetchRespectingRobots applique un crawl-delay', async () => {
  const waits = [];
  const fakeFetch = async (url) => url.endsWith('/robots.txt')
    ? { ok: true, status: 200, text: async () => 'User-agent: *\nCrawl-delay: 2' }
    : { ok: true, status: 200 };
  await fetchRespectingRobots('https://shop.example/product', {}, {
    fetchImpl: fakeFetch,
    cache: new Map(),
    minDelayMs: 0,
    sleepImpl: async (ms) => waits.push(ms),
  });
  assert.equal(waits.length, 1);
  // The timestamp is recorded before the awaited robots.txt response, so
  // event-loop scheduling can make the remaining wait a few milliseconds
  // shorter than exactly 2000 ms. Check the policy window, not a brittle
  // equality that flakes under a loaded test runner.
  assert.ok(waits[0] >= 1900 && waits[0] <= 2000, `crawl-delay expected <= 2000 ms and >= 1900 ms, got ${waits[0]}`);
});

test('fetchRespectingRobots vérifie robots.txt sur chaque hôte de redirection', async () => {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url === 'https://a.example/robots.txt' || url === 'https://b.example/robots.txt') {
      return { ok: true, status: 200, text: async () => 'User-agent: *\nAllow: /' };
    }
    if (url === 'https://a.example/start') {
      return { status: 302, headers: { get: () => 'https://b.example/final' }, body: { cancel: async () => {} } };
    }
    return { status: 200, ok: true };
  };
  const result = await fetchRespectingRobots('https://a.example/start', {}, {
    fetchImpl: fakeFetch,
    cache: new Map(),
    minDelayMs: 0,
  });
  assert.equal(result.status, 200);
  assert.ok(calls.includes('https://b.example/robots.txt'));
  assert.ok(calls.includes('https://b.example/final'));
});


test('robots.txt est mis en cache par origine entre plusieurs URL', async () => {
  const calls = [];
  const origin = 'https://robots-cache-shared.test';
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) {
      return { ok: true, status: 200, text: async () => 'User-agent: *\nAllow: /' };
    }
    return { ok: true, status: 200 };
  };
  await fetchRespectingRobots(`${origin}/one`, {}, { fetchImpl: fakeFetch, minDelayMs: 0 });
  await fetchRespectingRobots(`${origin}/two`, {}, { fetchImpl: fakeFetch, minDelayMs: 0 });
  assert.equal(calls.filter((url) => url.endsWith('/robots.txt')).length, 1);
  assert.ok(calls.includes(`${origin}/one`));
  assert.ok(calls.includes(`${origin}/two`));
});

test('les lectures robots concurrentes du même hôte sont mutualisées', async () => {
  const calls = [];
  const origin = 'https://robots-cache-concurrent.test';
  let releaseRobots;
  const robotsGate = new Promise((resolve) => { releaseRobots = resolve; });
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.endsWith('/robots.txt')) {
      await robotsGate;
      return { ok: true, status: 200, text: async () => 'User-agent: *\nAllow: /' };
    }
    return { ok: true, status: 200 };
  };
  const first = fetchRespectingRobots(`${origin}/one`, {}, { fetchImpl: fakeFetch, minDelayMs: 0 });
  const second = fetchRespectingRobots(`${origin}/two`, {}, { fetchImpl: fakeFetch, minDelayMs: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  releaseRobots();
  const results = await Promise.all([first, second]);
  assert.equal(results.length, 2);
  assert.equal(calls.filter((url) => url.endsWith('/robots.txt')).length, 1);
});
