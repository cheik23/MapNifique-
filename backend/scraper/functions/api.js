import { buildApp } from '../src/app.js';
import { assertPlacesSchemaReady } from '../src/places-api.js';
import { assertSchemaReady, pool } from '../src/db.js';

// Neon may evict idle PostgreSQL connections when a branch scales to zero.
// node-postgres emits an error for an idle client; handle it so it cannot crash
// the function isolate. Pool will discard the stale client and reconnect on demand.
pool.on('error', (error) => {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  console.error(`[neon-function:db] Idle PostgreSQL client dropped (${code}); pool will reconnect on demand.`);
});

// Neon may evict idle PostgreSQL connections when a branch scales to zero.
// node-postgres emits an error for an idle client; handle it so it cannot crash
// the function isolate. Pool will discard the stale client and reconnect on demand.
pool.on('error', (error) => {
  const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
  console.error(`[neon-function:db] Idle PostgreSQL client dropped (${code}); pool will reconnect on demand.`);
});

let appPromise;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      await assertSchemaReady(pool);
      await assertPlacesSchemaReady(pool);
      return buildApp({ logger: false });
    })().catch((error) => {
      appPromise = undefined;
      throw error;
    });
  }
  return appPromise;
}

function copyHeaders(source) {
  const headers = new Headers();
  const hopByHop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length']);
  for (const [name, value] of Object.entries(source || {})) {
    if (hopByHop.has(name.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, String(item));
    } else if (value !== undefined && value !== null) {
      headers.set(name, String(value));
    }
  }
  return headers;
}

export default {
  async fetch(request) {
    try {
      const app = await getApp();
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const payload = ['GET', 'HEAD', 'OPTIONS'].includes(method)
        ? undefined
        : Buffer.from(await request.arrayBuffer());

      const result = await app.inject({
        method,
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(request.headers.entries()),
        // Neon sits behind an ingress proxy. Use the right-most forwarded entry,
        // normally the address appended by that ingress, not a client-supplied left-most value.
        remoteAddress: request.headers.get('cf-connecting-ip')
          || request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim()
          || '127.0.0.1',
        payload,
      });

      return new Response(result.body, {
        status: result.statusCode,
        headers: copyHeaders(result.headers),
      });
    } catch (error) {
      console.error('[neon-function:api] Request failed:', error?.message || String(error));
      const headers = { 'Cache-Control': 'no-store' };
      const origin = request.headers.get('origin');
      if (origin === 'https://mapnifique.pages.dev') {
        headers['Access-Control-Allow-Origin'] = origin;
        headers.Vary = 'Origin';
      }
      return Response.json(
        { error: 'Service MapNifique temporairement indisponible.' },
        { status: 503, headers },
      );
    }
  },
};
