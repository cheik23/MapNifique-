import { initDb, pool } from './db.js';
import { assertPlacesSchemaReady } from './places-api.js';
import { runOfferSource } from './offers-sync.js';
import {
  extractDiscount,
  isEligibleNationalFlyer,
  classifyLidlFlyer,
  parseEnabledOfferSources,
} from './offers-utils.js';
import {
  applyOfferRetention,
  classifyOfferStatus,
  getDateInTimeZone,
} from './offer-validity.js';
import { fetchRespectingRobots } from './robots-policy.js';

const FRANPRIX_HOME = 'https://www.franprix.fr/';
const LIDL_API = 'https://endpoints.leaflets.schwarz/v4';
const INTERVAL_HOURS = Math.max(
  1,
  Math.min(24, Number(process.env.OFFERS_INTERVAL_HOURS || 6))
);
const DRY_RUN = process.env.OFFERS_DRY_RUN === '1';
const ONCE = process.env.OFFERS_ONCE === '1' || DRY_RUN;
const ENABLED_SOURCES = parseEnabledOfferSources(
  process.env.OFFERS_ENABLED_SOURCES,
  process.env.OFFERS_SOURCE_LICENSE_APPROVED,
);


const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const months = {
  janvier: 1, fevrier: 2, mars: 3, avril: 4,
  mai: 5, juin: 6, juillet: 7, aout: 8,
  septembre: 9, octobre: 10, novembre: 11, decembre: 12,
};

function fold(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '');
}

const parisToday = () => getDateInTimeZone();

function decodeEntities(value) {
  const named = {
    amp: '&', quot: '"', apos: "'", '#39': "'", '#x27': "'",
    nbsp: ' ', euro: '€', eacute: 'é', egrave: 'è',
    ecirc: 'ê', agrave: 'à', ugrave: 'ù', ucirc: 'û',
    ccedil: 'ç', rsquo: '’', lsquo: '‘', ndash: '–',
    mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  };

  return String(value || '').replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (whole, entity) => {
      const key = entity.toLowerCase();

      if (key.startsWith('#x')) {
        return String.fromCodePoint(parseInt(key.slice(2), 16));
      }
      if (key.startsWith('#')) {
        return String.fromCodePoint(parseInt(key.slice(1), 10));
      }
      return named[key] ?? whole;
    }
  );
}

function htmlText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function metaContent(html, wanted) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attr = name =>
      tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1];

    if (
      String(attr('property') || attr('name') || '').toLowerCase() ===
      wanted.toLowerCase()
    ) {
      return decodeEntities(attr('content') || '');
    }
  }
  return '';
}

function extractLinks(html, base, pathPattern) {
  const links = new Set();

  for (const match of html.matchAll(/\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      const url = new URL(decodeEntities(match[2]), base);

      if (
        url.protocol === 'https:' &&
        url.hostname === 'www.franprix.fr' &&
        pathPattern.test(url.pathname)
      ) {
        url.hash = '';
        links.add(url.toString());
      }
    } catch {
      // Lien invalide ignoré.
    }
  }

  return [...links];
}

function parseFranprixDates(text) {
  const pattern =
    /valable\s+du\s+(\d{1,2})\s+([\p{L}]+)(?:\s+(\d{4}))?\s+au\s+(\d{1,2})\s+([\p{L}]+)\s+(\d{4})/iu;

  const match = text.match(pattern);
  if (!match) return { validFrom: null, validUntil: null };

  const startMonth = months[fold(match[2])];
  const endMonth = months[fold(match[5])];
  const endYear = Number(match[6]);
  let startYear = Number(match[3] || endYear);

  if (!startMonth || !endMonth || !endYear) {
    return { validFrom: null, validUntil: null };
  }

  if (!match[3] && startMonth > endMonth) startYear -= 1;

  const date = (year, month, day) =>
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  return {
    validFrom: date(startYear, startMonth, Number(match[1])),
    validUntil: date(endYear, endMonth, Number(match[4])),
  };
}

async function fetchText(url) {
  const response = await fetchRespectingRobots(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'user-agent': 'MapNifique/2.0',
      accept: 'text/html,application/xhtml+xml',
    },
  });

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`HTTP ${response.status} pour ${url}`);
  }

  return response.text();
}

async function fetchJson(url) {
  const response = await fetchRespectingRobots(url, {
    signal: AbortSignal.timeout(20000),
    headers: {
      'user-agent': 'MapNifique/2.0',
      accept: 'application/json',
    },
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} pour ${url}`);

  const data = await response.json();
  if (data.success === false) {
    throw new Error(data.message || 'Réponse invalide du flux Lidl.');
  }

  return data;
}

async function collectFranprix() {
  console.log('[Franprix] Recherche des pages promotionnelles...');

  const home = await fetchText(FRANPRIX_HOME);

  const sliders = extractLinks(
    home,
    FRANPRIX_HOME,
    /^\/promotions\/slider\//
  ).slice(0, 10);

  const pagesToScan = [FRANPRIX_HOME, ...sliders];
  const promotionUrls = new Set(
    extractLinks(home, FRANPRIX_HOME, /^\/promotion\//)
  );
  const warnings = [];

  for (const pageUrl of pagesToScan.slice(1)) {
    try {
      const html = await fetchText(pageUrl);
      for (const url of extractLinks(html, pageUrl, /^\/promotion\//)) {
        promotionUrls.add(url);
      }
    } catch (error) {
      warnings.push(error.message);
    }
    await sleep(350);
  }

  const urls = [...promotionUrls].slice(0, 100);
  if (!urls.length) {
    throw new Error('Aucune page promotionnelle trouvée sur Franprix.');
  }

  console.log(`[Franprix] ${urls.length} pages détectées.`);

  const offers = [];

  for (const url of urls) {
    try {
      const html = await fetchText(url);
      const title = metaContent(html, 'og:title');
      const metaDescription = metaContent(html, 'og:description');
      const text = htmlText(html);

      if (!title || !/en promotion/i.test(title)) {
        warnings.push(`Titre promotion non reconnu : ${url}`);
        continue;
      }

      const { validFrom, validUntil } = parseFranprixDates(text);
      const status = classifyOfferStatus(validFrom, validUntil, parisToday());
      const titleIndex = text.toLowerCase().indexOf(title.toLowerCase());
      const offerContext = titleIndex >= 0
        ? text.slice(titleIndex, titleIndex + 2500)
        : text.slice(0, 2500);
      const excerpt = offerContext.slice(0, 950);
      const discountLabel = extractDiscount(offerContext);

      const terms = [];
      if (validFrom && validUntil) {
        terms.push(`Valable du ${validFrom} au ${validUntil}.`);
      } else {
        terms.push('Dates exactes non reconnues : offre conservée en brouillon.');
      }
      if (/magasins participants/i.test(text)) {
        terms.push('Disponibilité sous réserve des magasins participants à l’opération.');
      }
      if (/carte bibi/i.test(text)) {
        terms.push('Certains avantages nécessitent la carte de fidélité bibi.');
      }

      const pathId = new URL(url).pathname.split('/').filter(Boolean).at(-1);
      if (!pathId || pathId.length > 160) {
        warnings.push(`Identifiant officiel absent; offre ignorée : ${url}`);
        continue;
      }
      const externalId = pathId;

      offers.push({
        sourceId: 'official-franprix',
        externalId,
        brandKey: 'franprix',
        title: title.slice(0, 180),
        description: excerpt.slice(0, 950),
        offerType: 'promotion',
        scope: 'brand',
        discountLabel,
        promoCode: null,
        landingUrl: url,
        sourceUrl: url,
        sourceName: 'Franprix',
        terms: terms.join(' '),
        validFrom,
        validUntil,
        status,
        verifiedAt: status === 'active' ? new Date().toISOString() : null,
      });
    } catch (error) {
      warnings.push(error.message);
    }

    await sleep(350);
  }

  if (!offers.length) {
    throw new Error(
      `Aucune promotion Franprix exploitable. ${warnings.slice(0, 3).join(' | ')}`
    );
  }

  return { offers, warnings, details: { pagesFound: urls.length } };
}

async function collectLidl() {
  console.log('[Lidl] Lecture du flux officiel des catalogues...');

  const overview = await fetchJson(
    `${LIDL_API}/overview?client_locale=${encodeURIComponent('lidl/fr-FR')}`
  );

  const flyers = [];
  const visited = new Set();

  function scan(value) {
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);

    if (value.flyerJson && Array.isArray(value.regions)) flyers.push(value);

    if (Array.isArray(value)) value.forEach(scan);
    else Object.values(value).forEach(scan);
  }

  scan(overview);

  const today = parisToday();

  const candidates = flyers
    .filter(flyer => isEligibleNationalFlyer(flyer, today))
    .sort((a, b) =>
      a.offerStartDate.localeCompare(b.offerStartDate) ||
      String(a.id).localeCompare(String(b.id))
    );

  if (!candidates.length) {
    throw new Error('Aucun catalogue national Lidl éligible.');
  }

  console.log(`[Lidl] ${candidates.length} catalogues éligibles.`);

  const offers = [];
  const warnings = [];
  let totalProducts = 0;

  const safeUrl = (value, base = 'https://www.lidl.fr') => {
    try {
      const url = new URL(String(value || ''), base);
      return url.protocol === 'https:' ? url.href : null;
    } catch {
      return null;
    }
  };

  for (const candidate of candidates) {
    try {
      const result = await fetchJson(candidate.flyerJson);
      const flyer = result.flyer;

      if (!flyer || !Array.isArray(flyer.pages)) {
        throw new Error(`Format catalogue non reconnu : ${candidate.id}`);
      }

      const validFrom = candidate.offerStartDate || flyer.offerStartDate || flyer.startDate;
      const validUntil = candidate.offerEndDate || flyer.offerEndDate || flyer.endDate;

      const classification = classifyLidlFlyer(candidate);

      const catalogItems = Object.values(flyer.products || {})
        .filter(product => product && typeof product === 'object')
        .map(product => {
          const imageUrl = safeUrl(product.image);
          let productUrl = safeUrl(product.url || product.canonicalUrl);

          if (
            productUrl &&
            !/(^|\.)lidl\.fr$/i.test(new URL(productUrl).hostname)
          ) {
            productUrl = null;
          }

          const rawPrice = String(product.price ?? '').trim().replace(',', '.');
          const price = rawPrice ? Number(rawPrice) : null;

          return {
            externalId: String(product.productId || ''),
            title: String(product.title || '').trim().slice(0, 180),
            brand: String(product.brand || '').trim().slice(0, 100),
            price: price !== null && Number.isFinite(price) && price >= 0
              ? price
              : null,
            currency: 'EUR',
            category: String(
              product.categoryPrimary || product.wonCategoryPrimary || ''
            ).slice(0, 180),
            imageUrl,
            productUrl,
            description: String(product.description || '').slice(0, 700),
          };
        })
        .filter(item => item.title);

      totalProducts += catalogItems.length;

      const status = classifyOfferStatus(validFrom, validUntil, parisToday());

      offers.push({
        sourceId: 'official-lidl',
        externalId: `flyer:${candidate.id}`,
        brandKey: 'lidl',
        title: `Catalogue Lidl — ${candidate.title || 'Promotions'} (${candidate.name || ''})`,
        description:
          `${flyer.pages.length} pages et ${catalogItems.length} articles récupérés du catalogue officiel.`,
        catalogItems,
        offerType: 'promotion',
        scope: classification.scope,
        discountLabel: classification.discountLabel,
        promoCode: null,
        landingUrl: candidate.flyerUrlAbsolute,
        sourceUrl: candidate.flyerUrlAbsolute,
        sourceName: 'Lidl France',
        terms: classification.terms,
        validFrom,
        validUntil,
        status,
        verifiedAt: status === 'active' ? new Date().toISOString() : null,
      });

      console.log(
        `[Lidl] ${candidate.title} — ${catalogItems.length} articles — ` +
        `${classification.scope} — ${status}.`
      );
    } catch (error) {
      warnings.push(`${candidate.title || candidate.id}: ${error.message}`);
    }

    await sleep(250);
  }

  if (!offers.length) {
    throw new Error(
      `Aucun catalogue Lidl exploitable. ${warnings.slice(0, 3).join(' | ')}`
    );
  }

  return {
    offers,
    warnings,
    details: {
      cataloguesDetected: candidates.length,
      cataloguesCollected: offers.length,
      products: totalProducts,
      catalogues: offers.map(offer => ({
        externalId: offer.externalId,
        title: offer.title,
        scope: offer.scope,
        status: offer.status,
        products: offer.catalogItems.length,
      })),
    },
  };
}

async function expireOffers() {
  if (DRY_RUN) return;
  const result = await applyOfferRetention(pool, parisToday());

  console.log(
    `[rétention] date=${parisToday()} expirées=${result.expired} supprimées=${result.deleted} cutoff=${result.cutoffDate}`,
  );
}

async function runAll() {
  console.log(`\n========== COLLECTE OFFRES ${new Date().toISOString()} ==========`);
  console.log(DRY_RUN ? 'MODE SIMULATION : aucune offre enregistrée.' : 'MODE COLLECTE CONFIGURÉE.');
  if (!ENABLED_SOURCES.size) {
    console.log('[sources] Collecte désactivée : aucune source explicitement autorisée.');
  }

  const failures = [];
  if (stopping) {
    console.log('[scheduler] Arrêt demandé : aucune nouvelle collecte ne sera lancée.');
  } else if (ENABLED_SOURCES.has('franprix')) {
    const result = await runOfferSource({
      db: pool, sourceId: 'official-franprix', collector: collectFranprix,
      dryRun: DRY_RUN, logger: console,
    });
    if (!result.ok) failures.push(result);
  } else {
    console.log('[official-franprix] Source désactivée.');
  }

  if (!stopping && ENABLED_SOURCES.has('lidl')) {
    const result = await runOfferSource({
      db: pool, sourceId: 'official-lidl', collector: collectLidl,
      dryRun: DRY_RUN, logger: console,
    });
    if (!result.ok) failures.push(result);
  } else if (!stopping) {
    console.log('[official-lidl] Source désactivée.');
  } else {
    console.log('[official-lidl] Collecte ignorée pendant l’arrêt.');
  }

  try {
    await expireOffers();
  } catch (error) {
    failures.push({ sourceId: 'retention', ok: false, error: error.message });
    console.error('[rétention] Échec :', error.message);
  }

  console.log('========== FIN COLLECTE ==========\n');
  return { ok: failures.length === 0, failures };
}

let stopping = false;
let timer = null;
let wakeSleep = null;

function stop() {
  stopping = true;
  if (timer) clearTimeout(timer);
  if (wakeSleep) wakeSleep();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function main() {
  await initDb();
  await assertPlacesSchemaReady(pool);

  const initial = await runAll();
  if (ONCE && !initial.ok) process.exitCode = 1;

  if (ONCE) return;

  console.log(`[scheduler] Prochaine collecte dans ${INTERVAL_HOURS} heure(s).`);

  while (!stopping) {
    await new Promise(resolve => {
      wakeSleep = resolve;
      timer = setTimeout(resolve, INTERVAL_HOURS * 60 * 60 * 1000);
    });

    timer = null;
    wakeSleep = null;

    if (!stopping) {
      const result = await runAll();
      if (!result.ok) console.error(`[scheduler] ${result.failures.length} échec(s); nouvelle tentative au prochain cycle.`);
    }
  }
}

main()
  .catch(error => {
    console.error('[offers-worker] Erreur fatale :', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Fermer le pool aussi après un arrêt planifié du scheduler, pas seulement en mode ONCE.
    await pool.end().catch(() => {});
  });
