import { createHash } from 'node:crypto';

/**
 * Identité produit MapNifique.
 * Module pur : aucune connexion, aucun accès réseau, aucun accès disque.
 * Il est consommé par extract.js, stage.js, crawler.js et le script de réconciliation.
 */

export const IDENTITY_NAMESPACE = Object.freeze({
  GTIN: 'gtin',
  MERCHANT_REF: 'merchant_ref',
  REF: 'ref',
  SKU: 'sku',
  URL: 'url',
});

/** Paramètres de tracking retirés par défaut. `ref`, `source`, `sku`, `variant`,
 *  `size` n'en font jamais partie : ils peuvent porter l'identité du produit. */
export const DEFAULT_TRACKING_PARAMS = Object.freeze([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  '_ga',
  '_gl',
]);

export const PROTECTED_PARAMS = Object.freeze([
  'ref',
  'source',
  'sku',
  'variant',
  'size',
  'color',
  'product',
  'productId',
  'id',
]);

const VARIANT_FIELDS = Object.freeze([
  'color',
  'size',
  'pattern',
  'material',
  'flavor',
  'format',
  'weight',
  'unitCode',
]);

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function asArray(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export function textValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textValue(item);
      if (text) return text;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const key of ['name', 'value', '@value', 'text']) {
      if (key in value) {
        const text = textValue(value[key]);
        if (text) return text;
      }
    }
  }
  return null;
}

export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeCurrency(value) {
  const text = textValue(value);
  if (!text) return null;
  const upper = text.toUpperCase();
  return /^[A-Z]{3}$/.test(upper) ? upper : null;
}

export function normalizeRefPart(value) {
  const text = textValue(value);
  if (!text) return null;
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > 160) return null;
  return compact;
}

/**
 * Chiffre de contrôle GS1 mod-10, calculé depuis la droite (poids 3,1,3...).
 * Le paramètre doit contenir 14 chiffres.
 */
export function hasValidGs1CheckDigit(value) {
  if (!/^\d{14}$/.test(String(value))) return false;
  const digits = String(value);
  let sum = 0;
  for (let offset = 0; offset < 13; offset += 1) {
    const digit = Number(digits[12 - offset]);
    sum += digit * (offset % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits[13]);
}

/**
 * GTIN-8, GTIN-12, GTIN-13 et GTIN-14 acceptés puis normalisés sur 14 chiffres.
 * Toute valeur non numérique ou dont le chiffre de contrôle est faux est rejetée.
 */
export function normalizeGtin(value) {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const digits = String(value).replace(/[\s-]/g, '');
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(digits)) return null;
  const padded = digits.padStart(14, '0');
  return hasValidGs1CheckDigit(padded) ? padded : null;
}

export function isValidGtin(value) {
  return normalizeGtin(value) !== null;
}

/**
 * Canonicalisation minimale et non destructive :
 * - seuls les paramètres de tracking configurés sont retirés ;
 * - les paramètres protégés ne sont jamais retirés, même listés par erreur ;
 * - les paramètres inconnus et le fragment sont conservés ;
 * - l'hôte est minusculisé et le port par défaut retiré ;
 * - le chemin n'est jamais réécrit.
 */
export function canonicalizeUrl(value, {
  baseUrl,
  stripParams = DEFAULT_TRACKING_PARAMS,
  keepParams = PROTECTED_PARAMS,
} = {}) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let parsed;
  try {
    parsed = new URL(value.trim(), baseUrl || undefined);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;

  const keep = new Set(keepParams.map((item) => String(item).toLowerCase()));
  const strip = new Set(stripParams.map((item) => String(item).toLowerCase()));
  if (strip.size) {
    for (const key of [...parsed.searchParams.keys()]) {
      const lower = key.toLowerCase();
      if (strip.has(lower) && !keep.has(lower)) parsed.searchParams.delete(key);
    }
  }
  parsed.hostname = parsed.hostname.toLowerCase();
  return parsed.toString();
}

/** Variante structurée d'un nœud JSON-LD / d'un objet produit, aplatie. */
export function variantFromNode(node) {
  const variant = {};
  if (!node || typeof node !== 'object' || Array.isArray(node)) return variant;

  for (const field of VARIANT_FIELDS) {
    const value = textValue(node[field]);
    if (value) variant[field] = value;
  }

  for (const property of asArray(node.additionalProperty)) {
    if (!property || typeof property !== 'object' || Array.isArray(property)) continue;
    const rawName = textValue(property.name);
    const value = textValue(property.value);
    if (!rawName || !value) continue;
    const name = normalizeName(rawName).replace(/ /g, '_');
    if (name) variant[name] = value;
  }

  return variant;
}

/** Signature stable : clés triées, aucune dépendance à l'ordre d'insertion. */
/** Fusionne des variantes partielles sans écraser une valeur contradictoire. */
export function mergeVariantDetails(...variants) {
  const merged = {};
  const conflicts = [];
  for (const variant of variants) {
    if (!variant || typeof variant !== 'object' || Array.isArray(variant)) continue;
    for (const [rawField, rawValue] of Object.entries(variant)) {
      const field = String(rawField).trim();
      const value = textValue(rawValue);
      if (!field || !value) continue;
      if (!(field in merged)) {
        merged[field] = value;
        continue;
      }
      if (normalizeName(merged[field]) !== normalizeName(value)) {
        conflicts.push({ field, kept: merged[field], seen: value });
      }
    }
  }
  return { variant: merged, conflicts };
}

export function variantSignature(variant) {
  if (!variant || typeof variant !== 'object' || Array.isArray(variant)) return '';
  const ordered = {};
  for (const key of Object.keys(variant).sort()) {
    const value = variant[key];
    if (value === null || value === undefined || value === '') continue;
    ordered[key] = String(value);
  }
  return JSON.stringify(ordered);
}

/**
 * Empreinte de secours : source, page de découverte, nom normalisé, variantes.
 * Jamais de prix, jamais d'index, jamais de méthode d'extraction.
 */
export function fallbackKey({ sourceId, discoveredFrom, name, variant = {} } = {}) {
  if (!sourceId) throw new Error('fallbackKey: sourceId obligatoire.');
  if (!normalizeName(name)) throw new Error('fallbackKey: name obligatoire.');
  const payload = JSON.stringify({
    source: sourceId,
    page: discoveredFrom || null,
    name: normalizeName(name),
    variant: variantSignature(variant),
  });
  return `f:${sha256(payload)}`;
}

/**
 * Clé de découverte stable : URL produit si elle est prouvée, sinon page de
 * découverte + nom normalisé + variantes. Indépendante de la méthode, de l'ordre
 * d'extraction et de l'enrichissement ultérieur des identifiants.
 */
export function discoveryKeyFor({ sourceId, productUrl, discoveredFrom, name, variant = {} } = {}) {
  if (!sourceId) throw new Error('discoveryKeyFor: sourceId obligatoire.');
  if (productUrl) return sha256(`${sourceId}\u0000url:${productUrl}\u0000variant:${variantSignature(variant)}`);
  if (!normalizeName(name)) throw new Error('discoveryKeyFor: name obligatoire sans URL produit.');
  return sha256(
    `${sourceId}\u0000page:${discoveredFrom || ''}\u0000name:${normalizeName(name)}\u0000variant:${variantSignature(variant)}`,
  );
}

/** Fingerprint commercial historique : 8 clés, ordre figé, base64url. */
export function priceFingerprint({
  day,
  storeCode = null,
  price = null,
  regularPrice = null,
  currency = null,
  promotion = null,
  availability = null,
  priceScope = 'unknown',
} = {}) {
  if (!day) throw new Error('priceFingerprint: day obligatoire.');
  const payload = JSON.stringify({
    day,
    storeCode,
    price,
    regularPrice,
    currency,
    promotion,
    availability,
    priceScope,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function identityKindFromKey(identityKey) {
  switch (String(identityKey || '').slice(0, 2)) {
    case 'g:': return 'gtin';
    case 'm:': return 'merchant-ref';
    case 'r:': return 'ref';
    case 'u:': return 'url';
    case 'f:': return 'fallback';
    default: return 'unknown';
  }
}

function makeIdentifier(namespace, value, sourceId, evidence) {
  const scope = namespace === IDENTITY_NAMESPACE.GTIN ? 'global' : 'source';
  return {
    namespace,
    scope,
    sourceId: scope === 'source' ? sourceId : null,
    value,
    evidence,
  };
}

/**
 * Construit l'identité d'un produit extrait.
 * productUrl n'est accepté que s'il porte une preuve de fiche produit ; sinon null.
 */
export function buildIdentity(product, {
  sourceId,
  discoveredFrom,
  stripParams,
  keepParams,
} = {}) {
  if (!sourceId) throw new Error('buildIdentity: sourceId obligatoire.');
  const page = canonicalizeUrl(discoveredFrom || product?.discoveredFrom, { stripParams, keepParams });
  if (!page) throw new Error('buildIdentity: discoveredFrom invalide.');
  if (!normalizeName(product?.name)) throw new Error('buildIdentity: name obligatoire.');

  const productUrl = product.productUrl
    ? canonicalizeUrl(product.productUrl, { baseUrl: page, stripParams, keepParams })
    : null;
  if (product.productUrl && !productUrl) {
    throw new Error('buildIdentity: productUrl invalide.');
  }

  const gtin = normalizeGtin(product.gtin);
  const merchantId = normalizeRefPart(product.merchantId);
  const merchantRef = normalizeRefPart(product.merchantRef);
  const sku = normalizeRefPart(product.sku);
  const variant = {
    ...variantFromNode(product.variantNode),
    ...(product.variant && typeof product.variant === 'object' ? product.variant : {}),
  };

  const identifiers = [];
  if (gtin) {
    identifiers.push(makeIdentifier(
      IDENTITY_NAMESPACE.GTIN,
      gtin,
      sourceId,
      product.gtinEvidence || 'jsonld-gtin',
    ));
  }
  if (merchantId && merchantRef) {
    identifiers.push(makeIdentifier(
      IDENTITY_NAMESPACE.MERCHANT_REF,
      `${encodeURIComponent(merchantId)}/${encodeURIComponent(merchantRef)}`,
      sourceId,
      product.merchantRefEvidence || 'jsonld-mpn',
    ));
  } else if (merchantRef) {
    identifiers.push(makeIdentifier(
      IDENTITY_NAMESPACE.REF,
      merchantRef,
      sourceId,
      product.merchantRefEvidence || 'jsonld-mpn',
    ));
  }
  if (sku) {
    // Un SKU reste secondaire : jamais clé primaire implicite, jamais comparé
    // entre deux enseignes (portée source).
    identifiers.push(makeIdentifier(
      IDENTITY_NAMESPACE.SKU,
      sku,
      sourceId,
      product.skuEvidence || 'jsonld-sku',
    ));
  }
  if (productUrl) {
    identifiers.push(makeIdentifier(
      IDENTITY_NAMESPACE.URL,
      productUrl,
      sourceId,
      product.productUrlEvidence || 'product-url',
    ));
  }

  let identityKey;
  if (gtin) {
    identityKey = `g:${gtin}`;
  } else if (merchantId && merchantRef) {
    identityKey = `m:${encodeURIComponent(merchantId)}/${encodeURIComponent(merchantRef)}`;
  } else if (merchantRef) {
    identityKey = `r:${merchantRef}`;
  } else if (sku && product.skuIsProductIdentifier === true) {
    // SKU déclaré stable et documenté par la source : identifiant marchand.
    identityKey = `r:${sku}`;
  } else if (productUrl) {
    identityKey = `u:${productUrl}`;
  } else {
    identityKey = fallbackKey({ sourceId, discoveredFrom: page, name: product.name, variant });
  }

  // L'alias correspondant à la clé choisie porte explicitement le rôle
  // primaire. Un SKU reste secondaire sauf opt-in documenté de la source.
  for (const identifier of identifiers) {
    const suffix = identityKey.slice(2);
    identifier.kind = (
      (identityKey.startsWith('g:') && identifier.namespace === IDENTITY_NAMESPACE.GTIN && identifier.value === suffix)
      || (identityKey.startsWith('m:') && identifier.namespace === IDENTITY_NAMESPACE.MERCHANT_REF && identifier.value === suffix)
      || (identityKey.startsWith('r:') && ['ref', 'sku'].includes(identifier.namespace) && identifier.value === suffix)
      || (identityKey.startsWith('u:') && identifier.namespace === IDENTITY_NAMESPACE.URL && identifier.value === suffix)
    ) ? 'primary' : 'secondary';
  }

  return {
    identityKey,
    identityKind: identityKindFromKey(identityKey),
    identifiers,
    productUrl,
    discoveredFrom: page,
    discoveryKey: discoveryKeyFor({
      sourceId,
      productUrl,
      discoveredFrom: page,
      name: product.name,
      variant,
    }),
    identity: {
      name: String(product.name).trim().replace(/\s+/g, ' '),
      brand: textValue(product.brand),
      category: textValue(product.category),
      variant,
      variantSignature: variantSignature(variant),
    },
  };
}

export function sameIdentifier(left, right) {
  return Boolean(
    left
    && right
    && left.namespace === right.namespace
    && left.value === right.value
    && (left.scope === 'global' || left.sourceId === right.sourceId),
  );
}

const KEY_RANK = Object.freeze({ 'g:': 5, 'm:': 4, 'r:': 3, 'u:': 2, 'f:': 1 });
export function identityKeyRank(identityKey) {
  return KEY_RANK[String(identityKey || '').slice(0, 2)] ?? 0;
}

function observationSourceKey(source) {
  return [
    source.method || '',
    source.discoveredFrom || '',
    source.discoveredUrl || '',
    source.evidence || '',
    source.jsonldIndex ?? -1,
    source.selectorIndex ?? -1,
  ].join('\u0000');
}

function candidateSourceKey(source) {
  return [
    source.method || '',
    source.discoveredFrom || '',
    source.discoveredUrl || '',
    source.evidence || '',
  ].join('\u0000');
}

/**
 * Fusionne les découvertes d'un même produit (même discoveryKey).
 * Une observation identique est fusionnée, mais toutes ses provenances sont
 * conservées, y compris quand le fingerprint commercial existait déjà.
 */
export function mergeCandidates(candidates) {
  const merged = new Map();

  for (const candidate of candidates) {
    if (!candidate?.discoveryKey) throw new Error('mergeCandidates: discoveryKey obligatoire.');
    if (!candidate.identityKey) throw new Error('mergeCandidates: identityKey obligatoire.');

    const existing = merged.get(candidate.discoveryKey);
    if (!existing) {
      merged.set(candidate.discoveryKey, {
        ...candidate,
        identifiers: candidate.identifiers.map((identifier) => ({ ...identifier })),
        observations: candidate.observations.map((observation) => ({
          ...observation,
          sources: observation.sources.map((source) => ({ ...source })),
        })),
        sources: (candidate.sources || []).map((source) => ({ ...source })),
      });
      continue;
    }

    if (identityKeyRank(candidate.identityKey) > identityKeyRank(existing.identityKey)) {
      existing.identityKey = candidate.identityKey;
      existing.identityKind = candidate.identityKind;
    }

    for (const identifier of candidate.identifiers) {
      if (!existing.identifiers.some((current) => sameIdentifier(current, identifier))) {
        existing.identifiers.push({ ...identifier });
      }
    }

    for (const field of ['name', 'brand', 'category', 'imageUrl', 'productUrl']) {
      if (!existing[field] && candidate[field]) existing[field] = candidate[field];
    }
    const variantMerge = mergeVariantDetails(existing.identity?.variant || {}, candidate.identity?.variant || {});
    if (variantMerge.conflicts.length) {
      existing.identityConflicts = [
        ...(existing.identityConflicts || []),
        ...variantMerge.conflicts.map((conflict) => ({ kind: 'variant-conflict', ...conflict })),
      ];
    }
    existing.identity.variant = variantMerge.variant;
    existing.identity.variantSignature = variantSignature(existing.identity.variant);

    for (const observation of candidate.observations) {
      const current = existing.observations.find((item) => item.fingerprint === observation.fingerprint);
      if (!current) {
        existing.observations.push({
          ...observation,
          sources: observation.sources.map((source) => ({ ...source })),
        });
        continue;
      }
      for (const source of observation.sources) {
        const key = observationSourceKey(source);
        if (!current.sources.some((item) => observationSourceKey(item) === key)) {
          current.sources.push({ ...source });
        }
      }
      for (const field of ['storeCode', 'price', 'regularPrice', 'currency', 'promotion', 'availability', 'priceScope']) {
        if (current[field] === null || current[field] === undefined) current[field] = observation[field] ?? null;
      }
    }

    for (const source of candidate.sources || []) {
      const key = candidateSourceKey(source);
      if (!existing.sources.some((item) => candidateSourceKey(item) === key)) {
        existing.sources.push({ ...source });
      }
    }
  }

  return [...merged.values()];
}
