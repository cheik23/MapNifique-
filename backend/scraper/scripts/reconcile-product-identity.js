#!/usr/bin/env node
/**
 * Réconciliation des produits historiques vers le modèle d'identité (version 2).
 *
 *   node scripts/reconcile-product-identity.js --audit
 *   node scripts/reconcile-product-identity.js --execute
 *
 * Le mode audit ne modifie rien. Le mode execute :
 *   BEGIN → verrou consultatif → verrou schema_state → lecture → validation
 *   → écritures → revalidation → version 2 → COMMIT
 * Toute anomalie provoque ROLLBACK et laisse la base en version 1.
 *
 * Aucune provenance n'est inventée : discovered_from reste NULL pour l'historique.
 * Aucun identifiant n'est deviné : un GTIN invalide n'est pas enregistré.
 */
import 'dotenv/config';
import pg from 'pg';
import {
  canonicalizeUrl,
  normalizeGtin,
  variantSignature,
} from '../src/identity.js';

const { Client } = pg;
const ADVISORY_LOCK = 'mapnifique.product_identity_reconcile';

function usage() {
  console.error('Usage: node scripts/reconcile-product-identity.js --audit|--execute');
  process.exit(64);
}

const mode = process.argv.includes('--audit')
  ? 'audit'
  : (process.argv.includes('--execute') ? 'execute' : null);
if (!mode) usage();

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL absent.');
  process.exit(64);
}

function identityForProduct(product) {
  const gtin = product.gtin ? normalizeGtin(product.gtin) : null;
  const rawUrl = product.product_url || null;
  const canonicalUrl = rawUrl ? canonicalizeUrl(rawUrl) : null;
  let identityKey;
  if (gtin) identityKey = `g:${gtin}`;
  else if (canonicalUrl) identityKey = `u:${canonicalUrl}`;
  else {
    // L'historique ne contient pas de page de découverte. Fabriquer une clé
    // fallback à partir d'un nom seul confondrait plusieurs produits distincts.
    identityKey = null;
  }

  const identifiers = [];
  if (gtin) {
    identifiers.push({ namespace: 'gtin', value: gtin, evidence: 'historical-gtin' });
  }
  if (canonicalUrl) {
    identifiers.push({ namespace: 'url', value: canonicalUrl, evidence: 'historical-product-url' });
  }

  return {
    identityKey,
    identifiers,
    identity: {
      name: product.name,
      brand: product.brand,
      category: product.category,
      variant: {},
      variantSignature: variantSignature({}),
    },
    gtinInvalid: Boolean(product.gtin && !gtin),
    urlInvalid: Boolean(rawUrl && !canonicalUrl),
    canonicalUrl,
  };
}

async function loadProducts(client) {
  const result = await client.query(`
    SELECT id, source_id, product_url, gtin, name, brand, category, identity_key
      FROM products
     ORDER BY id
  `);
  return result.rows;
}

function buildPlan(products) {
  const plan = [];
  const problems = [];
  const aliasOwner = new Map();

  for (const product of products) {
    const identity = identityForProduct(product);
    plan.push({ product, identity });

    if (identity.gtinInvalid) {
      problems.push({
        kind: 'gtin-invalide',
        productId: Number(product.id),
        detail: `GTIN historique invalide conservé tel quel : ${product.gtin}`,
      });
    }
    if (identity.urlInvalid) {
      problems.push({
        kind: 'url-historique-invalide',
        productId: Number(product.id),
        detail: `URL historique non canonisable : ${product.product_url}`,
      });
    }
    if (!identity.identityKey) {
      problems.push({
        kind: 'identite-historique-insuffisante',
        productId: Number(product.id),
        detail: 'Ni GTIN valide ni URL de fiche produit : réconciliation refusée, aucune provenance historique ne sera inventée.',
      });
    }

    for (const identifier of identity.identifiers) {
      const key = `${identifier.namespace}\u0000${product.source_id}\u0000${identifier.value}`;
      if (aliasOwner.has(key)) {
        problems.push({
          kind: 'alias-collision',
          namespace: identifier.namespace,
          value: identifier.value,
          sourceId: product.source_id,
          productIds: [aliasOwner.get(key), Number(product.id)],
        });
      } else {
        aliasOwner.set(key, Number(product.id));
      }
    }
  }

  const byGtin = new Map();
  for (const entry of plan) {
    if (!entry.identity.identityKey?.startsWith('g:')) continue;
    const key = `${entry.product.source_id}\u0000${entry.identity.identityKey}`;
    if (byGtin.has(key)) {
      problems.push({
        kind: 'gtin-partage',
        sourceId: entry.product.source_id,
        gtin: entry.identity.identityKey.slice(2),
        productIds: [byGtin.get(key), Number(entry.product.id)],
      });
    } else {
      byGtin.set(key, Number(entry.product.id));
    }
  }

  const identityOwner = new Map();
  const fallbackOwner = new Map();
  for (const entry of plan) {
    if (!entry.identity.identityKey) continue;
    const key = `${entry.product.source_id}\u0000${entry.identity.identityKey}`;
    const map = entry.identity.identityKey?.startsWith('f:') ? fallbackOwner : identityOwner;
    if (map.has(key) && map.get(key) !== Number(entry.product.id)) {
      problems.push({
        kind: entry.identity.identityKey?.startsWith('f:') ? 'fallback-identity-collision' : 'identity-key-collision',
        identityKey: entry.identity.identityKey,
        sourceId: entry.product.source_id,
        productIds: [map.get(key), Number(entry.product.id)],
      });
    } else {
      map.set(key, Number(entry.product.id));
    }
  }

  return { plan, problems };
}

async function schemaVersion(client) {
  const result = await client.query(`
    SELECT CASE WHEN to_regclass('schema_state') IS NULL THEN NULL
                ELSE (SELECT version FROM schema_state WHERE singleton) END AS version
  `);
  return result.rows[0]?.version ?? null;
}

async function countObservations(client) {
  const result = await client.query('SELECT COUNT(*)::bigint AS total FROM price_observations');
  return BigInt(result.rows[0].total);
}

async function collectValidationProblems(client) {
  const problems = [];
  const schemaProblems = await client.query('SELECT problem FROM identity_schema_problems() AS problem');
  const dataProblems = await client.query('SELECT problem FROM identity_data_problems() AS problem');
  for (const row of schemaProblems.rows) problems.push({ kind: 'schema-validation', detail: row.problem });
  for (const row of dataProblems.rows) problems.push({ kind: 'data-validation', detail: row.problem });

  const placesFunction = await client.query(
    "SELECT to_regprocedure('places_schema_problems()') IS NOT NULL AS available",
  );
  if (!placesFunction.rows[0]?.available) {
    problems.push({
      kind: 'places-schema-validation',
      detail: 'Migration 20261120_002_places_offers.sql absente : places_schema_problems() indisponible.',
    });
  } else {
    const placesProblems = await client.query('SELECT problem FROM places_schema_problems() AS problem');
    for (const row of placesProblems.rows) {
      problems.push({ kind: 'places-schema-validation', detail: row.problem });
    }
  }
  return problems;
}

async function runAudit(client) {
  const version = await schemaVersion(client);
  if (version === null || version < 1) {
    return { ok: false, exitCode: 2, report: { version, error: 'schéma antérieur à la version 1' } };
  }
  const products = await loadProducts(client);
  const { plan, problems } = buildPlan(products);
  problems.push(...await collectValidationProblems(client));
  if (version >= 2) {
    return {
      ok: problems.length === 0,
      exitCode: problems.length === 0 ? 0 : 2,
      report: { version, mode: 'audit', alreadyReconciled: true, products: products.length, problems },
    };
  }
  return {
    ok: problems.length === 0,
    exitCode: problems.length === 0 ? 0 : 2,
    report: {
      version,
      mode: 'audit',
      products: products.length,
      gtinValides: plan.filter((entry) => entry.identity.identityKey?.startsWith('g:')).length,
      urlIdentities: plan.filter((entry) => entry.identity.identityKey?.startsWith('u:')).length,
      fallbackIdentities: plan.filter((entry) => entry.identity.identityKey?.startsWith('f:')).length,
      problems,
    },
  };
}

async function runExecute(client) {
  const version = await schemaVersion(client);
  if (version === null || version < 1) {
    return { exitCode: 3, report: { error: 'schéma antérieur à la version 1' } };
  }
  if (version >= 2) {
    const problems = await collectValidationProblems(client);
    return {
      exitCode: problems.length === 0 ? 0 : 3,
      report: { alreadyReconciled: true, version, problems },
    };
  }

  await client.query('BEGIN');

  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ADVISORY_LOCK]);
    const locked = await client.query(
      'SELECT version FROM schema_state WHERE singleton FOR UPDATE',
    );
    if (locked.rows[0]?.version !== 1) {
      throw new Error(`Version inattendue après verrouillage : ${locked.rows[0]?.version}`);
    }

    const before = await countObservations(client);
    const products = await loadProducts(client);
    const { plan, problems } = buildPlan(products);
    problems.push(...await collectValidationProblems(client));
    if (problems.length) {
      await client.query('ROLLBACK');
      return { exitCode: 3, report: { refused: true, problems } };
    }

    let identifiersWritten = 0;
    for (const entry of plan) {
      await client.query(
        `UPDATE products
            SET identity_key=$2,
                identity=$3::jsonb,
                product_url=$4,
                gtin=$5
          WHERE id=$1`,
        [
          entry.product.id,
          entry.identity.identityKey,
          JSON.stringify(entry.identity.identity),
          entry.identity.canonicalUrl,
          entry.identity.identifiers.find((identifier) => identifier.namespace === 'gtin')?.value ?? null,
        ],
      );

      for (const identifier of entry.identity.identifiers) {
        const inserted = await client.query(
          `INSERT INTO product_identifiers (product_id, namespace, source_id, value, kind, evidence, verified)
           VALUES ($1,$2,$3,$4,$5,$6,TRUE)
           ON CONFLICT (namespace, source_id, value) DO NOTHING
           RETURNING id`,
          [
            entry.product.id,
            identifier.namespace,
            entry.product.source_id,
            identifier.value,
            ((entry.identity.identityKey?.startsWith('g:') && identifier.namespace === 'gtin')
              || (entry.identity.identityKey?.startsWith('u:') && identifier.namespace === 'url'))
              ? 'primary' : 'secondary',
            identifier.evidence,
          ],
        );
        if (inserted.rows[0]) identifiersWritten += 1;
        else {
          const owner = await client.query(
            `SELECT product_id FROM product_identifiers
              WHERE namespace=$1 AND source_id=$2 AND value=$3`,
            [identifier.namespace, entry.product.source_id, identifier.value],
          );
          if (Number(owner.rows[0]?.product_id) !== Number(entry.product.id)) {
            throw new Error(
              `Collision d'alias pendant l'écriture : ${identifier.namespace}:${identifier.value}`,
            );
          }
        }
      }
    }

    const missingIdentity = await client.query(
      'SELECT COUNT(*)::int AS total FROM products WHERE identity_key IS NULL',
    );
    if (missingIdentity.rows[0].total !== 0) {
      throw new Error(`${missingIdentity.rows[0].total} produits sans identity_key après écriture.`);
    }

    const danglingAliases = await client.query(`
      SELECT COUNT(*)::int AS total
        FROM product_identifiers pi
        LEFT JOIN products p ON p.id=pi.product_id
       WHERE p.id IS NULL
    `);
    if (danglingAliases.rows[0].total !== 0) {
      throw new Error('Alias orphelins détectés après écriture.');
    }

    const after = await countObservations(client);
    if (after !== before) {
      throw new Error(`Perte d'observations détectée : ${before} avant, ${after} après.`);
    }

    const finalProblems = await collectValidationProblems(client);
    if (finalProblems.length) {
      throw new Error(`Validation finale impossible : ${finalProblems.map((problem) => problem.detail).join('; ')}`);
    }

    const openAnomalies = await client.query(
      'SELECT COUNT(*)::int AS total FROM product_identity_anomalies WHERE reviewed_at IS NULL',
    );

    const versionUpdate = await client.query(
      'UPDATE schema_state SET version=2, updated_at=NOW() WHERE singleton',
    );
    if (versionUpdate.rowCount !== 1) {
      throw new Error(`Mise à jour schema_state inattendue : ${versionUpdate.rowCount} ligne(s).`);
    }

    // Revalidation après le passage en version 2 : les contrôles dépendant de
    // la version (identity_key obligatoire, GTIN-14 canonique) doivent aussi
    // réussir avant le COMMIT final.
    const versionTwoProblems = await collectValidationProblems(client);
    if (versionTwoProblems.length) {
      throw new Error(
        `Validation version 2 impossible : ${versionTwoProblems.map((problem) => problem.detail).join('; ')}`,
      );
    }

    await client.query('COMMIT');
    return {
      exitCode: 0,
      report: {
        version: 2,
        products: products.length,
        identifiersWritten,
        observationsPreserved: Number(after),
        openAnomalies: openAnomalies.rows[0].total,
      },
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { exitCode: 3, report: { error: error.message } };
  }
}

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = mode === 'audit'
      ? await runAudit(client)
      : await runExecute(client);
    console.log(JSON.stringify({ mode, ...result.report }, null, 2));
    process.exitCode = result.exitCode;
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error('Réconciliation impossible:', error.message);
  process.exitCode = 3;
});
