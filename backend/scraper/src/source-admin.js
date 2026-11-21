import { isIP } from 'node:net';
import { parseBoundedInteger } from './numeric.js';

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('L’URL doit commencer par http:// ou https://.');
  }
  if (url.username || url.password) {
    throw new Error('Les URL avec identifiants intégrés sont refusées.');
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(hostname) !== 0
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
    || hostname === 'metadata.google.internal') {
    throw new Error('Un nom DNS public d’enseigne est requis ; les IP et domaines internes sont refusés.');
  }
  if (url.port) {
    throw new Error('Les ports personnalisés sont refusés pour une source de collecte.');
  }
  return url;
}

export function normalizeSourceInput(body, config) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const id = String(input.id || '').trim().toLowerCase();
  const name = String(input.name || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(id)) {
    throw new Error('ID invalide : 2 à 49 caractères minuscules, chiffres ou tirets.');
  }
  if (!name || name.length > 100) {
    throw new Error('Nom d’enseigne obligatoire (100 caractères maximum).');
  }

  const base = normalizeBaseUrl(input.baseUrl);
  const requestsPerMinute = parseBoundedInteger(input.requestsPerMinute, {
    fallback: config.defaultRequestsPerMinute, min: 1, max: 120,
    label: 'requestsPerMinute',
  });
  const sameDomainDelaySecs = parseBoundedInteger(input.sameDomainDelaySecs, {
    fallback: config.defaultSameDomainDelaySecs, min: 1, max: 60,
    label: 'sameDomainDelaySecs',
  });
  const maxPagesPerRun = parseBoundedInteger(input.maxPagesPerRun, {
    fallback: Math.min(config.defaultMaxPages, config.hardMaxPages),
    min: 1, max: config.hardMaxPages,
    label: 'maxPagesPerRun',
  });
  const selectors = input.selectors && typeof input.selectors === 'object' && !Array.isArray(input.selectors)
    ? input.selectors
    : {};
  if (JSON.stringify(selectors).length > 10000) {
    throw new Error('La configuration des sélecteurs est trop volumineuse.');
  }

  const enabled = input.enabled === true;
  const licenseApproved = input.licenseApproved === true;
  const licenseReviewNote = String(input.licenseReviewNote || '').trim().slice(0, 1000);
  if (licenseApproved && !licenseReviewNote) {
    throw new Error('Une note documentant la revue de licence est obligatoire pour approuver une source.');
  }
  if (enabled && (!licenseApproved || !licenseReviewNote)) {
    throw new Error('Activation refusée : la revue de licence doit être explicitement approuvée et documentée.');
  }

  return {
    id,
    name,
    baseUrl: base.origin,
    productUrlRegex: input.productUrlRegex ? String(input.productUrlRegex).slice(0, 300) : null,
    selectors,
    requestsPerMinute,
    sameDomainDelaySecs,
    maxPagesPerRun,
    enabled,
    licenseApproved,
    licenseReviewNote: licenseApproved ? licenseReviewNote : null,
  };
}

export async function upsertSource(db, body, config) {
  if (!db || typeof db.query !== 'function') throw new TypeError('db.query requis');
  const source = normalizeSourceInput(body, config);
  const result = await db.query(`
    INSERT INTO sources (
      id,name,base_url,product_url_regex,selectors,requests_per_minute,
      same_domain_delay_secs,max_pages_per_run,enabled,license_approved,
      license_reviewed_at,license_review_note,updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,
      CASE WHEN $10 THEN NOW() ELSE NULL END,$11,NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      base_url=EXCLUDED.base_url,
      product_url_regex=EXCLUDED.product_url_regex,
      selectors=EXCLUDED.selectors,
      requests_per_minute=EXCLUDED.requests_per_minute,
      same_domain_delay_secs=EXCLUDED.same_domain_delay_secs,
      max_pages_per_run=EXCLUDED.max_pages_per_run,
      enabled=EXCLUDED.enabled,
      license_approved=EXCLUDED.license_approved,
      license_reviewed_at=EXCLUDED.license_reviewed_at,
      license_review_note=EXCLUDED.license_review_note,
      updated_at=NOW()
    RETURNING id,name,base_url AS "baseUrl",enabled,
              license_approved AS "licenseApproved",
              license_reviewed_at AS "licenseReviewedAt",
              license_review_note AS "licenseReviewNote"
  `, [
    source.id,
    source.name,
    source.baseUrl,
    source.productUrlRegex,
    JSON.stringify(source.selectors),
    source.requestsPerMinute,
    source.sameDomainDelaySecs,
    source.maxPagesPerRun,
    source.enabled,
    source.licenseApproved,
    source.licenseReviewNote,
  ]);

  if (!result.rows?.[0]) throw new Error('La source n’a pas été enregistrée.');
  return result.rows[0];
}




/** Public projection: internal license review notes never leave the admin boundary. */
export function toPublicSource(row) {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.baseUrl ?? row.base_url,
    productUrlRegex: row.productUrlRegex ?? row.product_url_regex ?? null,
    enabled: row.enabled === true,
    licenseApproved: row.licenseApproved ?? row.license_approved ?? false,
    licenseReviewedAt: row.licenseReviewedAt ?? row.license_reviewed_at ?? null,
    requestsPerMinute: row.requestsPerMinute ?? row.requests_per_minute,
    sameDomainDelaySecs: row.sameDomainDelaySecs ?? row.same_domain_delay_secs,
    maxPagesPerRun: row.maxPagesPerRun ?? row.max_pages_per_run,
    createdAt: row.createdAt ?? row.created_at,
  };
}
