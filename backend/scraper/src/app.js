import Fastify from 'fastify';
import cors from '@fastify/cors';
import {
  REQUIRED_SCHEMA_VERSION,
  getSchemaVersion,
  pool as defaultPool,
} from './db.js';
import { config } from './config.js';
import { toPublicSource, upsertSource } from './source-admin.js';
import { isSameOrigin } from './url-policy.js';
import { parseBoundedInteger } from './numeric.js';
import { resolveBlockedCandidate } from './stage.js';
import { registerPlaceRoutes } from './places-api.js';
import { createHealthHandler } from './health.js';
import {
  createRequestRateLimiter,
  isValidAdminToken,
  safeRequestLogSerializer,
} from './security.js';

export async function buildApp({ databasePool = defaultPool, runtimeConfig = config, adminToken = process.env.PLACES_ADMIN_TOKEN, logger = true } = {}) {
    const pool = databasePool;
    const config = runtimeConfig;
    const app = Fastify({
      logger: logger ? { serializers: { req: safeRequestLogSerializer } } : false,
      trustProxy: config.trustedProxyIps.length ? config.trustedProxyIps : false,
      bodyLimit: 1_000_000,
    });
    await app.register(cors, {
      origin: (origin, callback) => {
        if (!origin || config.corsOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Origine CORS non autorisée.'), false);
      },
    });
    app.addHook('onRequest', createRequestRateLimiter(config.rateLimits));

  function requireAdmin(request, reply) {
    if (!isValidAdminToken(adminToken, request.headers['x-admin-token'])) {
      reply.code(401).send({
        error: 'Authentification administrateur requise.',
      });
      return false;
    }

    return true;
  }

  function validateUrls(urls, baseUrl) {
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 20) throw new Error('Fournis entre 1 et 20 URL de départ.');
    return [...new Set(urls.map((value) => {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Protocole URL non autorisé.');
      if (url.username || url.password) throw new Error('Les URL avec identifiants intégrés sont refusées.');
      if (!isSameOrigin(url.toString(), baseUrl.toString())) throw new Error('Toutes les URL doivent appartenir à la même origine (protocole, hôte et port) que l’enseigne enregistrée.');
      return url.toString();
    }))];
  }

  app.get('/health', createHealthHandler({ pool, getSchemaVersion: () => getSchemaVersion(pool), requiredSchemaVersion: REQUIRED_SCHEMA_VERSION }));

  app.get('/api/sources', async () => {
    const result = await pool.query(`
      SELECT id, name, base_url AS "baseUrl", product_url_regex AS "productUrlRegex",
             enabled, license_approved AS "licenseApproved",
             license_reviewed_at AS "licenseReviewedAt",
             requests_per_minute AS "requestsPerMinute",
             same_domain_delay_secs AS "sameDomainDelaySecs",
             max_pages_per_run AS "maxPagesPerRun", created_at AS "createdAt"
        FROM sources ORDER BY name
    `);
    return { sources: result.rows.map(toPublicSource) };
  });

  app.post('/api/sources', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const source = await upsertSource(pool, request.body || {}, config);
      return reply.code(201).send({ source });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post('/api/crawls', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    try {
      const body = request.body || {};
      const sourceId = String(body.sourceId || '').trim();
      const result = await pool.query(`SELECT * FROM sources WHERE id=$1 AND enabled=TRUE AND license_approved=TRUE AND license_reviewed_at IS NOT NULL AND BTRIM(license_review_note) <> ''`, [sourceId]);
      const source = result.rows[0];
      if (!source) throw new Error('Enseigne inconnue ou désactivée. Crée d’abord la source.');
      const urls = validateUrls(body.urls, new URL(source.base_url));
      const requestedMaxPages = parseBoundedInteger(body.maxPages, {
        fallback: config.defaultMaxPages, min: 1, max: config.hardMaxPages, label: 'maxPages',
      });
      const sourceMaxPages = parseBoundedInteger(source.max_pages_per_run, {
        fallback: config.defaultMaxPages, min: 1, max: config.hardMaxPages, label: 'max_pages_per_run',
      });
      const maxPages = Math.min(requestedMaxPages, sourceMaxPages, config.hardMaxPages);
      const job = await pool.query(`
        INSERT INTO scrape_jobs (source_id,start_urls,max_pages) VALUES ($1,$2::jsonb,$3)
        RETURNING id,status,created_at AS "createdAt"
      `, [sourceId, JSON.stringify(urls), maxPages]);
      return reply.code(202).send({ job: job.rows[0], message: 'Collecte mise en file. Le worker la traitera en arrière-plan.' });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.post('/api/crawls/:jobId/candidates/:candidateId/resolve', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const jobId = Number(request.params.jobId);
    const candidateId = Number(request.params.candidateId);
    const anomalyId = Number(request.body?.anomalyId);
    if (![jobId, candidateId, anomalyId].every((value) => Number.isSafeInteger(value) && value > 0)) {
      return reply.code(400).send({ error: 'Identifiants de job, candidat ou anomalie invalides.' });
    }
    try {
      const result = await resolveBlockedCandidate({
        pool,
        jobId,
        candidateId,
        anomalyId,
        adminReview: true,
        resolution: {
          action: request.body?.action,
          reviewer: request.body?.reviewer,
          note: request.body?.note,
        },
      });
      return reply.code(200).send({ resolution: result });
    } catch (error) {
      const statusCode = error instanceof TypeError ? 400 : (['MN002', 'MN003'].includes(error.code) ? 409 : 422);
      return reply.code(statusCode).send({ error: error.message, code: error.code || 'RESOLUTION_FAILED' });
    }
  });

  app.get('/api/crawls/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return;
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: 'Identifiant invalide.' });
    const result = await pool.query(`
      SELECT id,source_id AS "sourceId",status,pages_seen AS "pagesSeen",
             products_found AS "productsFound",skipped_by_robots AS "skippedByRobots",
             attempts,error,created_at AS "createdAt",started_at AS "startedAt",finished_at AS "finishedAt"
        FROM scrape_jobs WHERE id=$1
    `, [id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'Collecte introuvable.' });
    return { job: result.rows[0] };
  });

  app.get('/api/products', async (request, reply) => {
    let limit;
    let offset;
    try {
      limit = parseBoundedInteger(request.query.limit, { fallback: 25, min: 1, max: 100, label: 'limit' });
      offset = parseBoundedInteger(request.query.offset, { fallback: 0, min: 0, max: 100_000, label: 'offset' });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
    const query = String(request.query.q || '').trim().slice(0, 120);
    const sourceId = request.query.sourceId ? String(request.query.sourceId).slice(0, 50) : null;
    const result = await pool.query(`
      SELECT p.id, p.source_id AS "sourceId", s.name AS retailer,
             p.product_url AS url, p.discovered_from AS "discoveredFrom",
             p.gtin, p.name, p.brand, p.category, p.image_url AS "imageUrl",
             p.identity_key AS "identityKey", p.last_seen_at AS "lastSeenAt",
             latest.price, latest.regular_price AS "regularPrice", latest.currency, latest.promotion,
             latest.availability, latest.price_scope AS "priceScope", latest.store_code AS "storeCode",
             latest.observed_at AS "priceObservedAt",
             COALESCE(identifiers.items, '[]'::jsonb) AS identifiers
        FROM products p
        JOIN sources s ON s.id=p.source_id
        LEFT JOIN LATERAL (
          SELECT price,regular_price,currency,promotion,availability,price_scope,store_code,observed_at
            FROM price_observations WHERE product_id=p.id ORDER BY observed_at DESC LIMIT 1
        ) latest ON TRUE
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object(
                   'namespace', pi.namespace, 'value', pi.value, 'kind', pi.kind
                 ) ORDER BY pi.namespace, pi.value) AS items
            FROM product_identifiers pi WHERE pi.product_id=p.id
        ) identifiers ON TRUE
       WHERE ($1::text IS NULL OR p.source_id=$1)
         AND ($2='' OR p.name ILIKE '%' || $2 || '%'
              OR COALESCE(p.brand,'') ILIKE '%' || $2 || '%'
              OR EXISTS (
                SELECT 1 FROM product_identifiers pi
                 WHERE pi.product_id=p.id AND pi.value=$2
              ))
       ORDER BY p.last_seen_at DESC LIMIT $3 OFFSET $4
    `, [sourceId, query, limit, offset]);
    return { products: result.rows, limit, offset };
  });

  app.get('/api/products/:id/prices', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: 'Identifiant invalide.' });
    const result = await pool.query(`
      SELECT o.store_code AS "storeCode", o.price, o.regular_price AS "regularPrice", o.currency,
             o.promotion, o.availability, o.price_scope AS "priceScope",
             o.source_url AS "sourceUrl", o.observed_at AS "observedAt",
             COALESCE(
               jsonb_agg(DISTINCT jsonb_build_object(
                 'discoveredFrom', src.discovered_from,
                 'discoveredUrl', src.discovered_url,
                 'method', src.method,
                 'evidence', src.evidence
               )) FILTER (WHERE src.observation_id IS NOT NULL),
               '[]'::jsonb
             ) AS sources
        FROM price_observations o
        LEFT JOIN price_observation_sources src ON src.observation_id=o.id
       WHERE o.product_id=$1
       GROUP BY o.id
       ORDER BY o.observed_at DESC LIMIT 1000
    `, [id]);
    return { observations: result.rows };
  });

  registerPlaceRoutes(app, pool);
  await app.ready();
  return app;
}
