import { parseDateOnly } from './offer-validity.js';

export function parseEnabledOfferSources(value, approvedValue = '') {
  const allowed = new Set(['lidl', 'franprix']);
  const requested = new Set(
    String(value ?? '')
      .split(',')
      .map(source => source.trim().toLowerCase())
      .filter(source => allowed.has(source)),
  );
  const approved = new Set(
    String(approvedValue ?? '')
      .split(',')
      .map(source => source.trim().toLowerCase())
      .filter(source => allowed.has(source)),
  );
  // Deux opt-in séparés : activation opérationnelle + validation documentée des droits.
  return new Set([...requested].filter(source => approved.has(source)));
}

export function extractDiscount(text) {
  const source = String(text ?? '');

  const reductions = [
    ...new Set(
      [...source.matchAll(/[-−]\s*\d{1,2}\s*%/gu)]
        .map(match => match[0].replace(/\s+/g, ' ').trim())
    ),
  ];

  const cashback = [
    ...new Set(
      [...source.matchAll(
        /\b(?:cagnottez|cagnotez)\s*(\d{1,2})\s*%|\b(\d{1,2})\s*%\s*(?:cagnott(?:é|és|ée|ées)|en cagnotte)\b/giu
      )].map(match => `${match[1] || match[2]} % en cagnotte`)
    ),
  ];

  return [...new Set([...reductions, ...cashback])]
    .join(' + ')
    .slice(0, 100) || null;
}


export function isEligibleNationalFlyer(flyer, today) {
  if (!flyer || flyer.status !== 'current') return false;
  if (!parseDateOnly(today)) return false;
  if (
    !Array.isArray(flyer.regions) ||
    !flyer.regions.some(region => region?.type === 'national')
  ) return false;

  if (!flyer.id || !flyer.flyerJson || !flyer.flyerUrlAbsolute) return false;

  const start = flyer.offerStartDate;
  const end = flyer.offerEndDate;

  if (!parseDateOnly(start) || !parseDateOnly(end)) return false;
  if (start > end || end < today) return false;

  // Les catalogues futurs sont admis : offerStatus les garde en brouillon.
  return true;
}

export function classifyLidlFlyer(flyer) {
  const title = `${flyer?.title || ''} ${flyer?.name || ''}`
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (/exclus.*web|web.*exclus/.test(title)) {
    return {
      scope: 'online',
      discountLabel: 'Exclusivement en ligne',
      terms:
        'Catalogue Lidl exclusivement réservé à la boutique en ligne. ' +
        'Ne pas présenter comme une promotion disponible en magasin.',
    };
  }

  if (/noel/.test(title)) {
    return {
      scope: 'brand',
      discountLabel: 'Catalogue mixte magasin et web',
      terms:
        'Catalogue saisonnier Lidl à disponibilité mixte, en magasin et en ligne. ' +
        'La disponibilité physique de chaque référence dépend du magasin et des stocks. ' +
        'Aucun prix de référence fiable fourni : aucun pourcentage de réduction déduit.',
    };
  }

  return {
    scope: 'brand',
    discountLabel: 'Catalogue magasin',
    terms:
      'Catalogue national Lidl destiné aux magasins. ' +
      'Disponibilité selon les magasins participants et les stocks. ' +
      'Aucun prix de référence fiable fourni : aucun pourcentage de réduction déduit.',
  };
}
