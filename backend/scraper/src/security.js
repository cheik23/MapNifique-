import { timingSafeEqual } from 'node:crypto';

const ADMIN_WRITE_ROUTES = new Set([
  '/api/sources',
  '/api/crawls',
  '/api/offers',
]);
const ADMIN_READ_ROUTES = new Set([
  '/api/crawls/:id',
]);

function routePath(request) {
  const configuredRoute = request.routeOptions?.url;
  if (typeof configuredRoute === 'string') return configuredRoute;

  const rawUrl = String(request.url || '/');
  const queryIndex = rawUrl.indexOf('?');
  return (queryIndex >= 0 ? rawUrl.slice(0, queryIndex) : rawUrl) || '/';
}

export function isValidAdminToken(expectedValue, suppliedValue) {
  const expected = Buffer.from(String(expectedValue || ''));
  const supplied = Buffer.from(String(suppliedValue || ''));

  return expected.length > 0
    && expected.length === supplied.length
    && timingSafeEqual(expected, supplied);
}

export function safeRequestLogSerializer(request) {
  return {
    method: String(request.method || 'UNKNOWN'),
    url: routePath(request).slice(0, 512),
  };
}

export function createRequestRateLimiter({
  now = Date.now,
  windowMs = 60_000,
  publicLimit = 180,
  searchLimit = 90,
  adminLimit = 30,
  maxClients = 5_000,
} = {}) {
  const buckets = new Map();
  const safeWindowMs = Number.isSafeInteger(windowMs) && windowMs > 0
    ? windowMs
    : 60_000;
  const safeMaxClients = Number.isSafeInteger(maxClients) && maxClients > 0
    ? maxClients
    : 5_000;

  const safeLimit = (limit, fallback) =>
    Number.isSafeInteger(limit) && limit > 0 ? limit : fallback;

  const rateLimitRequest = async function rateLimitRequest(request, reply) {
    const method = String(request.method || 'GET').toUpperCase();
    const path = routePath(request);
    const isAdminWrite = method === 'POST' && ADMIN_WRITE_ROUTES.has(path);
    const isAdminRead = method === 'GET' && ADMIN_READ_ROUTES.has(path);
    const isSearch = path === '/api/discover'
      || path === '/api/route'
      || path.startsWith('/api/search/');
    const group = isAdminWrite || isAdminRead ? 'admin' : isSearch ? 'search' : 'public';
    const limit = isAdminWrite || isAdminRead
      ? safeLimit(adminLimit, 30)
      : isSearch
        ? safeLimit(searchLimit, 90)
        : safeLimit(publicLimit, 180);
    const client = String(
      request.ip || request.socket?.remoteAddress || 'unknown',
    ).slice(0, 128);
    const key = `${client}\u0000${group}`;
    const timestamp = now();
    let bucket = buckets.get(key);

    if (!bucket || timestamp - bucket.startedAt >= safeWindowMs) {
      if (bucket) buckets.delete(key);

      if (buckets.size >= safeMaxClients) {
        for (const [oldKey, oldBucket] of buckets) {
          if (timestamp - oldBucket.startedAt >= safeWindowMs) {
            buckets.delete(oldKey);
          }
        }
        while (buckets.size >= safeMaxClients) {
          const oldestKey = buckets.keys().next().value;
          if (oldestKey === undefined) break;
          buckets.delete(oldestKey);
        }
      }

      bucket = { startedAt: timestamp, count: 0 };
    }

    bucket.count += 1;
    buckets.delete(key);
    buckets.set(key, bucket);

    const resetAt = Math.ceil((bucket.startedAt + safeWindowMs) / 1000);
    const remaining = Math.max(0, limit - bucket.count);
    reply.header('RateLimit-Limit', String(limit));
    reply.header('RateLimit-Remaining', String(remaining));
    reply.header('RateLimit-Reset', String(resetAt));

    if (bucket.count <= limit) return;

    const retryAfter = Math.max(
      1,
      Math.ceil((bucket.startedAt + safeWindowMs - timestamp) / 1000),
    );
    reply.header('Retry-After', String(retryAfter));
    return reply.code(429).send({ error: 'Trop de requêtes. Réessaie dans un instant.' });
  };

  Object.defineProperty(rateLimitRequest, 'bucketCount', {
    get: () => buckets.size,
  });

  return rateLimitRequest;
}
