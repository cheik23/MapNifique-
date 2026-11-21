import { PlaywrightCrawler } from 'crawlee';
import { extractProducts, compileProductPattern } from './extract.js';
import { isSameOrigin } from './url-policy.js';
import { parseBoundedInteger } from './numeric.js';
import { updateJobCountersFenced } from './db.js';
import { stageProducts } from './stage.js';
import { config } from './config.js';
import { bindLeaseAbortSignal } from './crawler-control.js';

function validateStartUrls(urls, baseUrl) {
  const clean = [];
  for (const value of urls) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('Seules les adresses HTTP/HTTPS sont acceptées.');
    }
    if (!isSameOrigin(url.toString(), baseUrl)) {
      throw new Error('Une URL ne correspond pas au domaine de l’enseigne configurée.');
    }
    clean.push(url.toString());
  }
  return [...new Set(clean)];
}

function sourceOptions(source) {
  const selectors = source.selectors && typeof source.selectors === 'object' ? source.selectors : {};
  return {
    selectors,
    stripParams: Array.isArray(selectors.stripParams) ? selectors.stripParams : undefined,
    keepParams: Array.isArray(selectors.keepParams) ? selectors.keepParams : undefined,
  };
}

function isCritical(error) {
  return error?.code === 'MN001' || error?.code === 'MN002' || error?.code === 'MN003';
}

/**
 * Collecte une source. Toute erreur critique (budget, lease, anomalie d'identité,
 * échec technique) interrompt le crawler et remonte : le worker marque le job failed.
 * Les erreurs de page sont comptées et tolérées jusqu'à config.maxPageFailures.
 */
export async function runCrawlJob(job, source, { signal = new AbortController().signal, pool } = {}) {
  const startUrls = validateStartUrls(job.start_urls, source.base_url);
  const productPattern = compileProductPattern(source.product_url_regex);
  const sourceMaxPages = parseBoundedInteger(source.max_pages_per_run, {
    fallback: config.defaultMaxPages, min: 1, max: config.hardMaxPages, label: 'max_pages_per_run',
  });
  const requestedMaxPages = parseBoundedInteger(job.max_pages, {
    fallback: sourceMaxPages, min: 1, max: config.hardMaxPages, label: 'max_pages',
  });
  const maxPages = Math.min(requestedMaxPages, sourceMaxPages, config.hardMaxPages);
  const maxRequestsPerMinute = parseBoundedInteger(source.requests_per_minute, {
    fallback: config.defaultRequestsPerMinute, min: 1, max: 120, label: 'requests_per_minute',
  });
  const sameDomainDelaySecs = parseBoundedInteger(source.same_domain_delay_secs, {
    fallback: config.defaultSameDomainDelaySecs, min: 1, max: 60, label: 'same_domain_delay_secs',
  });
  const { selectors, stripParams, keepParams } = sourceOptions(source);
  const failureBudget = config.maxPageFailures;

  let pagesSeen = 0;
  let skippedByRobots = 0;
  let pageFailures = 0;
  let extractionFailures = 0;
  let stagedObservations = 0;
  let fatalError = null;

  const stop = (error) => {
    if (!fatalError) fatalError = error;
    // Interrompt la file Crawlee sans attendre la fin des requêtes restantes.
    try {
      crawler?.autoscaledPool?.abort?.();
    } catch {
      // L'abandon est une optimisation : l'erreur est de toute façon propagée.
    }
  };

  const crawler = new PlaywrightCrawler({
    headless: true,
    minConcurrency: 1,
    maxConcurrency: config.defaultMaxConcurrency,
    maxRequestsPerMinute,
    sameDomainDelaySecs,
    maxRequestsPerCrawl: maxPages,
    maxRequestRetries: config.requestRetryLimit,
    navigationTimeoutSecs: config.navigationTimeoutSecs,
    requestHandlerTimeoutSecs: config.requestHandlerTimeoutSecs,
    respectRobotsTxtFile: true,
    // Ne jamais activer retryOnBlocked : pas de contournement de CAPTCHA.
    retryOnBlocked: false,

    async requestHandler({ page, request, enqueueLinks, log }) {
      if (signal.aborted || fatalError) return;
      pagesSeen += 1;
      await updateJobCountersFenced(job.id, job.lease_token, { pages: 1 });

      const pageUrl = page.url?.() || request.loadedUrl || request.url;
      if (!isSameOrigin(pageUrl, source.base_url)) {
        const error = new Error('Redirection hors origine refusée : aucune donnée de cette page ne sera collectée.');
        error.code = 'MN004';
        stop(error);
        return;
      }
      let products = [];
      try {
        products = await extractProducts(page, pageUrl, selectors, {
          baseUrl: source.base_url,
          productPattern,
          stripParams,
          keepParams,
        });
      } catch (error) {
        extractionFailures += 1;
        log.warning(`Extraction impossible sur ${pageUrl}: ${error.message}`);
        if (extractionFailures > failureBudget) {
          stop(new Error(
            `Extraction en échec sur ${extractionFailures} pages (limite ${failureBudget}).`,
          ));
        }
        return;
      }

      if (signal.aborted || fatalError) return;

      if (products.length) {
        try {
          const counters = await stageProducts({
            pool,
            jobId: job.id,
            leaseToken: job.lease_token,
            sourceId: source.id,
            products,
            budget: config.candidateBudgetPerJob,
            stripParams,
            keepParams,
            defaultCurrency: config.defaultCurrency,
          });
          stagedObservations += counters.observationsAdded;
        } catch (error) {
          // Erreur de données ou de lease : le job ne peut pas continuer proprement.
          stop(error);
          return;
        }
      }

      if (!signal.aborted && !fatalError && productPattern && pagesSeen < maxPages) {
        await enqueueLinks({
          strategy: 'same-domain',
          transformRequestFunction: (candidate) => {
            try {
              const candidateUrl = new URL(candidate.url);
              if (!isSameOrigin(candidateUrl.toString(), source.base_url)) return null;
              if (!productPattern.test(candidateUrl.pathname)) return null;
              return candidate;
            } catch {
              return null;
            }
          },
        });
      }
    },

    async onSkippedRequest({ reason }) {
      if (String(reason || '').toLowerCase().includes('robot')) {
        skippedByRobots += 1;
        try {
          await updateJobCountersFenced(job.id, job.lease_token, { robots: 1 });
        } catch (error) {
          stop(error);
        }
      }
    },

    async failedRequestHandler({ request, error }) {
      pageFailures += 1;
      console.warn(`[scraper] Échec ${request.url}: ${error?.message || 'erreur inconnue'}`);
      if (pageFailures > failureBudget) {
        stop(new Error(
          `Trop d’échecs de page (${pageFailures}, limite ${failureBudget}). Dernière URL : ${request.url}`,
        ));
      }
    },
  });

  const crawlPromise = crawler.run(startUrls);
  const unbindLeaseAbort = bindLeaseAbortSignal(crawler, signal);
  try {
    await crawlPromise;
  } finally {
    await unbindLeaseAbort();
  }

  if (signal.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : Object.assign(new Error('Lease perdue; arrêt de la collecte.'), { code: 'MN002' });
  }
  if (fatalError) throw fatalError;
  if (pageFailures > failureBudget) {
    throw new Error(`Collecte incomplète : ${pageFailures} pages en échec.`);
  }

  return {
    pagesSeen,
    skippedByRobots,
    pageFailures,
    extractionFailures,
    stagedObservations,
    maxPages,
  };
}
