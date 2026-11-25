import {
  buildIdentity,
  identityKeyRank,
  mergeCandidates,
  mergeVariantDetails,
  normalizeName,
  priceFingerprint,
  sameIdentifier,
  variantSignature,
} from './identity.js';

export class LeaseLostError extends Error {
  constructor(message = 'Lease du job perdue : écriture refusée.') {
    super(message);
    this.name = 'LeaseLostError';
    this.code = 'MN002';
  }
}

export class BudgetExceededError extends Error {
  constructor(message = 'Budget de candidats dépassé pour ce job.') {
    super(message);
    this.name = 'BudgetExceededError';
    this.code = 'MN001';
  }
}

export class IdentityConflictError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'IdentityConflictError';
    this.code = 'MN003';
    this.detail = detail;
  }
}

const TERMINAL_CANDIDATE_STATUSES = new Set(['finalized', 'blocked']);

/**
 * Une seule connexion réservée pour toute l'unité de travail :
 * BEGIN → verrouillage → lecture → validation → écritures → COMMIT,
 * ROLLBACK sur erreur, release dans tous les cas.
 */
export async function withTransaction(pool, work) {
  const client = await pool.connect();
  let started = false;
  try {
    await client.query('BEGIN');
    started = true;
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (started) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Verrou de job tenu jusqu'au COMMIT : le lease ne peut pas être volé pendant l'écriture. */
export async function lockJob(client, jobId, leaseToken) {
  const { rows } = await client.query(
    `SELECT id, source_id, status, lease_token
       FROM scrape_jobs
      WHERE id=$1
      FOR UPDATE`,
    [jobId],
  );
  const job = rows[0];
  if (!job) throw new LeaseLostError(`Job ${jobId} introuvable.`);
  if (job.status !== 'running') throw new LeaseLostError(`Job ${jobId} n'est plus en cours (${job.status}).`);
  if (job.lease_token !== leaseToken) throw new LeaseLostError(`Lease du job ${jobId} perdue.`);
  return job;
}

/**
 * Construit un produit découvert prêt pour le staging : identité + une observation
 * commerciale + ses provenances. Aucune donnée n'est inventée.
 */
export function buildDiscoveredProduct(extracted, {
  sourceId,
  stripParams,
  keepParams,
  defaultCurrency = null,
  observedAt = new Date(),
} = {}) {
  const identity = buildIdentity(extracted, {
    sourceId,
    discoveredFrom: extracted.discoveredFrom,
    stripParams,
    keepParams,
  });

  const day = observedAt.toISOString().slice(0, 10);
  const extractedSources = Array.isArray(extracted.extractionSources) && extracted.extractionSources.length
    ? extracted.extractionSources
    : [{ method: extracted.method || 'unknown', evidence: extracted.productUrlEvidence || extracted.evidence || 'unknown', productUrl: extracted.productUrl || extracted.cardUrl || identity.discoveredFrom }];
  const observationSources = extractedSources.map((source) => ({
    method: source.method || extracted.method || 'unknown',
    discoveredFrom: identity.discoveredFrom,
    discoveredUrl: source.productUrl || extracted.productUrl || extracted.cardUrl || identity.discoveredFrom,
    evidence: source.evidence || extracted.productUrlEvidence || extracted.evidence || 'unknown',
    jsonldIndex: Number.isInteger(source.jsonldIndex) ? source.jsonldIndex : (Number.isInteger(extracted.jsonldIndex) ? extracted.jsonldIndex : -1),
    selectorIndex: Number.isInteger(source.selectorIndex) ? source.selectorIndex : (Number.isInteger(extracted.selectorIndex) ? extracted.selectorIndex : -1),
  }));
  const observation = {
    fingerprint: priceFingerprint({
      day,
      storeCode: extracted.storeCode || null,
      price: extracted.price ?? null,
      regularPrice: extracted.regularPrice ?? null,
      currency: extracted.currency ?? defaultCurrency ?? null,
      promotion: extracted.promotion || null,
      availability: extracted.availability || null,
      priceScope: extracted.priceScope || 'unknown',
    }),
    storeCode: extracted.storeCode || null,
    price: extracted.price ?? null,
    regularPrice: extracted.regularPrice ?? null,
    currency: extracted.currency ?? defaultCurrency ?? null,
    promotion: extracted.promotion || null,
    availability: extracted.availability || null,
    priceScope: extracted.priceScope || 'unknown',
    sourceUrl: extracted.sourceUrl || identity.discoveredFrom,
    observedAt,
    sources: observationSources,
  };

  return {
    ...identity,
    name: identity.identity.name,
    brand: identity.identity.brand,
    category: identity.identity.category,
    imageUrl: extracted.imageUrl || null,
    observations: [observation],
    sources: observationSources.map(({ method, discoveredFrom, discoveredUrl, evidence }) => ({ method, discoveredFrom, discoveredUrl, evidence })),
    extractionConflicts: Array.isArray(extracted.extractionConflicts) ? extracted.extractionConflicts : [],
  };
}

function observationSourceKey(source) {
  return [
    source.method,
    source.discoveredFrom,
    source.discoveredUrl,
    source.evidence,
    source.jsonldIndex,
    source.selectorIndex,
  ].join('\u0000');
}

function candidateSourceKey(source) {
  return [source.method, source.discoveredFrom, source.discoveredUrl, source.evidence].join('\u0000');
}

function mergeIdentifierLists(left = [], right = []) {
  const merged = left.map((identifier) => ({ ...identifier }));
  for (const identifier of right) {
    if (!merged.some((current) => sameIdentifier(current, identifier))) {
      merged.push({ ...identifier });
    }
  }
  return merged;
}

function identifierPairs(identifiers) {
  return identifiers.map((identifier) => `${identifier.namespace}:${identifier.value}`);
}

function isPrimaryIdentifier(identityKey, identifier) {
  if (!identityKey || !identifier) return false;
  const suffix = identityKey.slice(2);
  if (identityKey.startsWith('g:')) return identifier.namespace === 'gtin' && identifier.value === suffix;
  if (identityKey.startsWith('m:')) return identifier.namespace === 'merchant_ref' && identifier.value === suffix;
  if (identityKey.startsWith('r:')) return ['ref', 'sku'].includes(identifier.namespace) && identifier.value === suffix;
  if (identityKey.startsWith('u:')) return identifier.namespace === 'url' && identifier.value === suffix;
  return false;
}

function sameNumber(left, right) {
  if (left === null || left === undefined) return right === null || right === undefined;
  if (right === null || right === undefined) return false;
  return Number(left) === Number(right);
}

function sameText(left, right) {
  return (left ?? null) === (right ?? null);
}

/**
 * Stage une page : crée ou retrouve les candidats, ajoute observations et
 * provenances. Idempotent au rejeu. Budget dur par job.
 */
export async function stageProducts({
  pool,
  jobId,
  leaseToken,
  sourceId,
  products,
  budget = 12000,
  observedAt = new Date(),
  stripParams,
  keepParams,
  defaultCurrency = null,
}) {
  if (!Array.isArray(products) || products.length === 0) {
    return {
      candidatesCreated: 0,
      candidatesUpdated: 0,
      observationsAdded: 0,
      observationSourcesAdded: 0,
      candidateSourcesAdded: 0,
      blocked: 0,
    };
  }

  const discovered = mergeCandidates(products.map((product) => buildDiscoveredProduct(product, {
    sourceId,
    stripParams,
    keepParams,
    defaultCurrency,
    observedAt,
  })));

  return withTransaction(pool, async (client) => {
    const job = await lockJob(client, jobId, leaseToken);
    if (job.source_id !== sourceId) {
      throw new IdentityConflictError(`Source ${sourceId} incompatible avec le job ${jobId}.`);
    }

    const counters = {
      candidatesCreated: 0,
      candidatesUpdated: 0,
      observationsAdded: 0,
      observationSourcesAdded: 0,
      candidateSourcesAdded: 0,
      blocked: 0,
    };

    const countResult = await client.query(
      'SELECT COUNT(*)::int AS total FROM product_candidates WHERE job_id=$1',
      [jobId],
    );
    let total = countResult.rows[0]?.total ?? 0;

    for (const candidate of discovered) {
      const inserted = await client.query(
        `INSERT INTO product_candidates
           (job_id, source_id, discovery_key, identity_key, product_url, discovered_from,
            name, brand, category, image_url, identity, identifiers, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,'staged')
         ON CONFLICT (job_id, discovery_key) DO NOTHING
         RETURNING id, status`,
        [
          jobId,
          sourceId,
          candidate.discoveryKey,
          candidate.identityKey,
          candidate.productUrl,
          candidate.discoveredFrom,
          candidate.name,
          candidate.brand,
          candidate.category,
          candidate.imageUrl,
          JSON.stringify(candidate.identity),
          JSON.stringify(candidate.identifiers),
        ],
      );

      let candidateId;
      if (inserted.rows[0]) {
        candidateId = inserted.rows[0].id;
        counters.candidatesCreated += 1;
        total += 1;
        if (total > budget) {
          throw new BudgetExceededError(
            `Budget de ${budget} candidats dépassé pour le job ${jobId}.`,
          );
        }
      } else {
        const existing = await client.query(
          `SELECT id, identity_key, identifiers, identity, status, product_id, block_reason
             FROM product_candidates
            WHERE job_id=$1 AND discovery_key=$2
            FOR UPDATE`,
          [jobId, candidate.discoveryKey],
        );
        const row = existing.rows[0];
        if (!row) {
          throw new IdentityConflictError('Candidat introuvable après conflit de clé de découverte.');
        }
        candidateId = row.id;

        const existingIdentifiers = Array.isArray(row.identifiers) ? row.identifiers : [];
        const mergedIdentifiers = mergeIdentifierLists(existingIdentifiers, candidate.identifiers);
        const strongerKey = identityKeyRank(candidate.identityKey) > identityKeyRank(row.identity_key);

        if (row.status === 'blocked') {
          // Ne pas modifier son identité ni son état, mais continuer à stocker
          // les observations et provenances entrantes. Elles seront reprises
          // après résolution humaine de l'anomalie.
          counters.blocked += 1;
        } else if (row.status === 'finalized') {
          // Le produit est déjà écrit : les nouvelles observations/provenances sont
          // conservées, mais l'identité historique n'est jamais réécrite.
          if (row.identity_key !== candidate.identityKey) {
            await recordAnomalies(client, {
              jobId,
              sourceId,
              kind: 'post-finalization-identity-change',
              detail: {
                candidateId,
                storedKey: row.identity_key,
                incomingKey: candidate.identityKey,
                incomingIdentity: candidate.identity,
                incomingIdentifiers: candidate.identifiers,
                incomingProductUrl: candidate.productUrl,
                note: 'Identité enrichie après finalisation : validation humaine requise avant transfert des nouvelles observations.',
              },
              candidateIds: [candidateId],
            });
            await client.query(
              `UPDATE product_candidates SET block_reason='post-finalization-identity-change', updated_at=NOW() WHERE id=$1`,
              [candidateId],
            );
            counters.blocked += 1;
          } else if (JSON.stringify(mergedIdentifiers) !== JSON.stringify(existingIdentifiers)) {
            await client.query(
              `UPDATE product_candidates SET identifiers=$2::jsonb, updated_at=NOW() WHERE id=$1`,
              [candidateId, JSON.stringify(mergedIdentifiers)],
            );
          }
        } else if (row.identity_key !== candidate.identityKey && !strongerKey) {
          await recordAnomalies(client, {
            jobId,
            sourceId,
            kind: 'identity-conflict',
            detail: {
              storedKey: row.identity_key,
              incomingKey: candidate.identityKey,
              incomingIdentity: candidate.identity,
              incomingIdentifiers: candidate.identifiers,
              incomingProductUrl: candidate.productUrl,
              note: 'Identité entrante moins forte que l’identité conservée ; observation et provenance conservées en staging.',
            },
            candidateIds: [candidateId],
          });
          counters.blocked += 1;
        } else {
          await client.query(
            `UPDATE product_candidates
                SET identity_key=$2,
                    identifiers=$3::jsonb,
                    identity=$4::jsonb,
                    product_url=COALESCE(product_url,$5),
                    brand=COALESCE(brand,$6),
                    category=COALESCE(category,$7),
                    image_url=COALESCE(image_url,$8),
                    updated_at=NOW()
              WHERE id=$1`,
            [
              candidateId,
              strongerKey ? candidate.identityKey : row.identity_key,
              JSON.stringify(mergedIdentifiers),
              JSON.stringify(candidate.identity),
              candidate.productUrl,
              candidate.brand,
              candidate.category,
              candidate.imageUrl,
            ],
          );
          counters.candidatesUpdated += 1;
        }
      }

      if (candidate.extractionConflicts?.length) {
        await recordAnomalies(client, {
          jobId,
          sourceId,
          kind: 'multi-source-extraction-conflict',
          detail: { conflicts: candidate.extractionConflicts, candidateIds: [Number(candidateId)] },
          candidateIds: [Number(candidateId)],
        });
        counters.blocked += 1;
      }

      for (const observation of candidate.observations) {
        const observationResult = await client.query(
          `INSERT INTO product_candidate_observations
             (candidate_id, fingerprint, store_code, price, regular_price, currency,
              promotion, availability, price_scope, source_url, observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
           ON CONFLICT (candidate_id, fingerprint) DO NOTHING
           RETURNING id`,
          [
            candidateId,
            observation.fingerprint,
            observation.storeCode,
            observation.price,
            observation.regularPrice,
            observation.currency,
            observation.promotion,
            observation.availability,
            observation.priceScope,
            observation.sourceUrl,
            observation.observedAt,
          ],
        );

        let observationId;
        if (observationResult.rows[0]) {
          observationId = observationResult.rows[0].id;
          counters.observationsAdded += 1;
        } else {
          const existingObservation = await client.query(
            `SELECT id, store_code, price, regular_price, currency, promotion, availability, price_scope
               FROM product_candidate_observations
              WHERE candidate_id=$1 AND fingerprint=$2
              FOR UPDATE`,
            [candidateId, observation.fingerprint],
          );
          const row = existingObservation.rows[0];
          if (!row
            || !sameNumber(row.price, observation.price)
            || !sameNumber(row.regular_price, observation.regularPrice)
            || !sameText(row.currency, observation.currency)
            || !sameText(row.store_code, observation.storeCode)) {
            throw new IdentityConflictError(
              `Collision d'empreinte commerciale pour le candidat ${candidateId}.`,
              {
                kind: 'observation-fingerprint-collision',
                candidateId,
                fingerprint: observation.fingerprint,
              },
            );
          }
          observationId = row.id;
        }

        for (const source of observation.sources) {
          const sourceResult = await client.query(
            `INSERT INTO product_candidate_observation_sources
               (observation_id, method, discovered_from, discovered_url, evidence, jsonld_index, selector_index)
             VALUES ($1,$2,$3,$4,$5,$6,$7)
             ON CONFLICT (observation_id, method, discovered_from, discovered_url, evidence, jsonld_index, selector_index)
             DO NOTHING
             RETURNING id`,
            [
              observationId,
              source.method,
              source.discoveredFrom,
              source.discoveredUrl,
              source.evidence,
              source.jsonldIndex,
              source.selectorIndex,
            ],
          );
          if (sourceResult.rows[0]) counters.observationSourcesAdded += 1;
        }
      }

      for (const source of candidate.sources) {
        const sourceResult = await client.query(
          `INSERT INTO product_candidate_sources
             (candidate_id, method, discovered_from, discovered_url, evidence)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (candidate_id, method, discovered_from, discovered_url, evidence)
           DO NOTHING
           RETURNING id`,
          [
            candidateId,
            source.method,
            source.discoveredFrom,
            source.discoveredUrl,
            source.evidence,
          ],
        );
        if (sourceResult.rows[0]) counters.candidateSourcesAdded += 1;
      }
    }

    return counters;
  });
}

function normalizeCandidate(row, observations) {
  const identifiers = Array.isArray(row.identifiers) ? row.identifiers : [];
  const identity = row.identity && typeof row.identity === 'object' ? row.identity : {};
  return {
    id: Number(row.id),
    discoveryKey: row.discovery_key,
    identityKey: row.identity_key,
    imageUrl: row.image_url || null,
    identity: {
      name: row.name,
      brand: row.brand,
      category: row.category,
      variant: identity.variant && typeof identity.variant === 'object' ? identity.variant : {},
      variantSignature: identity.variantSignature || variantSignature(identity.variant),
    },
    identifiers,
    productUrl: row.product_url,
    discoveredFrom: row.discovered_from,
    productId: row.product_id === null || row.product_id === undefined ? null : Number(row.product_id),
    blockReason: row.block_reason || null,
    observations,
    status: row.status,
  };
}

/**
 * Classification pure : composantes connexes par identifiants partagés, puis
 * conflits évalués sur toute la composante. Aucune écriture.
 */
export function classifyCandidates(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { groups: [], conflicts: [] };
  }

  const parent = new Map();
  const find = (value) => {
    let current = value;
    while (parent.get(current) !== current) {
      parent.set(current, parent.get(parent.get(current)));
      current = parent.get(current);
    }
    return current;
  };
  const union = (left, right) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parent.set(rightRoot, leftRoot);
    else parent.set(leftRoot, rightRoot);
  };

  for (const candidate of candidates) parent.set(candidate.id, candidate.id);

  const byIdentifier = new Map();
  for (const candidate of candidates) {
    for (const identifier of candidate.identifiers) {
      const key = `id\u0000${identifier.namespace}\u0000${identifier.value}`;
      if (byIdentifier.has(key)) union(candidate.id, byIdentifier.get(key));
      else byIdentifier.set(key, candidate.id);
    }
    const key = `key\u0000${candidate.identityKey}`;
    if (byIdentifier.has(key)) union(candidate.id, byIdentifier.get(key));
    else byIdentifier.set(key, candidate.id);
  }

  const components = new Map();
  for (const candidate of candidates) {
    const root = find(candidate.id);
    if (!components.has(root)) components.set(root, []);
    components.get(root).push(candidate);
  }

  const groups = [];
  const conflicts = [];

  for (const members of components.values()) {
    const gtins = [...new Set(
      members.flatMap((member) => member.identifiers
        .filter((identifier) => identifier.namespace === 'gtin')
        .map((identifier) => identifier.value)),
    )];
    const variantMerge = mergeVariantDetails(...members.map((member) => member.identity.variant || {}));
    const variants = variantMerge.variant;
    const variantConflicts = variantMerge.conflicts.map((conflict) => ({
      kind: 'variant-conflict',
      ...conflict,
      candidateIds: members.map((item) => item.id),
    }));

    const identifiers = members.flatMap((member) => member.identifiers);
    const strongest = members
      .slice()
      .sort((left, right) => identityKeyRank(right.identityKey) - identityKeyRank(left.identityKey))[0];

    const groupConflicts = [];
    if (gtins.length > 1) {
      groupConflicts.push({
        kind: 'gtin-conflict',
        gtins,
        candidateIds: members.map((item) => item.id),
      });
    }
    groupConflicts.push(...variantConflicts);

    if (groupConflicts.length) conflicts.push(...groupConflicts);

    groups.push({
      identityKey: strongest.identityKey,
      gtin: gtins.length === 1 ? gtins[0] : null,
      variants,
      variantSignature: variantSignature(variants),
      identifiers,
      candidates: members,
      observations: members.flatMap((member) => member.observations.map((observation) => ({
        ...observation,
        candidateId: member.id,
      }))),
      conflicts: groupConflicts,
    });
  }

  groups.sort((left, right) => {
    const leftMin = Math.min(...left.candidates.map((item) => item.id));
    const rightMin = Math.min(...right.candidates.map((item) => item.id));
    return leftMin - rightMin;
  });

  return { groups, conflicts };
}

async function recordAnomalies(client, {
  jobId,
  sourceId,
  kind,
  detail,
  candidateIds = [],
}) {
  const ids = [...new Set(candidateIds.map(Number).filter(Number.isSafeInteger))];
  let candidateContext = [];
  if (ids.length) {
    const candidates = await client.query(
      `SELECT id, identity_key, identifiers, name, brand, product_url, discovered_from,
              identity, status, product_id, block_reason
         FROM product_candidates
        WHERE id = ANY($1::bigint[])
        ORDER BY id
        FOR UPDATE`,
      [ids],
    );
    candidateContext = candidates.rows;
  }
  const enrichedDetail = {
    ...(detail && typeof detail === 'object' ? detail : { suppliedDetail: detail }),
    candidateIds: ids,
    candidateContext,
  };
  // Une anomalie multi-candidat produit une ligne par candidat : la revue de
  // l'un ne doit pas marquer implicitement les autres comme résolus.
  for (const candidateId of (ids.length ? ids : [null])) {
    await client.query(
      `INSERT INTO product_identity_anomalies (job_id, source_id, candidate_id, kind, detail)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [jobId, sourceId, candidateId, kind, JSON.stringify(enrichedDetail)],
    );
  }
  if (ids.length) {
    await client.query(
      `UPDATE product_candidates
          SET status=CASE WHEN status='finalized' THEN status ELSE 'blocked' END,
              block_reason=$2,
              updated_at=NOW()
        WHERE id = ANY($1::bigint[])`,
      [ids, kind],
    );
  }
}

async function findHistoricalProducts(client, sourceId, group) {
  const ids = new Set(group.candidates.map((candidate) => candidate.productId).filter((id) => Number.isFinite(id)));
  if (group.gtin) {
    const byGtin = await client.query(
      'SELECT id FROM products WHERE source_id=$1 AND gtin=$2 FOR UPDATE',
      [sourceId, group.gtin],
    );
    for (const row of byGtin.rows) ids.add(Number(row.id));
  }

  const pairs = identifierPairs(group.identifiers);
  if (pairs.length) {
    const byIdentifier = await client.query(
      `SELECT product_id
         FROM product_identifiers
        WHERE source_id=$1
          AND verified=TRUE
          AND (namespace || ':' || value) = ANY($2::text[])
        FOR UPDATE`,
      [sourceId, pairs],
    );
    for (const row of byIdentifier.rows) ids.add(Number(row.product_id));
  }

  const byKey = await client.query(
    'SELECT id FROM products WHERE source_id=$1 AND identity_key=$2 FOR UPDATE',
    [sourceId, group.identityKey],
  );
  for (const row of byKey.rows) ids.add(Number(row.id));

  const urls = [...new Set(
    group.identifiers
      .filter((identifier) => identifier.namespace === 'url')
      .map((identifier) => identifier.value),
  )];
  for (const url of urls) {
    const byUrl = await client.query(
      'SELECT id FROM products WHERE source_id=$1 AND product_url=$2 FOR UPDATE',
      [sourceId, url],
    );
    for (const row of byUrl.rows) ids.add(Number(row.id));
  }

  return [...ids];
}

/**
 * Finalise un job : une seule transaction, verrou de job, classification,
 * détection de collision avant écriture, rollback complet sinon.
 */
export async function finalizeJob({
  pool,
  jobId,
  leaseToken,
  identityConflictRecorder,
}) {
  try {
    return await withTransaction(pool, async (client) => {
      const job = await lockJob(client, jobId, leaseToken);
      const sourceId = job.source_id;
      // Sérialise les finalisations d'une même source : deux jobs concurrents ne
      // peuvent pas créer deux produits pour le même GTIN.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mapnifique.source:${sourceId}`]);

      const blockedRows = await client.query(
        `SELECT id FROM product_candidates WHERE job_id=$1 AND status='blocked' ORDER BY id FOR UPDATE`,
        [jobId],
      );
      if (blockedRows.rows.length) {
        throw new IdentityConflictError(
          `Le job ${jobId} contient ${blockedRows.rows.length} candidat(s) bloqué(s) nécessitant une revue explicite.`,
          { kind: 'blocked-candidates', candidateIds: blockedRows.rows.map((row) => Number(row.id)) },
        );
      }
      const finalisedBlocked = await client.query(
        `SELECT id FROM product_candidates c
          WHERE job_id=$1 AND status='finalized' AND block_reason IS NOT NULL
            AND EXISTS (SELECT 1 FROM product_candidate_observations o
                         WHERE o.candidate_id=c.id AND o.product_observation_id IS NULL)
          ORDER BY id FOR UPDATE`,
        [jobId],
      );
      if (finalisedBlocked.rows.length) {
        throw new IdentityConflictError(
          'Des observations associées à une identité modifiée après finalisation attendent une validation humaine.',
          { kind: 'post-finalization-identity-review', candidateIds: finalisedBlocked.rows.map((row) => Number(row.id)) },
        );
      }

      const candidateRows = await client.query(
        `SELECT id, discovery_key, identity_key, identifiers, identity, name, brand, category,
                image_url, product_url, discovered_from, status, product_id, block_reason
           FROM product_candidates c
          WHERE job_id=$1 AND (
            status IN ('staged','classified') OR
            (status='finalized' AND block_reason IS NULL AND EXISTS (
              SELECT 1 FROM product_candidate_observations o
               WHERE o.candidate_id=c.id AND o.product_observation_id IS NULL
            ))
          )
          ORDER BY id
          FOR UPDATE`,
        [jobId],
      );

      if (!candidateRows.rows.length) {
        return { products: 0, observations: 0, groups: 0, candidates: 0 };
      }

      const candidateIds = candidateRows.rows.map((row) => Number(row.id));
      const observationRows = await client.query(
        `SELECT * FROM product_candidate_observations
          WHERE candidate_id = ANY($1::bigint[])
            AND product_observation_id IS NULL
          ORDER BY candidate_id, id
          FOR UPDATE`,
        [candidateIds],
      );
      const observationsByCandidate = new Map();
      for (const row of observationRows.rows) {
        const key = Number(row.candidate_id);
        if (!observationsByCandidate.has(key)) observationsByCandidate.set(key, []);
        observationsByCandidate.get(key).push({
          id: Number(row.id),
          fingerprint: row.fingerprint,
          storeCode: row.store_code,
          price: row.price === null ? null : Number(row.price),
          regularPrice: row.regular_price === null ? null : Number(row.regular_price),
          currency: row.currency,
          promotion: row.promotion,
          availability: row.availability,
          priceScope: row.price_scope,
          sourceUrl: row.source_url,
          observedAt: row.observed_at,
          sources: [],
        });
      }

      const observationIds = observationRows.rows.map((row) => Number(row.id));
      if (observationIds.length) {
        const sourceRows = await client.query(
          `SELECT * FROM product_candidate_observation_sources
            WHERE observation_id = ANY($1::bigint[])
            ORDER BY id`,
          [observationIds],
        );
        const byObservation = new Map();
        for (const row of sourceRows.rows) {
          const key = Number(row.observation_id);
          if (!byObservation.has(key)) byObservation.set(key, []);
          byObservation.get(key).push({
            method: row.method,
            discoveredFrom: row.discovered_from,
            discoveredUrl: row.discovered_url,
            evidence: row.evidence,
            jsonldIndex: row.jsonld_index,
            selectorIndex: row.selector_index,
          });
        }
        for (const observations of observationsByCandidate.values()) {
          for (const observation of observations) {
            observation.sources = byObservation.get(observation.id) || [];
          }
        }
      }

      const candidates = candidateRows.rows.map((row) => normalizeCandidate(
        row,
        observationsByCandidate.get(Number(row.id)) || [],
      ));

      const { groups, conflicts } = classifyCandidates(candidates);
      if (conflicts.length) {
        throw new IdentityConflictError(
          `Identités ambiguës pour le job ${jobId} : aucune écriture effectuée.`,
          { jobId, sourceId, conflicts },
        );
      }

      let productsWritten = 0;
      let observationsWritten = 0;

      for (const group of groups) {
        const historical = await findHistoricalProducts(client, sourceId, group);
        if (historical.length > 1) {
          throw new IdentityConflictError(
            `Plusieurs produits historiques correspondent au groupe ${group.identityKey}.`,
            {
              kind: 'multiple-historical-products',
              productIds: historical,
              identityKey: group.identityKey,
              candidateIds: group.candidates.map((candidate) => candidate.id),
            },
          );
        }

        const primary = group.candidates
          .slice()
          .sort((left, right) => identityKeyRank(right.identityKey) - identityKeyRank(left.identityKey))[0];
        const productUrl = primary.productUrl
          || group.candidates.map((candidate) => candidate.productUrl).find(Boolean)
          || null;

        let productId = historical[0] ?? null;
        let storedIdentity = {};

        if (productId) {
          const current = await client.query(
            `SELECT id, gtin, name, brand, category, image_url, identity
               FROM products WHERE id=$1 FOR UPDATE`,
            [productId],
          );
          const row = current.rows[0];
          if (!row) throw new IdentityConflictError('Produit historique introuvable après verrouillage.');
          if (row.gtin && group.gtin && row.gtin !== group.gtin) {
            throw new IdentityConflictError(
              `GTIN contradictoire avec le produit historique ${productId}.`,
              {
                kind: 'historical-gtin-mismatch',
                productId,
                storedGtin: row.gtin,
                candidateGtin: group.gtin,
              },
            );
          }
          storedIdentity = row.identity && typeof row.identity === 'object' ? row.identity : {};
          const historicalVariantMerge = mergeVariantDetails(
            storedIdentity.variant && typeof storedIdentity.variant === 'object' ? storedIdentity.variant : {},
            group.variants,
          );
          if (historicalVariantMerge.conflicts.length) {
            throw new IdentityConflictError(
              `Variantes contradictoires avec le produit historique ${productId}.`,
              {
                kind: 'historical-variant-conflict',
                productId,
                conflicts: historicalVariantMerge.conflicts,
                candidateIds: group.candidates.map((candidate) => candidate.id),
              },
            );
          }
          const mergedVariant = historicalVariantMerge.variant;
          const mergedIdentity = {
            ...storedIdentity,
            name: storedIdentity.name || group.candidates[0].identity.name,
            brand: storedIdentity.brand || group.candidates[0].identity.brand,
            category: storedIdentity.category || group.candidates[0].identity.category,
            variant: mergedVariant,
            variantSignature: variantSignature(mergedVariant),
          };

          await client.query(
            `UPDATE products
                SET product_url=COALESCE(product_url,$2),
                    gtin=COALESCE(gtin,$3),
                    brand=COALESCE(brand,$4),
                    category=COALESCE(category,$5),
                    image_url=COALESCE(image_url,$6),
                    discovered_from=COALESCE(discovered_from,$7),
                    identity_key=CASE
                      WHEN $8 LIKE 'g:%' THEN $8
                      WHEN $8 LIKE 'm:%' AND (identity_key IS NULL OR identity_key LIKE 'f:%' OR identity_key LIKE 'u:%' OR identity_key LIKE 'r:%') THEN $8
                      WHEN $8 LIKE 'r:%' AND (identity_key IS NULL OR identity_key LIKE 'f:%' OR identity_key LIKE 'u:%') THEN $8
                      WHEN $8 LIKE 'u:%' AND (identity_key IS NULL OR identity_key LIKE 'f:%') THEN $8
                      ELSE identity_key
                    END,
                    identity=$9::jsonb,
                    last_seen_at=NOW()
              WHERE id=$1`,
            [
              productId,
              productUrl,
              group.gtin,
              group.candidates[0].identity.brand,
              group.candidates[0].identity.category,
              group.candidates.map((candidate) => candidate.imageUrl).find(Boolean) ?? null,
              group.candidates[0].discoveredFrom,
              group.identityKey,
              JSON.stringify(mergedIdentity),
            ],
          );

          if (storedIdentity.name && group.candidates[0].identity.name
            && normalizeName(storedIdentity.name) !== normalizeName(group.candidates[0].identity.name)) {
            await client.query(
              `INSERT INTO product_identity_anomalies (job_id, source_id, candidate_id, kind, detail)
               VALUES ($1,$2,$3,'descriptive-difference',$4::jsonb)`,
              [
                jobId,
                sourceId,
                group.candidates[0].id,
                JSON.stringify({
                  productId,
                  keptName: storedIdentity.name,
                  seenName: group.candidates[0].identity.name,
                  blocking: false,
                }),
              ],
            );
          }
        } else {
          const inserted = await client.query(
            `INSERT INTO products
               (source_id, product_url, gtin, name, brand, category, image_url,
                discovered_from, identity_key, identity, first_seen_at, last_seen_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,NOW(),NOW())
             ON CONFLICT DO NOTHING
             RETURNING id`,
            [
              sourceId,
              productUrl,
              group.gtin,
              group.candidates[0].identity.name,
              group.candidates[0].identity.brand,
              group.candidates[0].identity.category,
              group.candidates.map((candidate) => candidate.imageUrl).find(Boolean) ?? null,
              group.candidates[0].discoveredFrom,
              group.identityKey,
              JSON.stringify({
                name: group.candidates[0].identity.name,
                brand: group.candidates[0].identity.brand,
                category: group.candidates[0].identity.category,
                variant: group.variants,
                variantSignature: group.variantSignature,
              }),
            ],
          );

          if (inserted.rows[0]) {
            productId = Number(inserted.rows[0].id);
          } else {
            const reread = await findHistoricalProducts(client, sourceId, group);
            if (reread.length !== 1) {
              throw new IdentityConflictError(
                'Collision de produit après insertion : réconciliation ambiguë.',
                {
                  kind: 'product-insert-collision',
                  identityKey: group.identityKey,
                  productIds: reread,
                },
              );
            }
            productId = reread[0];
          }
        }

        for (const identifier of group.identifiers) {
          const identifierResult = await client.query(
            `INSERT INTO product_identifiers (product_id, namespace, source_id, value, kind, evidence, verified)
             VALUES ($1,$2,$3,$4,$5,$6,TRUE)
             ON CONFLICT (namespace, source_id, value) DO NOTHING
             RETURNING id`,
            [
              productId,
              identifier.namespace,
              sourceId,
              identifier.value,
              isPrimaryIdentifier(group.identityKey, identifier) ? 'primary' : 'secondary',
              identifier.evidence || 'unknown',
            ],
          );

          if (!identifierResult.rows[0]) {
            const stored = await client.query(
              `SELECT product_id FROM product_identifiers
                WHERE namespace=$1 AND source_id=$2 AND value=$3
                FOR UPDATE`,
              [identifier.namespace, sourceId, identifier.value],
            );
            if (Number(stored.rows[0]?.product_id) !== Number(productId)) {
              throw new IdentityConflictError(
                `Alias déjà rattaché à un autre produit : ${identifier.namespace}:${identifier.value}.`,
                {
                  kind: 'alias-collision',
                  namespace: identifier.namespace,
                  value: identifier.value,
                  productId,
                  storedProductId: stored.rows[0]?.product_id ?? null,
                  candidateIds: group.candidates.map((candidate) => candidate.id),
                },
              );
            }
          }
        }

        for (const observation of group.observations) {
          const observationResult = await client.query(
            `INSERT INTO price_observations
               (product_id, store_code, price, regular_price, currency, promotion,
                availability, price_scope, source_url, fingerprint, observed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (product_id, fingerprint) DO NOTHING
             RETURNING id`,
            [
              productId,
              observation.storeCode,
              observation.price,
              observation.regularPrice,
              observation.currency,
              observation.promotion,
              observation.availability,
              observation.priceScope,
              observation.sourceUrl,
              observation.fingerprint,
              observation.observedAt,
            ],
          );

          let priceObservationId;
          if (observationResult.rows[0]) {
            priceObservationId = Number(observationResult.rows[0].id);
            observationsWritten += 1;
          } else {
            const stored = await client.query(
              `SELECT id, price, regular_price, currency, store_code
                 FROM price_observations
                WHERE product_id=$1 AND fingerprint=$2
                FOR UPDATE`,
              [productId, observation.fingerprint],
            );
            const row = stored.rows[0];
            if (!row
              || !sameNumber(row.price, observation.price)
              || !sameNumber(row.regular_price, observation.regularPrice)
              || !sameText(row.currency, observation.currency)
              || !sameText(row.store_code, observation.storeCode)) {
              throw new IdentityConflictError(
                'Collision d’empreinte commerciale avec une observation existante.',
                {
                  kind: 'price-fingerprint-collision',
                  productId,
                  fingerprint: observation.fingerprint,
                },
              );
            }
            priceObservationId = Number(row.id);
          }

          for (const source of observation.sources) {
            await client.query(
              `INSERT INTO price_observation_sources
                 (observation_id, discovered_from, method, evidence, discovered_url)
               VALUES ($1,$2,$3,$4,$5)
               ON CONFLICT (observation_id, discovered_from, method, evidence, discovered_url)
               DO NOTHING`,
              [
                priceObservationId,
                source.discoveredFrom,
                source.method,
                source.evidence,
                source.discoveredUrl || '',
              ],
            );
          }
          const mapped = await client.query(
            `UPDATE product_candidate_observations
                SET product_observation_id=$2
              WHERE id=$1 AND product_observation_id IS NULL
              RETURNING id`,
            [observation.id, priceObservationId],
          );
          if (mapped.rowCount !== 1) {
            throw new IdentityConflictError('Observation staging déjà consommée ou introuvable.', {
              kind: 'staging-observation-state-changed', candidateIds: [observation.candidateId],
              observationId: observation.id,
            });
          }
        }

        const activeIds = group.candidates.filter((candidate) => candidate.status !== 'finalized').map((candidate) => candidate.id);
        if (activeIds.length) {
          const finalized = await client.query(
            `UPDATE product_candidates
                SET status='finalized', product_id=$2, block_reason=NULL, updated_at=NOW()
              WHERE id = ANY($1::bigint[])
                AND status IN ('staged','classified')
              RETURNING id`,
            [activeIds, productId],
          );
          if (finalized.rowCount !== activeIds.length) {
            throw new IdentityConflictError(
              'Un candidat du groupe n’était plus dans un état finalisable.',
              { kind: 'candidate-state-changed', candidateIds: activeIds },
            );
          }
        }

        productsWritten += 1;
      }

      const remainder = await client.query(
        `SELECT c.id FROM product_candidates c
          WHERE c.job_id=$1 AND (
            c.status <> 'finalized' OR EXISTS (
              SELECT 1 FROM product_candidate_observations o
               WHERE o.candidate_id=c.id AND o.product_observation_id IS NULL
            )
          )
          FOR UPDATE`,
        [jobId],
      );
      if (remainder.rows.length > 0) {
        throw new IdentityConflictError(
          `Candidats non finalisés après traitement du job ${jobId}.`,
          { kind: 'pending-candidates', pending: remainder.rows.length },
        );
      }

      return {
        products: productsWritten,
        observations: observationsWritten,
        groups: groups.length,
        candidates: candidates.length,
      };
    });
  } catch (error) {
    if (error instanceof IdentityConflictError) {
      const conflict = error.detail || {};
      try {
        if (identityConflictRecorder) {
          await identityConflictRecorder(conflict);
        } else if (!['blocked-candidates', 'post-finalization-identity-review'].includes(conflict.kind)) {
          // Ces blocages sont déjà persistés ; ne pas créer une anomalie à chaque retry.
          await persistConflict(pool, jobId, leaseToken, conflict);
        }
      } catch (persistenceError) {
        error.anomalyPersistenceError = persistenceError;
      }
    }
    throw error;
  }
}

/** Consigne les anomalies après rollback, dans une transaction séparée, sous le lease courant. */
export async function persistConflict(pool, jobId, leaseToken, conflict) {
  await withTransaction(pool, async (client) => {
    const job = await lockJob(client, jobId, leaseToken);
    const conflicts = Array.isArray(conflict.conflicts) ? conflict.conflicts : [conflict];
    const allIds = new Set(Array.isArray(conflict.candidateIds) ? conflict.candidateIds.map(Number) : []);
    if (conflict.candidateId) allIds.add(Number(conflict.candidateId));
    for (const item of conflicts) {
      for (const id of (Array.isArray(item.candidateIds) ? item.candidateIds : [])) allIds.add(Number(id));
      if (item.candidateId) allIds.add(Number(item.candidateId));
    }
    const allCandidateIds = [...allIds].filter(Number.isFinite);
    let candidateContext = [];
    if (allCandidateIds.length) {
      const candidates = await client.query(
        `SELECT id, identity_key, name, identity, product_url, status
           FROM product_candidates WHERE id=ANY($1::bigint[]) ORDER BY id FOR UPDATE`,
        [allCandidateIds],
      );
      candidateContext = candidates.rows;
    }
    for (const item of conflicts) {
      const itemIds = Array.isArray(item.candidateIds)
        ? item.candidateIds.map(Number).filter(Number.isFinite)
        : (item.candidateId ? [Number(item.candidateId)] : allCandidateIds);
      await recordAnomalies(client, {
        jobId,
        sourceId: job.source_id,
        kind: item.kind || conflict.kind || 'identity-conflict',
        detail: { ...item, candidateIds: itemIds, candidateContext: candidateContext.filter((row) => itemIds.includes(Number(row.id))) },
        candidateIds: itemIds,
      });
    }
  });
}

/** Réactivation explicite d'un candidat bloqué après revue humaine documentée. */
export async function resolveBlockedCandidate({
  pool, jobId, leaseToken, candidateId, anomalyId, resolution, adminReview = false,
}) {
  const note = typeof resolution?.note === 'string' ? resolution.note.trim() : '';
  const reviewer = typeof resolution?.reviewer === 'string' ? resolution.reviewer.trim() : '';
  if (!note || note.length > 2000 || !reviewer || reviewer.length > 100
      || !['retry', 'confirm-same-product'].includes(resolution?.action)) {
    throw new TypeError('Une résolution explicite action=retry|confirm-same-product, reviewer et note est obligatoire.');
  }
  return withTransaction(pool, async (client) => {
    if (adminReview) {
      const job = await client.query(
        `SELECT id, status FROM scrape_jobs WHERE id=$1 FOR UPDATE`,
        [jobId],
      );
      if (!job.rows[0] || job.rows[0].status !== 'failed') {
        throw new LeaseLostError('La revue administrateur est autorisée uniquement sur un job en échec.');
      }
    } else {
      await lockJob(client, jobId, leaseToken);
    }
    const anomaly = await client.query(
      `SELECT id, candidate_id, reviewed_at, detail FROM product_identity_anomalies
        WHERE id=$1 AND job_id=$2 FOR UPDATE`,
      [anomalyId, jobId],
    );
    if (!anomaly.rows[0] || Number(anomaly.rows[0].candidate_id) !== Number(candidateId)) {
      throw new IdentityConflictError('Anomalie absente ou non associée au candidat demandé.', {
        kind: 'resolution-anomaly-mismatch', candidateIds: [Number(candidateId)],
      });
    }
    if (anomaly.rows[0].reviewed_at) {
      throw new IdentityConflictError('Cette anomalie a déjà été revue.', {
        kind: 'anomaly-already-reviewed', candidateIds: [Number(candidateId)],
      });
    }
    const candidate = await client.query(
      `SELECT id, status, block_reason, identity_key, identifiers, identity, product_url,
              name, brand, category, image_url
         FROM product_candidates WHERE id=$1 AND job_id=$2 FOR UPDATE`,
      [candidateId, jobId],
    );
    const candidateRow = candidate.rows[0];
    const allowedBlockedRetry = candidateRow?.status === 'blocked' && resolution.action === 'retry';
    const allowedFinalizedConfirm = candidateRow?.status === 'finalized'
      && candidateRow.block_reason === 'post-finalization-identity-change'
      && resolution.action === 'confirm-same-product';
    if (!allowedBlockedRetry && !allowedFinalizedConfirm) {
      throw new IdentityConflictError('La décision ne correspond pas à l’état du candidat.', {
        kind: 'candidate-not-resolvable', candidateIds: [Number(candidateId)],
      });
    }
    if (allowedFinalizedConfirm) {
      const anomalyDetail = anomaly.rows[0].detail && typeof anomaly.rows[0].detail === 'object'
        ? anomaly.rows[0].detail
        : {};
      const incomingKey = anomalyDetail.incomingKey;
      const incomingIdentity = anomalyDetail.incomingIdentity;
      const incomingIdentifiers = Array.isArray(anomalyDetail.incomingIdentifiers)
        ? anomalyDetail.incomingIdentifiers
        : [];
      if (typeof incomingKey !== 'string' || !incomingIdentity || typeof incomingIdentity !== 'object'
          || identityKeyRank(incomingKey) <= identityKeyRank(candidateRow.identity_key)) {
        throw new IdentityConflictError(
          'La confirmation ne peut pas promouvoir une identité absente, invalide ou de priorité égale/inférieure.',
          { kind: 'invalid-identity-promotion', candidateIds: [Number(candidateId)] },
        );
      }
      const storedIdentity = candidateRow.identity && typeof candidateRow.identity === 'object'
        ? candidateRow.identity
        : {};
      const variantMerge = mergeVariantDetails(
        storedIdentity.variant && typeof storedIdentity.variant === 'object' ? storedIdentity.variant : {},
        incomingIdentity.variant && typeof incomingIdentity.variant === 'object' ? incomingIdentity.variant : {},
      );
      if (variantMerge.conflicts.length) {
        throw new IdentityConflictError(
          'La confirmation révèle des variantes contradictoires ; une correction manuelle est nécessaire.',
          { kind: 'identity-promotion-variant-conflict', conflicts: variantMerge.conflicts, candidateIds: [Number(candidateId)] },
        );
      }
      const mergedIdentity = {
        ...storedIdentity,
        ...incomingIdentity,
        variant: variantMerge.variant,
        variantSignature: variantSignature(variantMerge.variant),
      };
      const mergedIdentifiers = mergeIdentifierLists(
        Array.isArray(candidateRow.identifiers) ? candidateRow.identifiers : [],
        incomingIdentifiers,
      );
      await client.query(
        `UPDATE product_candidates
            SET identity_key=$2, identifiers=$3::jsonb, identity=$4::jsonb,
                product_url=COALESCE(product_url,$5), updated_at=NOW()
          WHERE id=$1 AND job_id=$6`,
        [candidateId, incomingKey, JSON.stringify(mergedIdentifiers), JSON.stringify(mergedIdentity),
          anomalyDetail.incomingProductUrl || null, jobId],
      );
    }
    await client.query(
      `UPDATE product_identity_anomalies
          SET reviewed_at=NOW(), detail=detail || $2::jsonb
        WHERE id=$1`,
      [anomalyId, JSON.stringify({ resolution: { action: resolution.action, reviewer, note } })],
    );
    const remaining = await client.query(
      `SELECT COUNT(*)::int AS total FROM product_identity_anomalies
        WHERE candidate_id=$1 AND reviewed_at IS NULL`,
      [candidateId],
    );
    if (Number(remaining.rows[0]?.total || 0) > 0) {
      return { candidateId: Number(candidateId), anomalyId: Number(anomalyId), status: 'blocked', unresolvedAnomalies: Number(remaining.rows[0].total) };
    }
    const targetStatus = allowedFinalizedConfirm ? 'finalized' : 'staged';
    await client.query(
      `UPDATE product_candidates SET status=$3, block_reason=NULL, updated_at=NOW()
        WHERE id=$1 AND job_id=$2`,
      [candidateId, jobId, targetStatus],
    );
    let jobRequeued = false;
    let pendingJobAnomalies = 0;
    if (adminReview) {
      const jobOpen = await client.query(
        `SELECT COUNT(*)::int AS total FROM product_identity_anomalies
          WHERE job_id=$1 AND reviewed_at IS NULL`,
        [jobId],
      );
      pendingJobAnomalies = Number(jobOpen.rows[0]?.total || 0);
      if (pendingJobAnomalies === 0) {
        const requeued = await client.query(
          `UPDATE scrape_jobs
              SET status='queued', attempts=0, started_at=NULL, heartbeat_at=NULL,
                  finished_at=NULL, lease_token=NULL, error=NULL
            WHERE id=$1 AND status='failed'
            RETURNING id`,
          [jobId],
        );
        jobRequeued = requeued.rowCount > 0;
      }
    }
    return {
      candidateId: Number(candidateId), anomalyId: Number(anomalyId), status: targetStatus,
      jobRequeued, pendingJobAnomalies,
    };
  });
}

export function isTerminalCandidate(status) {
  return TERMINAL_CANDIDATE_STATUSES.has(status);
}

export async function countPendingCandidates(client, jobId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS pending FROM product_candidates c
      WHERE c.job_id=$1 AND (c.status <> 'finalized' OR EXISTS (
        SELECT 1 FROM product_candidate_observations o
         WHERE o.candidate_id=c.id AND o.product_observation_id IS NULL
      ))`,
    [jobId],
  );
  return result.rows[0]?.pending ?? 0;
}

export { observationSourceKey, candidateSourceKey };
