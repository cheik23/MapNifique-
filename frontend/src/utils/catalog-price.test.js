import test from 'node:test';
import assert from 'node:assert/strict';
import { formatCatalogPrice } from './catalog-price.js';

test('affiche une devise explicitement connue', () => {
  const result = formatCatalogPrice(12.5, 'EUR');
  assert.equal(result.currencyKnown, true);
  assert.match(result.text, /12,50/);
  assert.match(result.text, /€/);
});

test('ne transforme jamais une devise inconnue en euros', () => {
  const result = formatCatalogPrice(12.5, null);
  assert.equal(result.currencyKnown, false);
  assert.equal(result.text, '12,50');
  assert.doesNotMatch(result.text, /€/);
});

test('une devise à trois lettres invalide reste non confirmée', () => {
  const result = formatCatalogPrice(12.5, 'ZZZ');
  assert.equal(result.currencyKnown, false);
  assert.equal(result.text, '12,50');
});

test('un prix absent, négatif ou non numérique ne s affiche pas', () => {
  assert.equal(formatCatalogPrice(null, 'EUR'), null);
  assert.equal(formatCatalogPrice(-1, 'EUR'), null);
  assert.equal(formatCatalogPrice('12.50', 'EUR'), null);
  assert.equal(formatCatalogPrice(Number.NaN, 'EUR'), null);
});
