const DEFAULT_SCRAPER_API = 'http://127.0.0.1:8787';
const API_BASE = String(import.meta.env?.VITE_MAPNIQUE_SCRAPER_API || DEFAULT_SCRAPER_API).replace(/\/$/, '');

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const normalize = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/&/g, ' et ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const safeHttpUrl = (value) => {
  try {
    const url = new URL(String(value || ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
};

const formatDistance = (meters) => {
  if (!Number.isFinite(meters)) return '';
  if (meters < 1000) return `${Math.max(1, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} km`;
};

const distanceMeters = (a, b) => {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const toRad = (value) => value * Math.PI / 180;
  const lat1 = Number(a.lat);
  const lon1 = Number(a.lng ?? a.lon);
  const lat2 = Number(b.lat);
  const lon2 = Number(b.lng ?? b.lon);
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return Number.POSITIVE_INFINITY;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(h));
};


const normalizeLocalPlace = (place) => {
  const address = place?.address && typeof place.address === 'object' ? place.address : {};
  const category = String(place?.category || '');
  const splitAt = category.indexOf('=');
  const tagKey = splitAt > 0 ? category.slice(0, splitAt) : '';
  const tagValue = splitAt > 0 ? category.slice(splitAt + 1) : '';
  const tags = {
    ...address,
    name: place?.name,
    brand: place?.brand || undefined,
    phone: place?.phone || undefined,
    website: place?.website || undefined,
    image: place?.imageUrl || undefined,
    opening_hours: place?.openingHours || undefined,
    source: 'AllThePlaces',
    __source_url: place?.sourceUrl || undefined,
  };
  if (tagKey && tagValue) tags[tagKey] = tagValue;
  return {
    id: `local-place-${place.id}`,
    localId: place.id,
    sourceId: place.sourceId,
    brandKey: place.brandKey,
    lat: Number(place.lat),
    lon: Number(place.lon),
    tags,
  };
};

const isCategoryMatch = (place, tag) => {
  if (!tag) return true;
  const category = String(place?.category || '');
  if (tag === 'shop=beauty') return ['shop=beauty', 'shop=cosmetics', 'shop=perfumery'].includes(category);
  if (tag === 'shop=supermarket') {
    return ['shop=supermarket', 'shop=convenience', 'shop=grocery'].includes(category);
  }
  return category === tag;
};

const tagsOf = (place) => place?.tags && typeof place.tags === 'object' ? place.tags : {};
const placeName = (place) => {
  const tags = tagsOf(place);
  return tags.name || tags.brand || tags.operator || 'Établissement';
};

const placeAddress = (place) => {
  const tags = tagsOf(place);
  const street = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ')
    || tags['addr:street_address']
    || '';
  return [street, tags['addr:postcode'], tags['addr:city'] || tags['addr:town'] || tags['addr:village']]
    .filter(Boolean).join(', ')
    || tags['addr:full']
    || tags.address
    || '';
};

const categoryLabel = (place) => {
  const tags = tagsOf(place);
  const raw = tags.shop || tags.amenity || tags.tourism || tags.leisure || tags.office || tags.healthcare || '';
  const labels = {
    beauty: 'Beauté et cosmétiques', cosmetics: 'Beauté et cosmétiques', perfumery: 'Parfumerie',
    supermarket: 'Supermarché', convenience: 'Commerce de proximité', clothes: 'Mode et vêtements',
    shoes: 'Chaussures', hairdresser: 'Coiffeur', restaurant: 'Restaurant', fast_food: 'Restauration rapide',
    cafe: 'Café', pharmacy: 'Pharmacie', bank: 'Banque', fuel: 'Station-service', hotel: 'Hôtel',
    cinema: 'Cinéma', electronics: 'Électronique', department_store: 'Grand magasin',
  };
  return labels[raw] || String(raw).replace(/_/g, ' ') || 'Commerce et service';
};

const renderOfferCard = (offer, label) => {
  const href = safeHttpUrl(offer.landingUrl || offer.url || offer.landing_url);
  const end = offer.validUntil || offer.endDate || offer.valid_until;
  const endLabel = end ? ` · Jusqu'au ${escapeHtml(new Date(end).toLocaleDateString('fr-FR'))}` : '';
  const discount = offer.discountLabel || offer.discount_label || offer.valueLabel || '';
  const code = offer.code || offer.promoCode || offer.promo_code || '';
  const source = offer.sourceName || offer.source_name || offer.advertiser || '';
  return `
    <article class="mn-offer-card">
      <div class="mn-offer-meta"><span>${escapeHtml(label)}</span>${source ? `<span>${escapeHtml(source)}</span>` : ''}</div>
      <strong>${escapeHtml(offer.title || 'Offre')}</strong>
      ${discount ? `<div class="mn-offer-discount">${escapeHtml(discount)}</div>` : ''}
      ${offer.description ? `<p>${escapeHtml(offer.description)}</p>` : ''}
      ${code ? `<div class="mn-offer-code">Code : <code>${escapeHtml(code)}</code></div>` : ''}
      ${offer.terms ? `<details><summary>Conditions</summary><p>${escapeHtml(offer.terms)}</p></details>` : ''}
      <div class="mn-offer-validity">${endLabel || 'Conditions et validité à consulter chez le marchand'}</div>
      ${href ? `<a class="mn-offer-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer sponsored">Voir l'offre</a>` : ''}
    </article>`;
};

const styleText = `
#mn-discovery { position:fixed; z-index:9500; top:clamp(210px,27vh,280px); left:12px; bottom:76px; width:min(900px,calc(100vw - 24px)); max-height:none; display:none; grid-template-columns:minmax(250px,.85fr) minmax(320px,1.15fr); overflow:hidden; background:#fff; color:#171717; border:1px solid #e5e7eb; border-radius:18px; box-shadow:0 12px 36px rgba(15,23,42,.28); font:14px/1.4 system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
#mn-discovery.is-open { display:grid !important; visibility:visible !important; opacity:1 !important; pointer-events:auto !important; }
#mn-discovery .mn-list-pane,#mn-discovery .mn-detail-pane { min-width:0; overflow:auto; overscroll-behavior:contain; background:#fff; }
#mn-discovery .mn-list-pane { border-right:1px solid #e5e7eb; }
#mn-discovery .mn-pane-head { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:14px 16px; background:rgba(255,255,255,.96); border-bottom:1px solid #e5e7eb; backdrop-filter:blur(8px); }
#mn-discovery .mn-pane-head strong { font-size:16px; color:#151515; }
#mn-discovery .mn-pane-sub { color:#6b7280; font-size:12px; margin-top:2px; }
#mn-discovery button { border:0; background:#f3f4f6; color:#222; border-radius:999px; min-width:34px; min-height:34px; cursor:pointer; font:inherit; }
#mn-discovery .mn-place-row { display:flex; width:100%; text-align:left; gap:11px; align-items:flex-start; padding:13px 14px; border-bottom:1px solid #f0f0f0; background:#fff; border-radius:0; }
#mn-discovery .mn-place-row:hover,#mn-discovery .mn-place-row.is-active { background:#f5f9ff; }
#mn-discovery .mn-place-icon { display:flex; align-items:center; justify-content:center; flex:0 0 40px; height:40px; border-radius:12px; background:#eef3fb; font-size:20px; }
#mn-discovery .mn-place-copy { display:flex; flex-direction:column; gap:3px; min-width:0; flex:1; }
#mn-discovery .mn-place-copy strong { color:#171717; font-size:14px; }
#mn-discovery .mn-place-copy span { color:#646b75; font-size:12px; overflow-wrap:anywhere; }
#mn-discovery .mn-offer-pill { align-self:flex-start; border-radius:999px; background:#e8f7ed; color:#176b36; padding:3px 8px; font-size:11px; font-weight:650; }
#mn-discovery .mn-detail-content { padding:15px 16px 20px; }
#mn-discovery .mn-detail-title { margin:0 0 4px; font-size:21px; line-height:1.2; color:#111827; }
#mn-discovery .mn-detail-category { color:#6b7280; font-size:13px; margin-bottom:12px; }
#mn-discovery .mn-detail-image { width:100%; max-height:170px; object-fit:cover; border-radius:12px; margin-bottom:12px; background:#f3f4f6; }
#mn-discovery .mn-info-grid { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin:12px 0 16px; }
#mn-discovery .mn-info-item { border:1px solid #eceff2; border-radius:10px; padding:9px; min-width:0; }
#mn-discovery .mn-info-item small { color:#6b7280; display:block; font-size:11px; margin-bottom:3px; }
#mn-discovery .mn-info-item strong,#mn-discovery .mn-info-item a { color:#242424; font-size:12px; overflow-wrap:anywhere; }
#mn-discovery .mn-action-row { display:flex; gap:8px; margin:12px 0 18px; }
#mn-discovery .mn-action { display:inline-flex; align-items:center; justify-content:center; flex:1; min-height:38px; border-radius:10px; background:#e8f6fa; color:#07596a; text-decoration:none; font-weight:650; font-size:12px; padding:7px; }
#mn-discovery .mn-action-primary { background:#087f8c; color:#fff; }
#mn-discovery .mn-section-title { display:flex; justify-content:space-between; gap:8px; align-items:center; margin:17px 0 8px; color:#171717; font-size:15px; }
#mn-discovery .mn-section-title small { color:#7b8490; font-size:11px; font-weight:400; }
#mn-discovery .mn-offer-card { border:1px solid #e5e7eb; border-radius:12px; padding:11px; margin:8px 0; background:#fff; }
#mn-discovery .mn-offer-meta { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:6px; color:#687280; font-size:10px; }
#mn-discovery .mn-offer-card strong { display:block; font-size:13px; color:#161616; }
#mn-discovery .mn-offer-discount { color:#087f43; font-size:16px; font-weight:750; margin-top:4px; }
#mn-discovery .mn-offer-card p { color:#4b5563; font-size:12px; margin:6px 0; }
#mn-discovery .mn-offer-code { background:#f7f7f8; border-radius:7px; padding:6px; margin:6px 0; font-size:12px; }
#mn-discovery .mn-offer-card details { font-size:11px; color:#59616d; margin:6px 0; }
#mn-discovery .mn-offer-validity { color:#7b8490; font-size:10px; margin:7px 0; }
#mn-discovery .mn-offer-link { display:inline-block; color:#086c7b; font-size:12px; font-weight:700; text-decoration:none; margin-top:4px; }
#mn-discovery .mn-empty { color:#687280; font-size:12px; background:#f8fafc; border-radius:10px; padding:11px; }
#mn-discovery .mn-source-note { color:#7b8490; font-size:10px; margin-top:12px; }
@media (max-width:720px) {
  #mn-discovery { top:auto; left:8px; right:8px; bottom:72px; width:auto; height:min(64dvh,620px); max-height:calc(100dvh - 190px); grid-template-columns:1fr; border-radius:18px; z-index:9500; }
  #mn-discovery .mn-list-pane { border-right:0; }
  #mn-discovery .mn-detail-pane { display:none; }
  #mn-discovery.has-detail .mn-list-pane { display:none; }
  #mn-discovery.has-detail .mn-detail-pane { display:block; }
  #mn-discovery .mn-info-grid { grid-template-columns:1fr 1fr; }
}
`;

export function createPlacesExperience({ getMap = () => null, onRoute = () => {} } = {}) {
  if (typeof document === 'undefined') {
    return { renderResults() {}, showDetails() {}, close() {} };
  }

  let root = document.getElementById('mn-discovery');
  if (!root) {
    if (!document.getElementById('mn-discovery-style')) {
      const style = document.createElement('style');
      style.id = 'mn-discovery-style';
      style.textContent = styleText;
      document.head.appendChild(style);
    }
    root = document.createElement('section');
    root.id = 'mn-discovery';
    root.setAttribute('aria-label', 'Résultats et détails des établissements');
    root.innerHTML = `
      <div class="mn-list-pane">
        <div class="mn-pane-head"><div><strong>Autour de vous</strong><div class="mn-pane-sub" data-mn-result-count>Résultats</div></div><button type="button" data-mn-close aria-label="Fermer">✕</button></div>
        <div data-mn-list></div>
      </div>
      <div class="mn-detail-pane">
        <div class="mn-pane-head"><button type="button" data-mn-back aria-label="Retour aux résultats">←</button><div><strong>Fiche établissement</strong><div class="mn-pane-sub">Informations et avantages</div></div><button type="button" data-mn-close aria-label="Fermer">✕</button></div>
        <div class="mn-detail-content" data-mn-detail><div class="mn-empty">Sélectionnez un établissement pour consulter sa fiche.</div></div>
      </div>`;
    document.body.appendChild(root);
  }

  const list = root.querySelector('[data-mn-list]');
  const detail = root.querySelector('[data-mn-detail]');
  const count = root.querySelector('[data-mn-result-count]');
  let currentPlaces = [];
  let currentCenter = null;
  let selectedIndex = -1;
  let detailRequestToken = 0;

  const close = () => {
    detailRequestToken += 1;
    root.classList.remove('is-open', 'has-detail');
    selectedIndex = -1;
  };

  root.querySelectorAll('[data-mn-close]').forEach((button) => button.addEventListener('click', close));
  root.querySelector('[data-mn-back]')?.addEventListener('click', () => root.classList.remove('has-detail'));

  const merchantKeyFor = (place) => {
    const tags = tagsOf(place);
    if (place.brandKey) return normalize(place.brandKey).replace(/\s+/g, '-');
    const rawName = tags.brand || tags.operator || tags.name || '';
    const normalizedName = normalize(rawName);
    const knownBrands = [
      'sephora', 'marionnaud', 'nocibe', 'yves rocher', 'franck provost', 'jean louis david',
      'carrefour', 'auchan', 'lidl', 'aldi', 'monoprix', 'franprix', 'intermarche',
      'mcdonald s', 'burger king', 'kfc', 'darty', 'fnac', 'decathlon', 'leroy merlin',
      'castorama', 'ikea', 'gifi', 'action', 'histoire d or', 'krys',
    ];
    const match = knownBrands.find((brand) => normalizedName === brand || normalizedName.startsWith(`${brand} `));
    return normalize(match || rawName).replace(/\s+/g, '-');
  };

  const fetchLocalOffers = async (place) => {
    const tags = tagsOf(place);
    const params = new URLSearchParams({
      merchantKey: merchantKeyFor(place),
      lat: String(place.lat),
      lon: String(place.lon),
    });
    if (place.localId) params.set('placeId', String(place.localId));
    try {
      const response = await fetch(`${API_BASE}/api/offers?${params}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.info('[MapNifique] API locale des offres indisponible :', error?.message || error);
      return null;
    }
  };

  const fetchAffiliateOffers = async (place) => {
    try {
      const response = await fetch('/api/offers?type=all', {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      });
      if (!response.ok) return [];
      const payload = await response.json();
      const expected = normalize(tagsOf(place).brand || tagsOf(place).name);
      return (Array.isArray(payload.offers) ? payload.offers : []).filter((offer) => {
        const advertiser = normalize(offer.advertiser);
        return expected && advertiser && (advertiser === expected || advertiser.startsWith(`${expected} `) || expected.startsWith(`${advertiser} `));
      });
    } catch {
      return [];
    }
  };

  const showDetails = async (place, center = currentCenter, index = -1) => {
    if (!place) return;
    const requestToken = ++detailRequestToken;
    if (index < 0) {
      index = currentPlaces.findIndex((candidate) => candidate === place || (place.id && candidate.id === place.id));
    }
    selectedIndex = index;
    list.querySelectorAll('.mn-place-row').forEach((row) => {
      row.classList.toggle('is-active', Number(row.dataset.mnPlaceIndex) === selectedIndex && selectedIndex >= 0);
    });
    root.classList.add('is-open', 'has-detail');
    const tags = tagsOf(place);
    const name = placeName(place);
    const address = placeAddress(place);
    const distance = center ? formatDistance(distanceMeters(center, place)) : '';
    const website = safeHttpUrl(tags.website || tags['contact:website'] || tags.url);
    const phone = tags.phone || tags['contact:phone'] || '';
    const image = safeHttpUrl(tags.image || tags['contact:image']);
    const hours = tags.opening_hours || tags['opening_hours:covid19'] || '';
    const mapLink = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${place.lat},${place.lon}`)}`;
    const websiteLink = website ? `<a href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer">Site officiel ↗</a>` : '<span>Non renseigné</span>';
    const phoneLink = phone ? `<a href="tel:${escapeHtml(phone.replace(/[^+\d]/g, ''))}">${escapeHtml(phone)}</a>` : '<span>Non renseigné</span>';
    detail.innerHTML = `
      ${image ? `<img class="mn-detail-image" src="${escapeHtml(image)}" alt="${escapeHtml(name)}" loading="lazy">` : ''}
      <h2 class="mn-detail-title">${escapeHtml(name)}</h2>
      <div class="mn-detail-category">${escapeHtml(categoryLabel(place))}${distance ? ` · ${escapeHtml(distance)}` : ''}</div>
      <div class="mn-info-grid">
        <div class="mn-info-item"><small>Adresse</small><strong>${escapeHtml(address || 'Non renseignée')}</strong></div>
        <div class="mn-info-item"><small>Horaires publiés</small><strong>${escapeHtml(hours || 'Non renseignés')}</strong></div>
        <div class="mn-info-item"><small>Téléphone</small>${phoneLink}</div>
        <div class="mn-info-item"><small>Site web</small>${websiteLink}</div>
      </div>
      <div class="mn-action-row">
        <button type="button" class="mn-action mn-action-primary" data-mn-route>Itinéraire</button>
        <a class="mn-action" href="${mapLink}" target="_blank" rel="noopener noreferrer">Ouvrir la navigation</a>
      </div>
      <div class="mn-section-title">Offres en magasin <small>locales vérifiées</small></div>
      <div data-mn-store-offers class="mn-empty">Vérification des offres du point de vente…</div>
      <div class="mn-section-title">Offres de l'enseigne <small>validité locale à confirmer</small></div>
      <div data-mn-brand-offers class="mn-empty">Chargement…</div>
      <div class="mn-section-title">Offres en ligne et codes promo <small>hors prix magasin</small></div>
      <div data-mn-online-offers class="mn-empty">Chargement…</div>
      <div class="mn-source-note">Les horaires, coordonnées et avantages dépendent des informations publiées par les sources. Une offre nationale ou en ligne n'est pas présentée comme une promotion garantie dans ce magasin.</div>`;

    detail.querySelector('[data-mn-route]')?.addEventListener('click', () => onRoute(place));

    const [localPayload, affiliateOffers] = await Promise.all([
      fetchLocalOffers(place),
      fetchAffiliateOffers(place),
    ]);
    if (requestToken !== detailRequestToken || !root.classList.contains('is-open')) return;

    const localOffers = Array.isArray(localPayload?.storeOffers) ? localPayload.storeOffers : [];
    const brandOffers = Array.isArray(localPayload?.brandOffers) ? localPayload.brandOffers : [];
    const onlineOffers = Array.isArray(localPayload?.onlineOffers) ? localPayload.onlineOffers : [];
    const cashbackOffers = Array.isArray(localPayload?.cashbackOffers) ? localPayload.cashbackOffers : [];

    const storeEl = detail.querySelector('[data-mn-store-offers]');
    const brandEl = detail.querySelector('[data-mn-brand-offers]');
    const onlineEl = detail.querySelector('[data-mn-online-offers]');
    if (!storeEl || !brandEl || !onlineEl) return;

    storeEl.innerHTML = localOffers.length
      ? localOffers.map((offer) => renderOfferCard(offer, 'Dans ce magasin')).join('')
      : '<div class="mn-empty">Aucune promotion locale vérifiée pour ce magasin pour le moment.</div>';
    brandEl.innerHTML = brandOffers.length
      ? brandOffers.map((offer) => renderOfferCard(offer, 'Offre de l’enseigne')).join('')
      : '<div class="mn-empty">Aucune offre nationale confirmée enregistrée.</div>';

    const allOnline = [
      ...onlineOffers.map((offer) => renderOfferCard(offer, 'Offre en ligne')),
      ...affiliateOffers.map((offer) => renderOfferCard(offer, 'Code / promotion partenaire')),
      ...cashbackOffers.map((offer) => renderOfferCard(offer, 'Cashback')),
    ];
    onlineEl.innerHTML = allOnline.length
      ? allOnline.join('')
      : '<div class="mn-empty">Aucune offre en ligne ou cashback correspondant n’est actuellement disponible.</div>';
  };

  const mergeLocalPlaces = async (existingPlaces, center, queryText = '', categoryTag = null, radiusM = 2000) => {
    let current = Array.isArray(existingPlaces) ? [...existingPlaces] : [];
    const query = normalize(queryText);
    if (query && categoryTag) {
      current = current.filter((place) => normalize(`${placeName(place)} ${tagsOf(place).brand || ''}`).includes(query));
    }
    if (!center) return current;
    const params = new URLSearchParams({
      lat: String(center.lat),
      lon: String(center.lng ?? center.lon),
      radiusM: String(Math.max(250, Math.min(10000, Number(radiusM || 2000)))),
      limit: '100',
    });
    try {
      const response = await fetch(`${API_BASE}/api/places?${params}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const localRows = Array.isArray(payload.places) ? payload.places : [];
      const additions = localRows
        .filter((row) => isCategoryMatch(row, categoryTag))
        .filter((row) => !query || normalize(`${row.name || ''} ${row.brand || ''}`).includes(query) || !categoryTag)
        .map(normalizeLocalPlace)
        .filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon))
        .filter((row) => !current.some((existing) => {
          const sameName = normalize(placeName(existing)) === normalize(placeName(row));
          return sameName && distanceMeters(existing, row) <= 160;
        }));
      return [...current, ...additions].sort((a, b) => distanceMeters(center, a) - distanceMeters(center, b));
    } catch (error) {
      console.info('[MapNifique] Complément des enseignes indisponible :', error?.message || error);
      return current;
    }
  };

  const renderResults = (places, center, queryLabel = 'Résultats') => {
    currentCenter = center || null;
    currentPlaces = Array.isArray(places) ? [...places] : [];
    selectedIndex = -1;
    root.classList.add('is-open');
    root.classList.remove('has-detail');
    if (count) count.textContent = `${currentPlaces.length} résultat${currentPlaces.length > 1 ? 's' : ''} · ${queryLabel}`;
    if (!currentPlaces.length) {
      list.innerHTML = '<div class="mn-empty" style="margin:12px">Aucun établissement trouvé dans la zone recherchée.</div>';
      detail.innerHTML = '<div class="mn-empty">Sélectionnez un établissement pour consulter sa fiche.</div>';
      return;
    }

    const rows = currentPlaces.map((place, index) => {
      const tags = tagsOf(place);
      const distance = center ? formatDistance(distanceMeters(center, place)) : '';
      const label = placeName(place);
      const address = placeAddress(place);
      const hasOnlineSite = Boolean(safeHttpUrl(tags.website || tags['contact:website']));
      const icon = tags.amenity === 'restaurant' || tags.amenity === 'fast_food' ? '🍽️'
        : tags.amenity === 'pharmacy' || tags.healthcare ? '✚'
          : tags.shop === 'beauty' || tags.shop === 'cosmetics' || tags.shop === 'perfumery' ? '💄'
            : tags.shop === 'supermarket' || tags.shop === 'convenience' ? '🛒'
              : tags.tourism === 'hotel' ? '🛏️' : '📍';
      return `<button type="button" class="mn-place-row" data-mn-place-index="${index}">
        <span class="mn-place-icon" aria-hidden="true">${icon}</span>
        <span class="mn-place-copy"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(categoryLabel(place))}${distance ? ` · ${escapeHtml(distance)}` : ''}</span><span>${escapeHtml(address || 'Adresse non renseignée')}</span>${hasOnlineSite ? '<span>Site web disponible</span>' : ''}</span>
      </button>`;
    });
    list.innerHTML = rows.join('');
    list.querySelectorAll('[data-mn-place-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const index = Number(button.dataset.mnPlaceIndex);
        const place = currentPlaces[index];
        const map = getMap();
        if (map && place) map.panTo([place.lat, place.lon]);
        list.querySelectorAll('.mn-place-row').forEach((row) => row.classList.toggle('is-active', row === button));
        showDetails(place, currentCenter, index);
      });
    });

    // Ouvre automatiquement la fiche du premier résultat, déjà trié par proximité.
    if (currentPlaces.length > 0) {
      showDetails(currentPlaces[0], currentCenter, 0);
    }
  };

  return { renderResults, showDetails, mergeLocalPlaces, close };
}
