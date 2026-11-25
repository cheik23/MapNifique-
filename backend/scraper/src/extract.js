import {
  canonicalizeUrl,
  normalizeCurrency,
  normalizeName,
  textValue,
  variantFromNode,
  variantSignature,
} from './identity.js';
import { isSameOrigin } from './url-policy.js';
export { isSameOrigin };
export const isSameHost = isSameOrigin;

function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function normalizeSchemaType(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const tail = raw.split(/[\/#:]/).filter(Boolean).at(-1) || raw;
  return tail;
}

function typeList(value) {
  return asArray(value?.['@type']).map(normalizeSchemaType).filter(Boolean);
}


function collectNodes(value, matches, found = []) {
  if (!value) return found;
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, matches, found);
    return found;
  }
  if (typeof value !== 'object') return found;
  if (matches(typeList(value), value)) found.push(value);
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'offers') collectNodes(child, matches, found);
  }
  return found;
}

function collectProducts(value, found = []) {
  return collectNodes(
    value,
    (types, node) => types.includes('product')
      || (types.includes('productgroup') && asArray(node.hasVariant).length === 0),
    found,
  );
}

function collectWebPages(value, found = []) {
  return collectNodes(value, (types) => types.includes('webpage'), found);
}

/**
 * Prix monétaire strict :
 * - refuse les multiplications (`2 x 1,50`), fractions et négatifs ;
 * - `1 2` est mal formé, `1 234,56` est accepté ;
 * - les séparateurs de milliers doivent grouper par trois ;
 * - deux décimales maximum.
 */
export function numberPrice(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  let text = String(value).replace(/[\u00a0\u202f]/g, ' ').trim();
  if (!text) return null;
  if (/[x×*]\s*\d/i.test(text)) return null;
  if (/\d\s*\/\s*\d/.test(text)) return null;
  if (/-/.test(text)) return null;

  text = text.replace(/[^\d\s.,]/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const plain = /^\d+(?:[.,]\d{1,2})?$/;
  const grouped = /^\d{1,3}(?:[ .]\d{3})+(?:[.,]\d{1,2})?$/;
  if (!plain.test(text) && !grouped.test(text)) return null;

  let normalized;
  if (text.includes(',')) {
    normalized = text.replace(/[ .](?=\d{3}(?:\D|$))/g, '').replace(',', '.');
  } else if (grouped.test(text)) {
    normalized = text.replace(/[ .]/g, '');
  } else {
    normalized = text;
  }

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function absoluteUrl(value, baseUrl) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function availabilityLabel(value) {
  const text = textValue(value);
  if (!text) return null;
  const tail = text.split('/').at(-1);
  return tail.replace(/([a-z])([A-Z])/g, '$1 $2').trim() || null;
}

function pathOf(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '';
  }
}

function firstText(...values) {
  for (const value of values) {
    const text = textValue(value);
    if (text) return text;
  }
  return null;
}

/**
 * Résout product_url à partir d'une preuve explicite :
 * - `jsonld-product-url` (Product.url) ;
 * - `webpage-mainentity` (@id référencé par WebPage.mainEntity) ;
 * - `css-card-link` (lien de carte produit) ;
 * - `product-url-regex` (page courante reconnue par la source) ;
 * - `product-detail` (sélecteur de fiche validé par la source).
 * Offer.url n'est jamais une preuve. Une page catalogue n'est jamais promue.
 */
export function resolveProductUrl(candidateUrl, {
  pageUrl,
  baseUrl,
  productPattern,
  selectors,
  productDetailPresent = false,
  evidence = null,
} = {}) {
  const host = baseUrl || pageUrl;
  const pageCanonical = canonicalizeUrl(pageUrl, { baseUrl: host });
  const patternMatchesPage = Boolean(productPattern && productPattern.test(pathOf(pageUrl)));
  const pageIsDetail = Boolean(patternMatchesPage || productDetailPresent);
  const pageEvidence = patternMatchesPage ? 'product-url-regex' : 'product-detail';

  if (candidateUrl) {
    if (!isSameOrigin(candidateUrl, host)) {
      return { url: null, evidence: null, rejected: 'cross-origin' };
    }
    const canonical = canonicalizeUrl(candidateUrl, { baseUrl: host });
    if (!canonical) return { url: null, evidence: null, rejected: 'invalid-url' };
    if (canonical === pageCanonical) {
      if (!pageIsDetail) return { url: null, evidence: null, rejected: 'catalogue-page' };
      return { url: pageCanonical, evidence: evidence || pageEvidence };
    }
    return { url: canonical, evidence: evidence || 'product-url' };
  }

  if (pageIsDetail) return { url: pageCanonical, evidence: pageEvidence };
  return { url: null, evidence: null, rejected: 'no-proof' };
}

function regularPriceOf(offer, price) {
  const specification = asArray(offer.priceSpecification)
    .find((item) => item && typeof item === 'object');
  const candidate = numberPrice(specification?.price);
  return candidate !== null && candidate !== price ? candidate : null;
}

/**
 * Parse une liste d'offres. Une AggregateOffer (ou une offre lowPrice/highPrice)
 * ne produit aucune observation individuelle vérifiée.
 */
export function extractOffers(offers) {
  const list = asArray(offers).filter((item) => item && typeof item === 'object' && !Array.isArray(item));
  if (!list.length) {
    return [{ price: null, regularPrice: null, currency: null, availability: null, storeCode: null, aggregate: false }];
  }

  return list.slice(0, 20).map((offer) => {
    const types = typeList(offer);
    const aggregate = types.includes('aggregateoffer')
      || 'lowPrice' in offer
      || 'highPrice' in offer
      || 'offerCount' in offer;
    if (aggregate) {
      return {
        price: null,
        regularPrice: null,
        currency: normalizeCurrency(offer.priceCurrency),
        availability: availabilityLabel(offer.availability),
        storeCode: null,
        aggregate: true,
      };
    }
    const price = numberPrice(offer.price ?? offer.priceSpecification?.price);
    return {
      price,
      regularPrice: regularPriceOf(offer, price),
      currency: normalizeCurrency(offer.priceCurrency),
      availability: availabilityLabel(offer.availability),
      storeCode: firstText(offer.availableAtOrFrom?.name, offer.availableAtOrFrom?.identifier, offer.seller?.identifier),
      aggregate: false,
    };
  });
}

function baseProduct(node, context, evidence, evidenceSource) {
  const { pageUrl, baseUrl, productPattern, selectors, productDetailPresent, mainEntityById } = context;
  const nodeId = typeof node['@id'] === 'string' ? node['@id'] : null;

  let candidateUrl = absoluteUrl(node.url, pageUrl);
  let productUrlEvidence = 'jsonld-product-url';

  if (!candidateUrl && nodeId) {
    const mainEntity = mainEntityById.get(nodeId);
    if (mainEntity) {
      // Le fragment d'un @id désigne le nœud JSON-LD, pas une variante d'URL.
      candidateUrl = absoluteUrl(String(mainEntity).split('#')[0], pageUrl);
      productUrlEvidence = 'webpage-mainentity';
    }
  }

  const resolution = resolveProductUrl(candidateUrl, {
    pageUrl,
    baseUrl,
    productPattern,
    selectors,
    productDetailPresent,
    evidence: productUrlEvidence,
  });

  const imageValue = asArray(node.image)[0];
  const imageUrl = typeof imageValue === 'string'
    ? imageValue
    : imageValue?.url || imageValue?.contentUrl || null;

  return {
    name: firstText(node.name),
    brand: firstText(node.brand),
    category: firstText(node.category, asArray(node.category).join(' > ')),
    gtin: firstText(node.gtin14, node.gtin13, node.gtin12, node.gtin8, node.gtin),
    sku: firstText(node.sku, node.productID),
    merchantId: firstText(node.offers?.seller?.identifier),
    merchantRef: firstText(node.mpn),
    merchantRefEvidence: node.mpn ? 'jsonld-mpn' : null,
    skuIsProductIdentifier: selectors?.skuIsProductIdentifier === true,
    variantNode: node,
    imageUrl: absoluteUrl(imageUrl, pageUrl),
    promotion: firstText(node.offers?.description, node.description),
    priceScope: selectors?.priceScope || 'unknown',
    productUrl: resolution.url,
    productUrlEvidence: resolution.evidence,
    productUrlRejected: resolution.rejected || null,
    cardUrl: null,
    discoveredFrom: pageUrl,
    sourceUrl: pageUrl,
    method: 'jsonld',
    evidence: evidence || null,
    evidenceSource: evidenceSource || null,
    jsonldIndex: context.nodeIndex ?? 0,
    selectorIndex: -1,
    aggregateOffer: false,
  };
}

function fromJsonLd(node, context) {
  const base = baseProduct(node, context, 'jsonld', 'product');
  const offers = extractOffers(node.offers);
  return offers.map((offer) => ({
    ...base,
    price: offer.price,
    regularPrice: offer.regularPrice,
    currency: offer.currency || normalizeCurrency(context.selectors?.currency),
    availability: offer.availability,
    storeCode: offer.storeCode,
    aggregateOffer: offer.aggregate,
    priceScope: offer.price === null ? 'unknown' : (context.selectors?.priceScope || 'unknown'),
  }));
}

async function readText(scope, selector, timeout = 1500) {
  if (!selector) return null;
  try {
    const text = await scope.locator(selector).first().textContent({ timeout });
    return text?.trim() || null;
  } catch {
    return null;
  }
}

async function readAttr(scope, selector, attribute = 'src', timeout = 1500) {
  if (!selector) return null;
  try {
    return await scope.locator(selector).first().getAttribute(attribute, { timeout });
  } catch {
    return null;
  }
}

async function extractCssCards(page, pageUrl, selectors, context) {
  if (!selectors?.productCard) return [];
  const cards = page.locator(selectors.productCard);
  const count = Math.min(await cards.count().catch(() => 0), 250);
  const products = [];

  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const name = await readText(card, selectors.name, 700);
    if (!name) continue;

    const href = selectors.productLink
      ? await readAttr(card, selectors.productLink, selectors.productLinkAttribute || 'href', 700)
      : null;
    const cardUrl = absoluteUrl(href, pageUrl);
    const resolution = resolveProductUrl(cardUrl, {
      pageUrl,
      baseUrl: context.baseUrl,
      productPattern: context.productPattern,
      selectors,
      evidence: 'css-card-link',
    });

    const image = await readAttr(card, selectors.image, selectors.imageAttribute || 'src', 700);
    const gtin = selectors.gtin
      ? await readAttr(card, selectors.gtin, selectors.gtinAttribute || 'content', 700)
      : null;
    const sku = selectors.sku
      ? await readAttr(card, selectors.sku, selectors.skuAttribute || 'content', 700)
      : null;

    products.push({
      name,
      brand: await readText(card, selectors.brand, 700),
      category: await readText(card, selectors.category, 700),
      gtin,
      sku,
      merchantId: selectors.merchantId
        ? await readAttr(card, selectors.merchantId, selectors.merchantIdAttribute || 'content', 700)
        : null,
      merchantRef: selectors.merchantRef
        ? await readAttr(card, selectors.merchantRef, selectors.merchantRefAttribute || 'content', 700)
        : null,
      merchantRefEvidence: selectors.merchantRef ? 'source-selector-merchant-ref' : null,
      skuIsProductIdentifier: selectors.skuIsProductIdentifier === true,
      variantNode: null,
      imageUrl: absoluteUrl(image, pageUrl),
      price: numberPrice(await readText(card, selectors.price, 700)),
      regularPrice: numberPrice(await readText(card, selectors.regularPrice, 700)),
      currency: normalizeCurrency(selectors.currency),
      promotion: await readText(card, selectors.promotion, 700),
      availability: await readText(card, selectors.availability, 700),
      priceScope: selectors.priceScope || 'unknown',
      storeCode: null,
      aggregateOffer: false,
      productUrl: resolution.url,
      productUrlEvidence: resolution.evidence,
      productUrlRejected: resolution.rejected || null,
      cardUrl: cardUrl || pageUrl,
      discoveredFrom: pageUrl,
      sourceUrl: pageUrl,
      method: 'css',
      evidence: resolution.evidence || 'css-card-fields',
      jsonldIndex: -1,
      selectorIndex: index,
    });
  }

  return products;
}


async function selectorExists(page, selector) {
  if (!selector) return false;
  try {
    return (await page.locator(selector).count()) > 0;
  } catch {
    return false;
  }
}

async function extractDetailPage(page, pageUrl, selectors, context) {
  if (!selectors?.name) return [];
  const name = await readText(page, selectors.name);
  if (!name) return [];

  const resolution = resolveProductUrl(null, {
    pageUrl,
    baseUrl: context.baseUrl,
    productPattern: context.productPattern,
    selectors,
    productDetailPresent: context.productDetailPresent,
    evidence: null,
  });
  if (!resolution.url) return [];

  const image = await readAttr(page, selectors.image, selectors.imageAttribute || 'src');
  const gtin = selectors.gtin
    ? await readAttr(page, selectors.gtin, selectors.gtinAttribute || 'content')
    : null;
  const sku = selectors.sku
    ? await readAttr(page, selectors.sku, selectors.skuAttribute || 'content')
    : null;

  return [{
    name,
    brand: await readText(page, selectors.brand),
    category: await readText(page, selectors.category),
    gtin,
    sku,
    merchantId: selectors.merchantId
      ? await readAttr(page, selectors.merchantId, selectors.merchantIdAttribute || 'content')
      : null,
    merchantRef: selectors.merchantRef
      ? await readAttr(page, selectors.merchantRef, selectors.merchantRefAttribute || 'content')
      : null,
    merchantRefEvidence: selectors.merchantRef ? 'source-selector-merchant-ref' : null,
    skuIsProductIdentifier: selectors.skuIsProductIdentifier === true,
    variantNode: null,
    imageUrl: absoluteUrl(image, pageUrl),
    price: numberPrice(await readText(page, selectors.price)),
    regularPrice: numberPrice(await readText(page, selectors.regularPrice)),
    currency: normalizeCurrency(selectors.currency),
    promotion: await readText(page, selectors.promotion),
    availability: await readText(page, selectors.availability),
    priceScope: selectors.priceScope || 'unknown',
    storeCode: null,
    aggregateOffer: false,
    productUrl: resolution.url,
    productUrlEvidence: resolution.evidence,
    productUrlRejected: null,
    cardUrl: null,
    discoveredFrom: pageUrl,
    sourceUrl: pageUrl,
    method: 'detail',
    evidence: resolution.evidence,
    jsonldIndex: -1,
    selectorIndex: 0,
  }];
}

/**
 * Extrait les produits d'une page. Chaque entrée retournée porte une observation
 * commerciale (prix éventuellement nul) et sa provenance de découverte.
 * Les champs bruts (method, evidence, jsonldIndex, selectorIndex) servent au
 * diagnostic et au staging ; aucun n'entre dans la clé d'identité.
 */
export async function extractProducts(page, pageUrl, selectors = {}, options = {}) {
  const baseUrl = options.baseUrl || pageUrl;
  const productPattern = options.productPattern
    || (options.productUrlRegex ? compileProductPattern(options.productUrlRegex) : null);
  const stripParams = options.stripParams;
  const keepParams = options.keepParams;
  const productDetailPresent = await selectorExists(page, selectors.productDetail);

  const scripts = await page.locator('script[type="application/ld+json"]').allTextContents().catch(() => []);
  const documents = [];
  for (const script of scripts) {
    try {
      documents.push(JSON.parse(script));
    } catch {
      // JSON-LD malformé ignoré : la page reste exploitable par les autres voies.
    }
  }

  const mainEntityById = new Map();
  for (const document of documents) {
    for (const webPage of collectWebPages(document)) {
      const mainEntity = webPage.mainEntity;
      const entityId = typeof mainEntity === 'string'
        ? mainEntity
        : (mainEntity && typeof mainEntity === 'object' ? mainEntity['@id'] : null);
      if (typeof entityId === 'string' && /^https?:/i.test(entityId)) {
        mainEntityById.set(entityId, entityId);
      }
    }
  }

  const context = {
    pageUrl,
    baseUrl,
    productPattern,
    selectors,
    productDetailPresent,
    mainEntityById,
    nodeIndex: 0,
  };
  const products = [];

  for (const document of documents) {
    for (const node of collectProducts(document)) {
      products.push(...fromJsonLd(node, context));
      context.nodeIndex += 1;
    }
  }

  products.push(...await extractCssCards(page, pageUrl, selectors, context));
  if (!products.length) {
    products.push(...await extractDetailPage(page, pageUrl, selectors, context));
  }

  const deduped = new Map();
  for (const product of products) {
    if (!product.name) continue;
    if (!product.productUrl && product.price === null && !product.aggregateOffer) continue;
    const canonicalPage = canonicalizeUrl(product.discoveredFrom, { baseUrl, stripParams, keepParams });
    const canonicalProductUrl = product.productUrl
      ? canonicalizeUrl(product.productUrl, { baseUrl, stripParams, keepParams })
      : null;
    const variant = variantFromNode(product.variantNode);
    const identityPart = `${canonicalPage}|${normalizeName(product.name)}|${variantSignature(variant)}`;
    const pricePart = product.price === null || product.price === undefined ? 'unknown-price' : String(product.price);
    const storePart = product.storeCode || '';
    const baseKey = `${identityPart}|${storePart}|${pricePart}`;
    const key = `${baseKey}|${canonicalProductUrl ? `url:${canonicalProductUrl}` : 'url:unknown'}`;
    let matchKey = key;
    let current = deduped.get(matchKey);
    if (!current) {
      // Une preuve URL manquante peut enrichir une seule fiche candidate
      // compatible. Si plusieurs fiches homonymes existent, on conserve une
      // entrée distincte plutôt que d'attribuer sa provenance arbitrairement.
      const candidates = [...deduped.entries()].filter(([candidateKey, candidate]) => (
        candidateKey.startsWith(`${baseKey}|`)
        && (!canonicalProductUrl || !candidate.productUrl || candidate.productUrl === canonicalProductUrl)
      ));
      if (candidates.length === 1) [matchKey, current] = candidates[0];
    }
    if (!current) {
      deduped.set(matchKey, {
        ...product,
        productUrl: canonicalProductUrl || product.productUrl || null,
        extractionSources: [{
          method: product.method, evidence: product.evidence, productUrl: canonicalProductUrl,
          jsonldIndex: product.jsonldIndex, selectorIndex: product.selectorIndex,
        }],
        extractionConflicts: [],
      });
      continue;
    }
    if (current.productUrl && canonicalProductUrl && current.productUrl !== canonicalProductUrl) {
      // Même libellé/prix mais deux URLs explicites : ce sont deux candidats,
      // pas une URL à écraser ni une provenance à abandonner.
      const distinctKey = key;
      if (!deduped.has(distinctKey)) {
        deduped.set(distinctKey, {
          ...product,
          productUrl: canonicalProductUrl,
          extractionSources: [{
            method: product.method, evidence: product.evidence, productUrl: canonicalProductUrl,
            jsonldIndex: product.jsonldIndex, selectorIndex: product.selectorIndex,
          }],
          extractionConflicts: [],
        });
      } else {
        deduped.get(distinctKey).extractionSources.push({
          method: product.method, evidence: product.evidence, productUrl: canonicalProductUrl,
          jsonldIndex: product.jsonldIndex, selectorIndex: product.selectorIndex,
        });
      }
      continue;
    }
    if (current.price !== null && product.price !== null && current.price !== product.price) {
      // Prix distincts = observations distinctes : ne pas les fusionner.
      const distinctKey = `${key}|method:${product.method || 'unknown'}`;
      if (!deduped.has(distinctKey)) deduped.set(distinctKey, { ...product, extractionSources: [{ method: product.method, evidence: product.evidence, productUrl: canonicalProductUrl, jsonldIndex: product.jsonldIndex, selectorIndex: product.selectorIndex }], extractionConflicts: [] });
      continue;
    }
    for (const field of ['brand', 'category', 'gtin', 'sku', 'merchantId', 'merchantRef', 'imageUrl', 'currency', 'regularPrice', 'promotion', 'availability']) {
      if ((current[field] === null || current[field] === undefined || current[field] === '') && product[field] !== null && product[field] !== undefined && product[field] !== '') {
        current[field] = product[field];
      } else if (current[field] && product[field] && String(current[field]).trim() !== String(product[field]).trim()) {
        current.extractionConflicts.push({ kind: `field-conflict:${field}`, kept: current[field], seen: product[field] });
      }
    }
    if (current.price === null && product.price !== null) current.price = product.price;
    if (!current.productUrl && canonicalProductUrl) current.productUrl = canonicalProductUrl;
    current.extractionSources.push({
      method: product.method, evidence: product.evidence, productUrl: canonicalProductUrl,
      jsonldIndex: product.jsonldIndex, selectorIndex: product.selectorIndex,
    });
    current.extractionConflicts.push(...(product.extractionConflicts || []));
  }

  return [...deduped.values()];
}

export function compileProductPattern(pattern) {
  if (!pattern) return null;
  if (String(pattern).length > 300) throw new Error('productUrlRegex trop long (300 caractères maximum).');
  try {
    return new RegExp(pattern, 'i');
  } catch {
    throw new Error('productUrlRegex invalide.');
  }
}
