import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

const { Pool } = pg;

export const REQUIRED_SCHEMA_VERSION = 2;

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
});

function schemaNotReady(version, cause) {
  const error = new Error(
    version === null
      ? 'Schéma MapNifique absent. Applique migrations/20261120_000_baseline_schema.sql, 001, 002_places_offers.sql, puis la réconciliation contrôlée.'
      : `Schéma MapNifique en version ${version}; la version ${REQUIRED_SCHEMA_VERSION} est requise.`,
  );
  error.code = 'SCHEMA_NOT_READY';
  error.version = version;
  if (cause) error.cause = cause;
  return error;
}

function leaseLost(message) {
  const error = new Error(message);
  error.code = 'MN002';
  return error;
}

export async function getSchemaVersion(db = pool) {
  const result = await db.query(`
    SELECT CASE
             WHEN to_regclass('schema_state') IS NULL THEN NULL
             ELSE (SELECT version FROM schema_state WHERE singleton)
           END AS version
  `);
  return result.rows[0]?.version ?? null;
}

/**
 * Aucun DDL implicite : le schéma est créé exclusivement par les migrations
 * manuelles. L'API et le worker refusent de démarrer hors version 2.
 */
export async function assertSchemaReady(db = pool) {
  let version;
  try {
    version = await getSchemaVersion(db);
  } catch (error) {
    throw schemaNotReady(null, error);
  }
  if (version !== REQUIRED_SCHEMA_VERSION) throw schemaNotReady(version);
  return version;
}

export async function initDb() {
  await assertSchemaReady();
}

export async function claimNextJob(db = pool) {
  await db.query(`
    UPDATE scrape_jobs
       SET status='failed', finished_at=NOW(),
           error=COALESCE(error,'Worker heartbeat expired after maximum attempts'),
           lease_token=NULL
     WHERE status='running'
       AND attempts >= $1
       AND COALESCE(heartbeat_at,started_at) <= NOW() - ($2::double precision * INTERVAL '1 millisecond')
  `, [config.workerJobMaxAttempts, config.workerJobLeaseMs]);

  const leaseToken = randomUUID();
  const result = await db.query(`
    WITH candidate AS (
      SELECT id FROM scrape_jobs
       WHERE (status='queued' AND attempts < $1)
          OR (status='failed' AND attempts < $1 AND finished_at IS NOT NULL
              AND finished_at <= NOW() - ($2::double precision * INTERVAL '1 millisecond'))
          OR (status='running' AND attempts < $1
              AND COALESCE(heartbeat_at,started_at) <= NOW() - ($3::double precision * INTERVAL '1 millisecond'))
       ORDER BY CASE WHEN status='queued' THEN 0 ELSE 1 END, created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE scrape_jobs AS job
       SET status='running',
           started_at=COALESCE(job.started_at,NOW()),
           heartbeat_at=NOW(),
           lease_token=$4,
           attempts=job.attempts+1,
           error=NULL,
           finished_at=NULL
      FROM candidate
     WHERE job.id=candidate.id
    RETURNING job.*
  `, [config.workerJobMaxAttempts, config.workerJobRetryDelayMs, config.workerJobLeaseMs, leaseToken]);
  return result.rows[0] || null;
}

export async function refreshJobHeartbeat(jobId, leaseToken, db = pool) {
  const result = await db.query(`
    UPDATE scrape_jobs SET heartbeat_at=NOW()
     WHERE id=$1 AND status='running' AND lease_token=$2
  `, [jobId, leaseToken]);
  return result.rowCount > 0;
}

export async function updateJobCounters(jobId, { pages = 0, products = 0, robots = 0 } = {}, db = pool) {
  await db.query(`
    UPDATE scrape_jobs SET
      pages_seen = pages_seen + $2,
      products_found = products_found + $3,
      skipped_by_robots = skipped_by_robots + $4
    WHERE id=$1
  `, [jobId, pages, products, robots]);
}

/** Compteurs de progression vérifiés par lease : une perte de lease arrête le crawler. */
export async function updateJobCountersFenced(jobId, leaseToken, { pages = 0, products = 0, robots = 0 } = {}, db = pool) {
  const result = await db.query(`
    UPDATE scrape_jobs SET
      pages_seen = pages_seen + $3,
      products_found = products_found + $4,
      skipped_by_robots = skipped_by_robots + $5,
      heartbeat_at = NOW()
    WHERE id=$1 AND status='running' AND lease_token=$2
  `, [jobId, leaseToken, pages, products, robots]);
  if (!result.rowCount) throw leaseLost(`Lease du job ${jobId} perdue pendant la collecte.`);
  return true;
}

export async function markJobCompleted(jobId, leaseToken, { products = 0 } = {}, db = pool) {
  const result = await db.query(`
    UPDATE scrape_jobs
       SET status='completed', finished_at=NOW(), heartbeat_at=NOW(),
           products_found=$3, lease_token=NULL, error=NULL
     WHERE id=$1 AND status='running' AND lease_token=$2
  `, [jobId, leaseToken, products]);
  if (!result.rowCount) throw leaseLost(`Lease du job ${jobId} perdue avant la clôture.`);
  return true;
}

export async function failJob(jobId, leaseToken, message, db = pool) {
  const result = await db.query(`
    UPDATE scrape_jobs
       SET status='failed', finished_at=NOW(), error=$3, lease_token=NULL
     WHERE id=$1 AND status='running' AND lease_token=$2
  `, [jobId, leaseToken, String(message || 'erreur inconnue').slice(0, 2000)]);
  return result.rowCount > 0;
}

/** Arrêt demandé : le job redevient immédiatement réclamable, sans attendre le lease. */
export async function releaseJobLease(jobId, leaseToken, db = pool) {
  const result = await db.query(`
    UPDATE scrape_jobs
       SET status='queued', finished_at=NULL, heartbeat_at=NULL, lease_token=NULL, error=NULL
     WHERE id=$1 AND status='running' AND lease_token=$2
  `, [jobId, leaseToken]);
  return result.rowCount > 0;
}

export async function purgeStaleCandidates({
  retentionDays = config.candidateRetentionDays,
  anomalyArchiveDays = config.anomalyArchiveDays,
  db = pool,
} = {}) {
  const result = await db.query(
    'SELECT * FROM identity_purge_stale_candidates($1,$2)',
    [retentionDays, anomalyArchiveDays],
  );
  return result.rows[0] || null;
}
