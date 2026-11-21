import {
  initDb,
  pool,
  claimNextJob,
  refreshJobHeartbeat,
  markJobCompleted,
  failJob,
  releaseJobLease,
  purgeStaleCandidates,
} from './db.js';
import { config } from './config.js';
import { runCrawlJob } from './crawler.js';
import { finalizeJob } from './stage.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let stopping = false;
let active = null;
let lastPurgeAt = 0;

function requestStop(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal} recu : arret demande, collecte active interrompue.`);
  if (active) active.controller.abort(new Error('Arret demande par le systeme.'));
}

process.on('SIGINT', () => requestStop('SIGINT'));
process.on('SIGTERM', () => requestStop('SIGTERM'));

async function maybePurge() {
  const now = Date.now();
  if (now - lastPurgeAt < 60 * 60 * 1000) return;
  lastPurgeAt = now;
  try {
    const result = await purgeStaleCandidates();
    if (result) console.log('[worker] Purge:', JSON.stringify(result));
  } catch (error) {
    console.error('[worker] Purge impossible:', error.message);
  }
}

async function main() {
  await initDb();
  console.log('[worker] Pret. Un job a la fois; la concurrence navigateur reste limitee a 2.');
  await maybePurge();

  while (!stopping) {
    let job;
    try {
      job = await claimNextJob();
    } catch (error) {
      console.error('[worker] Erreur lecture file:', error.message);
      await sleep(config.workerPollMs);
      continue;
    }

    if (!job) {
      await maybePurge();
      await sleep(config.workerPollMs);
      continue;
    }

    const controller = new AbortController();
    active = { job, controller };

    const heartbeat = setInterval(() => {
      refreshJobHeartbeat(job.id, job.lease_token).then((owned) => {
        if (!owned && !controller.signal.aborted) {
          console.error(`[worker] Lease du job ${job.id} perdue; arret de la collecte.`);
          controller.abort(Object.assign(new Error('Lease du job perdue.'), { code: 'MN002' }));
        }
      }).catch((error) => {
        console.error(`[worker] Heartbeat du job ${job.id} impossible:`, error.message);
        if (!controller.signal.aborted) {
          controller.abort(Object.assign(
            new Error('Heartbeat impossible; arret de la collecte par securite.'),
            { code: 'MN002' },
          ));
        }
      });
    }, config.workerJobHeartbeatMs);
    heartbeat.unref();

    try {
      const sourceResult = await pool.query(
        `SELECT * FROM sources WHERE id=$1 AND enabled=TRUE AND license_approved=TRUE AND license_reviewed_at IS NOT NULL AND BTRIM(license_review_note) <> ''`,
        [job.source_id],
      );
      const source = sourceResult.rows[0];
      if (!source) throw new Error('Source absente ou desactivee.');

      const stats = await runCrawlJob(job, source, { signal: controller.signal, pool });
      const result = await finalizeJob({ pool, jobId: job.id, leaseToken: job.lease_token });
      await markJobCompleted(job.id, job.lease_token, { products: result.products });

      console.log(
        `[worker] Job ${job.id} termine: ${stats.pagesSeen} pages, `
        + `${result.products} produits definitifs, ${result.observations} observations, `
        + `${stats.skippedByRobots} URL ignorees par robots.txt, ${stats.pageFailures} pages en echec.`,
      );
    } catch (error) {
      if (error.code === 'MN002') {
        console.error(`[worker] Job ${job.id} abandonne: ${error.message}`);
      } else if (stopping) {
        await releaseJobLease(job.id, job.lease_token).catch((releaseError) => {
          console.error(`[worker] Liberation du lease ${job.id} impossible:`, releaseError.message);
        });
        console.log(`[worker] Job ${job.id} remis en file apres arret demande.`);
      } else {
        console.error(`[worker] Job ${job.id} en echec:`, error.stack || error.message);
        await failJob(job.id, job.lease_token, error.message).catch((failError) => {
          console.error('[worker] Marquage en echec impossible:', failError.message);
        });
      }
    } finally {
      clearInterval(heartbeat);
      active = null;
    }
  }

  await pool.end();
  console.log('[worker] Arret termine.');
}

main().catch(async (error) => {
  console.error('[worker] Arret fatal:', error);
  await pool.end().catch(() => {});
  process.exitCode = 1;
});
