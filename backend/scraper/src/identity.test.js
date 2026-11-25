import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRACKING_PARAMS,
  buildIdentity,
  canonicalizeUrl,
  discoveryKeyFor,
  fallbackKey,
  identityKindFromKey,
  mergeCandidates,
  mergeVariantDetails,
  normalizeCurrency,
  normalizeGtin,
  priceFingerprint,
  variantSignature,
} from './identity.js';

test('GTIN : chiffre de contrôle GS1 validé et normalisation 14 chiffres', () => {
  assert.equal(normalizeGtin('4006381333931'), '04006381333931');
  assert.equal(normalizeGtin('4006381333932'), null);
  assert.equal(normalizeGtin('12345670'), '00000012345670');
  assert.equal(normalizeGtin('036000291452'), '00036000291452');
  assert.equal(normalizeGtin('00012345600012'), '00012345600012');
  assert.equal(normalizeGtin('ABC-123'), null);
  assert.equal(normalizeGtin('400638133393'), null);
  assert.equal(normalizeGtin(''), null);
  assert.equal(normalizeGtin(null), null);
});

test('un SKU n’est jamais enregistré comme GTIN', () => {
  const identity = buildIdentity(
    { name: 'Produit sans code-barres', sku: 'SKU-9988', productUrl: 'https://shop.example/p/x' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/p/x' },
  );
  assert.equal(identity.identityKey.startsWith('g:'), false);
  assert.equal(identity.identifiers.some((item) => item.namespace === 'gtin'), false);
  assert.equal(identity.identifiers.some((item) => item.namespace === 'sku' && item.value === 'SKU-9988'), true);
  assert.equal(identity.identityKey, 'u:https://shop.example/p/x');
});

test('un GTIN invalide est ignoré, pas inventé', () => {
  const identity = buildIdentity(
    { name: 'Produit', gtin: '4006381333932', productUrl: 'https://shop.example/p/y' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/p/y' },
  );
  assert.equal(identity.identityKey, 'u:https://shop.example/p/y');
  assert.equal(identity.identifiers.some((item) => item.namespace === 'gtin'), false);
});

test('URL : tracking retiré, paramètres produit et inconnus conservés', () => {
  const url = canonicalizeUrl(
    'https://Shop.Example:443/p/abc?ref=newsletter&source=search&sku=42&variant=red&size=XL&utm_source=mail&fbclid=xyz&unknown=1#color=red',
  );
  assert.ok(url);
  const parsed = new URL(url);
  assert.equal(parsed.hostname, 'shop.example');
  assert.equal(parsed.port, '');
  assert.equal(parsed.searchParams.get('ref'), 'newsletter');
  assert.equal(parsed.searchParams.get('source'), 'search');
  assert.equal(parsed.searchParams.get('sku'), '42');
  assert.equal(parsed.searchParams.get('variant'), 'red');
  assert.equal(parsed.searchParams.get('size'), 'XL');
  assert.equal(parsed.searchParams.get('unknown'), '1');
  assert.equal(parsed.searchParams.get('utm_source'), null);
  assert.equal(parsed.searchParams.get('fbclid'), null);
  assert.equal(parsed.hash, '#color=red');
  assert.equal(parsed.pathname, '/p/abc');
});

test('URL : paramètres protégés jamais retirés même listés par erreur', () => {
  const url = canonicalizeUrl('https://shop.example/p/a?ref=1&utm_campaign=2', {
    stripParams: [...DEFAULT_TRACKING_PARAMS, 'ref'],
  });
  assert.equal(new URL(url).searchParams.get('ref'), '1');
  assert.equal(new URL(url).searchParams.get('utm_campaign'), null);
});

test('URL invalide : aucune fausse identité', () => {
  assert.equal(canonicalizeUrl('javascript:alert(1)'), null);
  assert.equal(canonicalizeUrl('http://'), null);
  assert.equal(canonicalizeUrl('ftp://shop.example/p'), null);
  assert.equal(canonicalizeUrl('https://user:pass@shop.example/p'), null);
  assert.equal(canonicalizeUrl('', {}), null);
});

test('clé de secours : source, page, nom, variantes ; jamais le prix', () => {
  const first = fallbackKey({
    sourceId: 'shop',
    discoveredFrom: 'https://shop.example/catalogue',
    name: 'Gel Douche  Café',
    variant: { size: 'XL', color: 'Bleu' },
  });
  const second = fallbackKey({
    sourceId: 'shop',
    discoveredFrom: 'https://shop.example/catalogue',
    name: 'gel douche cafe',
    variant: { color: 'Bleu', size: 'XL' },
  });
  const otherSource = fallbackKey({
    sourceId: 'other',
    discoveredFrom: 'https://shop.example/catalogue',
    name: 'Gel Douche Café',
    variant: { size: 'XL', color: 'Bleu' },
  });
  assert.equal(first, second);
  assert.notEqual(first, otherSource);
  assert.match(first, /^f:[0-9a-f]{64}$/);

  const withPrice = buildIdentity(
    {
      name: 'Gel Douche Café',
      variantNode: { size: 'XL', color: 'Bleu' },
      price: 3.49,
    },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  const withoutPrice = buildIdentity(
    {
      name: 'Gel Douche Café',
      variantNode: { size: 'XL', color: 'Bleu' },
      price: 9.99,
    },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  assert.equal(withPrice.identityKey, withoutPrice.identityKey);
  assert.equal(withPrice.identityKey, first);
});

test('la clé de découverte ne dépend ni de la méthode ni du GTIN découvert ensuite', () => {
  const before = buildIdentity(
    { name: 'Café moulu', productUrl: 'https://shop.example/p/cafe' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  const after = buildIdentity(
    {
      name: 'Café moulu',
      productUrl: 'https://shop.example/p/cafe?utm_source=mail',
      gtin: '4006381333931',
    },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  assert.equal(before.discoveryKey, after.discoveryKey);
  assert.equal(before.identityKey, 'u:https://shop.example/p/cafe');
  assert.equal(after.identityKey, 'g:04006381333931');
  assert.equal(discoveryKeyFor({
    sourceId: 'shop',
    productUrl: 'https://shop.example/p/cafe',
    discoveredFrom: 'https://shop.example/autre-page',
    name: 'Nom différent',
  }), before.discoveryKey);
});

test('hiérarchie : GTIN > référence marchand > référence > URL > secours', () => {
  const gtin = buildIdentity(
    {
      name: 'P',
      gtin: '4006381333931',
      merchantId: 'store-1',
      merchantRef: 'REF-1',
      productUrl: 'https://shop.example/p/1',
    },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/p/1' },
  );
  assert.equal(gtin.identityKey, 'g:04006381333931');
  assert.equal(identityKindFromKey(gtin.identityKey), 'gtin');

  const merchant = buildIdentity(
    { name: 'P', merchantId: 'store 1', merchantRef: 'REF/1', productUrl: 'https://shop.example/p/1' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/p/1' },
  );
  assert.equal(merchant.identityKey, 'm:store%201/REF%2F1');

  const ref = buildIdentity(
    { name: 'P', merchantRef: 'REF-1', productUrl: 'https://shop.example/p/1' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/p/1' },
  );
  assert.equal(ref.identityKey, 'r:REF-1');

  const url = buildIdentity(
    { name: 'P', productUrl: 'https://shop.example/p/1' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/p/1' },
  );
  assert.equal(url.identityKey, 'u:https://shop.example/p/1');

  const fallback = buildIdentity(
    { name: 'P' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  assert.match(fallback.identityKey, /^f:/);
});

test('fiche produit : sans preuve, product_url reste nulle', () => {
  const identity = buildIdentity(
    { name: 'Produit de catalogue', productUrl: null },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  assert.equal(identity.productUrl, null);
  assert.equal(identity.identifiers.some((item) => item.namespace === 'url'), false);
  assert.match(identity.identityKey, /^f:/);
});

test('mergeCandidates conserve toutes les provenances d’une même observation', () => {
  const base = buildIdentity(
    { name: 'Café', productUrl: 'https://shop.example/p/cafe' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  const observation = {
    fingerprint: 'fp-1',
    price: 5.2,
    regularPrice: null,
    currency: 'EUR',
    promotion: null,
    availability: 'In Stock',
    priceScope: 'unknown',
    storeCode: null,
    sources: [{ method: 'jsonld', discoveredFrom: 'https://shop.example/catalogue', discoveredUrl: 'https://shop.example/p/cafe', evidence: 'jsonld-product-url', jsonldIndex: 0, selectorIndex: -1 }],
  };

  const merged = mergeCandidates([
    {
      ...base,
      identifiers: base.identifiers,
      identity: base.identity,
      observations: [observation],
      sources: [{ method: 'jsonld', discoveredFrom: 'https://shop.example/catalogue', discoveredUrl: 'https://shop.example/p/cafe', evidence: 'jsonld-product-url' }],
    },
    {
      ...base,
      identifiers: base.identifiers,
      identity: base.identity,
      observations: [{
        ...observation,
        sources: [{ method: 'css', discoveredFrom: 'https://shop.example/catalogue', discoveredUrl: 'https://shop.example/p/cafe', evidence: 'css-card-link', jsonldIndex: -1, selectorIndex: 4 }],
      }],
      sources: [{ method: 'css', discoveredFrom: 'https://shop.example/catalogue', discoveredUrl: 'https://shop.example/p/cafe', evidence: 'css-card-link' }],
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].observations.length, 1);
  assert.equal(merged[0].observations[0].sources.length, 2);
  assert.equal(merged[0].sources.length, 2);
});

test('fingerprint commercial : ordre figé et devise inconnue préservée nulle', () => {
  const first = priceFingerprint({
    day: '2026-11-19',
    storeCode: null,
    price: 3.49,
    regularPrice: null,
    currency: null,
    promotion: null,
    availability: null,
    priceScope: 'unknown',
  });
  assert.equal(
    first,
    Buffer.from('{"day":"2026-11-19","storeCode":null,"price":3.49,"regularPrice":null,"currency":null,"promotion":null,"availability":null,"priceScope":"unknown"}').toString('base64url'),
  );
  assert.notEqual(first, priceFingerprint({
    day: '2026-11-19',
    storeCode: null,
    price: 3.49,
    regularPrice: null,
    currency: 'EUR',
    promotion: null,
    availability: null,
    priceScope: 'unknown',
  }));
});

test('normalisation des devises et des variantes', () => {
  assert.equal(normalizeCurrency('eur'), 'EUR');
  assert.equal(normalizeCurrency('€'), null);
  assert.equal(normalizeCurrency(null), null);
  assert.equal(
    variantSignature({ size: 'XL', color: 'Rouge' }),
    variantSignature({ color: 'Rouge', size: 'XL' }),
  );
  assert.equal(variantSignature({ size: 'XL' }), '{"size":"XL"}');
  assert.equal(variantSignature({ size: 'XL', color: '' }), '{"size":"XL"}');
});


test('variantes : enrichissement partiel compatible sans écrasement', () => {
  const merged = mergeVariantDetails({ size: 'M' }, { size: 'm', color: 'Bleu' });
  assert.deepEqual(merged, { variant: { size: 'M', color: 'Bleu' }, conflicts: [] });
});

test('variantes : taille contradictoire bloquée', () => {
  const merged = mergeVariantDetails({ size: 'M', color: 'Bleu' }, { size: 'L' });
  assert.deepEqual(merged.variant, { size: 'M', color: 'Bleu' });
  assert.equal(merged.conflicts.length, 1);
  assert.equal(merged.conflicts[0].field, 'size');
});

test('même URL mais variantes distinctes : clés de découverte distinctes', () => {
  const sizeM = buildIdentity(
    { name: 'T-shirt', productUrl: 'https://shop.example/p/t-shirt', variant: { size: 'M' } },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  const sizeL = buildIdentity(
    { name: 'T-shirt', productUrl: 'https://shop.example/p/t-shirt', variant: { size: 'L' } },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  assert.notEqual(sizeM.discoveryKey, sizeL.discoveryKey);
  assert.equal(sizeM.identityKey, sizeL.identityKey);
});


test('SKU devient primaire uniquement avec opt-in explicite et reste secondaire sinon', () => {
  const secondary = buildIdentity(
    { name: 'Produit A', sku: 'SKU-A' },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  const primary = buildIdentity(
    { name: 'Produit A', sku: 'SKU-A', skuIsProductIdentifier: true },
    { sourceId: 'shop', discoveredFrom: 'https://shop.example/catalogue' },
  );
  assert.equal(secondary.identityKey.startsWith('f:'), true);
  assert.equal(secondary.identifiers.find((item) => item.namespace === 'sku').kind, 'secondary');
  assert.equal(primary.identityKey, 'r:SKU-A');
  assert.equal(primary.identifiers.find((item) => item.namespace === 'sku').kind, 'primary');
});
