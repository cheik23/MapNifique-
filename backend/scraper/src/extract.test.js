import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compileProductPattern,
  extractProducts,
  isSameHost,
  isSameOrigin,
  numberPrice,
} from './extract.js';

function fakeCard(fields) {
  return {
    locator(selector) {
      const field = fields[selector] || {};
      return {
        first: () => ({
          textContent: async () => field.text ?? null,
          getAttribute: async (attribute) => field.attrs?.[attribute] ?? null,
        }),
      };
    },
  };
}

function fakePage(options = {}) {
  const { jsonLd = [], cards = [], cardSelector = '#cards', detail = {} } = Array.isArray(options)
    ? { jsonLd: options }
    : options;
  return {
    locator(selector) {
      if (selector === 'script[type="application/ld+json"]') {
        return {
          allTextContents: async () => jsonLd.map((value) => (
            typeof value === 'string' ? value : JSON.stringify(value)
          )),
        };
      }
      if (selector === cardSelector) {
        return { count: async () => cards.length, nth: (index) => cards[index] };
      }
      const field = detail[selector] || {};
      return {
        count: async () => (field.text || field.attrs ? 1 : 0),
        first: () => ({
          textContent: async () => field.text ?? null,
          getAttribute: async (attribute) => field.attrs?.[attribute] ?? null,
        }),
      };
    },
  };
}

test('prix : multiplications, fractions et séparateurs invalides refusés', () => {
  assert.equal(numberPrice('2 x 1,50'), null);
  assert.equal(numberPrice('1 2'), null);
  assert.equal(numberPrice('12,345'), null);
  assert.equal(numberPrice('-3,20'), null);
  assert.equal(numberPrice('1/2'), null);
  assert.equal(numberPrice('gratuit'), null);
  assert.equal(numberPrice('1 234'), 1234);
  assert.equal(numberPrice('1 234,56 €'), 1234.56);
  assert.equal(numberPrice('3.49'), 3.49);
  assert.equal(numberPrice('2,90'), 2.9);
  assert.equal(numberPrice(4), 4);
});

test('Product.url est la preuve ; Offer.url est ignoré', async () => {
  const page = fakePage([JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'Gel douche test',
    brand: { '@type': 'Brand', name: 'Marque test' },
    gtin13: '4006381333931',
    sku: 'SKU-1',
    mpn: 'MPN-9',
    image: 'https://shop.example/image.jpg',
    url: 'https://shop.example/p/gel-douche',
    offers: {
      '@type': 'Offer',
      price: '3.49',
      priceCurrency: 'EUR',
      availability: 'https://schema.org/InStock',
      url: 'https://shop.example/catalogue',
      seller: { identifier: 'store-7' },
    },
  })]);

  const products = await extractProducts(page, 'https://shop.example/categorie', {}, {
    baseUrl: 'https://shop.example',
  });

  assert.equal(products.length, 1);
  const product = products[0];
  assert.equal(product.name, 'Gel douche test');
  assert.equal(product.brand, 'Marque test');
  assert.equal(product.price, 3.49);
  assert.equal(product.currency, 'EUR');
  assert.equal(product.gtin, '4006381333931');
  assert.equal(product.sku, 'SKU-1');
  assert.equal(product.merchantRef, 'MPN-9');
  assert.equal(product.merchantId, 'store-7');
  assert.equal(product.productUrl, 'https://shop.example/p/gel-douche');
  assert.equal(product.productUrlEvidence, 'jsonld-product-url');
  assert.equal(product.discoveredFrom, 'https://shop.example/categorie');
  assert.equal(product.cardUrl, null);
  assert.equal(product.availability, 'In Stock');
});

test('Offer.url seul ne promeut jamais une URL de fiche', async () => {
  const page = fakePage([JSON.stringify({
    '@type': 'Product',
    name: 'Produit sans Product.url',
    offers: { '@type': 'Offer', price: '5.00', priceCurrency: 'EUR', url: '/p/cachee' },
  })]);

  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, {
    baseUrl: 'https://shop.example',
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, null);
  assert.equal(products[0].productUrlEvidence, null);
});

test('WebPage.mainEntity fournit une preuve de fiche', async () => {
  const page = fakePage([
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url: 'https://shop.example/p/cafe',
      mainEntity: { '@type': 'Product', '@id': 'https://shop.example/p/cafe#product' },
    }),
    JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Product',
      '@id': 'https://shop.example/p/cafe#product',
      name: 'Café moulu',
      offers: { '@type': 'Offer', price: '5,20', priceCurrency: 'EUR' },
    }),
  ]);

  const products = await extractProducts(page, 'https://shop.example/p/cafe', {}, {
    baseUrl: 'https://shop.example',
    productPattern: /\/p\//,
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, 'https://shop.example/p/cafe');
  assert.equal(products[0].productUrlEvidence, 'webpage-mainentity');
});

test('plusieurs offres produisent plusieurs observations du même produit', async () => {
  const page = fakePage([JSON.stringify({
    '@type': 'Product',
    name: 'Lessive',
    url: '/p/lessive',
    offers: [
      { '@type': 'Offer', price: '7.99', priceCurrency: 'EUR', availableAtOrFrom: { name: 'Paris' } },
      { '@type': 'Offer', price: '8.49', priceCurrency: 'EUR', availableAtOrFrom: { name: 'Lyon' } },
    ],
  })]);

  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, {
    baseUrl: 'https://shop.example',
  });

  assert.equal(products.length, 2);
  assert.deepEqual(products.map((item) => item.storeCode).sort(), ['Lyon', 'Paris']);
  assert.equal(new Set(products.map((item) => item.productUrl)).size, 1);
});

test('un lien de carte individuel est une preuve de fiche', async () => {
  const page = fakePage({
    cards: [
      fakeCard({
        '#cards': {},
        h2: { text: 'Shampooing doux' },
        '.product-link': { attrs: { href: '/produit/shampooing-doux' } },
        'a[href]': { attrs: { href: '/navigation/accueil' } },
        '.price': { text: '4,10 €' },
      }),
    ],
  });

  const products = await extractProducts(
    page,
    'https://shop.example/catalogue',
    { productCard: '#cards', productLink: '.product-link', name: 'h2', price: '.price' },
    { baseUrl: 'https://shop.example', productPattern: /\/p\// },
  );

  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, 'https://shop.example/produit/shampooing-doux');
  assert.equal(products[0].productUrlEvidence, 'css-card-link');
  assert.equal(products[0].cardUrl, 'https://shop.example/produit/shampooing-doux');
  assert.equal(products[0].discoveredFrom, 'https://shop.example/catalogue');
});

test('une page catalogue sans preuve garde product_url nulle', async () => {
  const page = fakePage({
    cards: [fakeCard({
      '#cards': {},
      h2: { text: 'Produit sans lien' },
      '.price': { text: '2,00 €' },
    })],
  });

  const products = await extractProducts(
    page,
    'https://shop.example/catalogue',
    { productCard: '#cards', name: 'h2', price: '.price' },
    { baseUrl: 'https://shop.example' },
  );

  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, null);
  assert.equal(products[0].productUrlEvidence, null);
  assert.equal(products[0].discoveredFrom, 'https://shop.example/catalogue');
});

test('une page reconnue par la source peut être sa propre fiche', async () => {
  const page = fakePage({
    detail: { h1: { text: 'Lessive liquide' }, '.price': { text: '7,99 €' } },
  });

  const products = await extractProducts(
    page,
    'https://shop.example/p/lessive',
    { name: 'h1', price: '.price' },
    { baseUrl: 'https://shop.example', productPattern: /\/p\// },
  );

  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, 'https://shop.example/p/lessive');
  assert.equal(products[0].productUrlEvidence, 'product-url-regex');
});

test('AggregateOffer ne devient pas une observation individuelle', async () => {
  const page = fakePage([JSON.stringify({
    '@type': 'Product',
    name: 'Coffret varié',
    url: '/p/coffret',
    offers: { '@type': 'AggregateOffer', lowPrice: '9.90', highPrice: '19.90', priceCurrency: 'EUR' },
  })]);

  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, {
    baseUrl: 'https://shop.example',
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].price, null);
  assert.equal(products[0].aggregateOffer, true);
});

test('une devise inconnue reste nulle', async () => {
  const page = fakePage([JSON.stringify({
    '@type': 'Product',
    name: 'Produit sans devise',
    url: '/p/sans-devise',
    offers: { '@type': 'Offer', price: '9.90' },
  })]);

  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, {
    baseUrl: 'https://shop.example',
  });

  assert.equal(products.length, 1);
  assert.equal(products[0].currency, null);
});

test('JSON-LD imbriqué et graphe multiple', async () => {
  const page = fakePage([JSON.stringify({ '@graph': [
    { '@type': 'Product', name: 'Produit A', url: '/p/a', offers: { price: '2,90' } },
    {
      '@type': 'ProductGroup',
      name: 'Produit B',
      url: '/p/b',
      hasVariant: [
        { '@type': 'Product', name: 'B XL', url: '/p/b?size=XL', offers: { price: '4.20' } },
      ],
    },
  ] })]);

  const products = await extractProducts(page, 'https://shop.example/categorie', {}, {
    baseUrl: 'https://shop.example',
  });

  assert.equal(products.length, 2);
  assert.equal(products[0].price, 2.9);
  assert.equal(products[1].name, 'B XL');
  assert.equal(products[1].productUrl, 'https://shop.example/p/b?size=XL');
});

test('valide le motif produit et le filtrage de domaine', () => {
  assert.equal(compileProductPattern('/(product|p)/').test('/p/abc'), true);
  assert.equal(isSameHost('https://shop.example/p/abc', 'https://shop.example'), true);
  assert.equal(isSameHost('https://other.example/p/abc', 'https://shop.example'), false);
  assert.equal(isSameOrigin('https://shop.example:8443/p/abc', 'https://shop.example'), false);
  assert.equal(isSameOrigin('http://shop.example/p/abc', 'https://shop.example'), false);
  assert.equal(isSameOrigin('https://user:pass@shop.example/p/abc', 'https://shop.example'), false);
  assert.equal(isSameOrigin('https://shop.example/p/abc', 'https://shop.example'), true);
  assert.throws(() => compileProductPattern('['));
});


test('un lien générique de navigation ne prouve pas une fiche produit', async () => {
  const page = fakePage({
    cards: [fakeCard({
      '#cards': {},
      h2: { text: 'Produit de catalogue' },
      'a[href]': { attrs: { href: '/navigation/accueil' } },
      '.price': { text: '3,90 €' },
    })],
  });
  const products = await extractProducts(page, 'https://shop.example/catalogue', {
    productCard: '#cards', name: 'h2', price: '.price',
  }, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, null);
  assert.equal(products[0].discoveredFrom, 'https://shop.example/catalogue');
});

test('productDetail configuré mais absent de la page ne prouve rien', async () => {
  const page = fakePage({ detail: { h1: { text: 'Titre catalogue' }, '.price': { text: '2,50 €' } } });
  const products = await extractProducts(page, 'https://shop.example/catalogue', {
    name: 'h1', price: '.price', productDetail: '.detail-marker',
  }, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 0);
});

test('productDetail prouve la fiche seulement si le sélecteur existe réellement', async () => {
  const page = fakePage({ detail: {
    h1: { text: 'Fiche produit' }, '.price': { text: '2,50 €' }, '.detail-marker': { text: 'product' },
  } });
  const products = await extractProducts(page, 'https://shop.example/item', {
    name: 'h1', price: '.price', productDetail: '.detail-marker',
  }, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 1);
  assert.equal(products[0].productUrl, 'https://shop.example/item');
  assert.equal(products[0].productUrlEvidence, 'product-detail');
});

test('SKU seul reste secondaire et n’est jamais promu en merchantRef', async () => {
  const page = fakePage([JSON.stringify({
    '@type': 'https://schema.org/Product',
    name: 'Produit SKU seulement',
    sku: 'SKU-ONLY-1',
    offers: { '@type': 'https://schema.org/Offer', price: '9.90', priceCurrency: 'EUR' },
  })]);
  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 1);
  assert.equal(products[0].sku, 'SKU-ONLY-1');
  assert.equal(products[0].merchantRef, null);
});

test('merchantId CSS lit la valeur du sélecteur, jamais son texte de configuration', async () => {
  const page = fakePage({
    cards: [fakeCard({
      '#cards': {}, h2: { text: 'Produit marchand' },
      '.product-link': { attrs: { href: '/p/merchant' } },
      '[data-merchant]': { attrs: { 'data-merchant': 'MERCHANT-42' } },
      '.price': { text: '5,00 €' },
    })],
  });
  const products = await extractProducts(page, 'https://shop.example/catalogue', {
    productCard: '#cards', productLink: '.product-link', name: 'h2', price: '.price',
    merchantId: '[data-merchant]', merchantIdAttribute: 'data-merchant',
  }, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 1);
  assert.equal(products[0].merchantId, 'MERCHANT-42');
});

test('JSON-LD et CSS sont combinés avec conservation des deux provenances', async () => {
  const page = fakePage({
    jsonLd: [{
      '@type': 'Product', name: 'Savon', url: '/p/savon', brand: 'Marque',
      offers: { '@type': 'Offer', price: '3.50', priceCurrency: 'EUR' },
    }],
    cards: [fakeCard({
      '#cards': {}, h2: { text: 'Savon' }, '.product-link': { attrs: { href: '/p/savon' } },
      '.price': { text: '3,50 €' }, '.brand': { text: 'Marque' },
    })],
  });
  const products = await extractProducts(page, 'https://shop.example/catalogue', {
    productCard: '#cards', productLink: '.product-link', name: 'h2', price: '.price', brand: '.brand',
  }, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 1);
  assert.deepEqual(products[0].extractionSources.map((source) => source.method).sort(), ['css', 'jsonld']);
  assert.equal(products[0].brand, 'Marque');
  assert.equal(products[0].productUrl, 'https://shop.example/p/savon');
});


test('fusion multi-source conserve les indices JSON-LD et CSS', async () => {
  const card = fakeCard({
    '.name': { text: 'Produit multi-source' },
    '.price': { text: '4,90 €' },
    '.link': { attrs: { href: '/p/multi' } },
  });
  const page = fakePage({
    jsonLd: [{
      '@context': 'https://schema.org', '@type': 'Product',
      name: 'Produit multi-source', url: 'https://shop.example/p/multi',
      offers: { '@type': 'Offer', price: '4.90', priceCurrency: 'EUR' },
    }],
    cards: [card], cardSelector: '.card',
  });
  const products = await extractProducts(page, 'https://shop.example/catalogue', {
    productCard: '.card', productLink: '.link', name: '.name', price: '.price',
  }, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 1);
  assert.deepEqual(products[0].extractionSources.map((item) => item.method).sort(), ['css', 'jsonld']);
  assert.equal(products[0].extractionSources.find((item) => item.method === 'jsonld').jsonldIndex, 0);
  assert.equal(products[0].extractionSources.find((item) => item.method === 'css').selectorIndex, 0);
});

test('deux fiches différentes portant le même nom et prix restent distinctes', async () => {
  const page = fakePage([
    { '@type': 'Product', name: 'Produit homonyme', url: 'https://shop.example/p/a', offers: { '@type': 'Offer', price: '4.90', priceCurrency: 'EUR' } },
    { '@type': 'Product', name: 'Produit homonyme', url: 'https://shop.example/p/b', offers: { '@type': 'Offer', price: '4.90', priceCurrency: 'EUR' } },
  ]);
  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 2);
  assert.deepEqual(products.map((item) => item.productUrl).sort(), [
    'https://shop.example/p/a', 'https://shop.example/p/b',
  ]);
});


test('une source sans URL ne fusionne pas arbitrairement des fiches homonymes', async () => {
  const page = fakePage([
    { '@type': 'Product', name: 'Produit homonyme', url: 'https://shop.example/p/a', offers: { '@type': 'Offer', price: '4.90', priceCurrency: 'EUR' } },
    { '@type': 'Product', name: 'Produit homonyme', url: 'https://shop.example/p/b', offers: { '@type': 'Offer', price: '4.90', priceCurrency: 'EUR' } },
    { '@type': 'Product', name: 'Produit homonyme', offers: { '@type': 'Offer', price: '4.90', priceCurrency: 'EUR' } },
  ]);
  const products = await extractProducts(page, 'https://shop.example/catalogue', {}, { baseUrl: 'https://shop.example' });
  assert.equal(products.length, 3);
  assert.equal(products.filter((item) => item.productUrl === null).length, 1);
});
