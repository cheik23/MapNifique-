import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractDiscount,
  isEligibleNationalFlyer,
  classifyLidlFlyer,
  parseEnabledOfferSources,
} from './offers-utils.js';

test('aucune source d’offre n’est activée sans opt-in explicite', () => {
  assert.deepEqual([...parseEnabledOfferSources(undefined)], []);
  assert.deepEqual([...parseEnabledOfferSources('')], []);
});

test('une source reste désactivée sans approbation de conformité séparée', () => {
  assert.deepEqual([...parseEnabledOfferSources(' LIDL,Franprix ')], []);
  assert.deepEqual([...parseEnabledOfferSources('LIDL', 'Franprix')], []);
});

test('les sources sont normalisées et activées uniquement avec double opt-in', () => {
  assert.deepEqual(
    [...parseEnabledOfferSources(' LIDL, inconnu,Franprix,lidl ', 'franprix')],
    ['franprix'],
  );
  assert.deepEqual(
    [...parseEnabledOfferSources(' LIDL, inconnu,Franprix,lidl ', 'lidl,FRANPRIX')],
    ['lidl', 'franprix'],
  );
});

test('détecte cagnottez 35 %', () => {
  assert.equal(
    extractDiscount("Jusqu'au 14 novembre cagnottez 35%"),
    '35 % en cagnotte',
  );
});

test('détecte 34 % cagnottés', () => {
  assert.equal(extractDiscount('34% cagnottés'), '34 % en cagnotte');
});

test('détecte une réduction immédiate', () => {
  assert.equal(extractDiscount('Réduction spéciale -30 %'), '-30 %');
});

test('détecte réduction et cagnotte ensemble', () => {
  assert.equal(
    extractDiscount('Réduction -10% et cagnottez 35%'),
    '-10% + 35 % en cagnotte',
  );
});

test('ne fabrique pas de réduction absente', () => {
  assert.equal(extractDiscount('Promotion sur ce produit'), null);
});

test('accepte les espaces entre le chiffre et le pourcentage', () => {
  assert.equal(extractDiscount('Cagnottez 35 %'), '35 % en cagnotte');
});


const sampleFlyer = {
  id: 'flyer-1',
  status: 'current',
  regions: [{ type: 'national' }],
  flyerJson: 'https://example.test/flyer.json',
  flyerUrlAbsolute: 'https://www.lidl.fr/catalogue',
  offerStartDate: '2026-11-12',
  offerEndDate: '2026-11-18',
};

test('accepte un catalogue national futur pour préparation en brouillon', () => {
  assert.equal(isEligibleNationalFlyer(sampleFlyer, '2026-11-09'), true);
});

test('accepte un catalogue national actuellement valide', () => {
  assert.equal(isEligibleNationalFlyer({
    ...sampleFlyer,
    offerStartDate: '2026-11-05',
    offerEndDate: '2026-11-11',
  }, '2026-11-09'), true);
});

test('refuse un catalogue expiré', () => {
  assert.equal(isEligibleNationalFlyer({
    ...sampleFlyer,
    offerStartDate: '2026-10-01',
    offerEndDate: '2026-10-10',
  }, '2026-11-09'), false);
});

test('refuse un catalogue régional', () => {
  assert.equal(isEligibleNationalFlyer({
    ...sampleFlyer,
    regions: [{ type: 'regional' }],
  }, '2026-11-09'), false);
});

test('refuse une date invalide', () => {
  assert.equal(isEligibleNationalFlyer({
    ...sampleFlyer,
    offerStartDate: 'date-invalide',
  }, '2026-11-09'), false);
});

test('classe les Exclus Web dans online', () => {
  assert.equal(classifyLidlFlyer({
    title: 'Les Exclus Web de la semaine',
    name: 'Du 09/11 au 12/11',
  }).scope, 'online');
});

test('classe les promotions hebdomadaires comme magasin', () => {
  const result = classifyLidlFlyer({
    title: 'Les promos de la semaine',
    name: 'Du 12/11 au 18/11',
  });
  assert.equal(result.scope, 'brand');
  assert.equal(result.discountLabel, 'Catalogue magasin');
});

test('classe Noël comme catalogue mixte', () => {
  const result = classifyLidlFlyer({
    title: 'Du 29/10 au 27/12',
    name: 'Catalogue de Noël',
  });
  assert.equal(result.scope, 'brand');
  assert.match(result.discountLabel, /mixte/i);
});
