const STOP_WORDS = new Set([
  "a", "à", "au", "aux", "de", "des", "du", "d", "en", "dans", "sur",
  "chez", "et", "près", "pres", "proche", "moi", "autour", "pour", "un", "une",
  "le", "la", "les", "l", "the", "and", "of", "near", "me", "in", "at",
]);

// Vocabulaire d'intention : les termes français/anglais sont reliés aux tags OSM.
// Le moteur ne dépend pas de cette liste pour les autres recherches : celles-ci
// passent par la recherche libre dans les noms, adresses et tags.
const ACTIVITY_DEFS = [
  { label: "Pharmacie", aliases: ["pharmacie", "pharmacies", "pharmacy", "drugstore"], tags: [["amenity", "pharmacy"], ["healthcare", "pharmacy"]] },
  { label: "Beauté", aliases: ["beaute", "cosmetique", "cosmetiques", "parfumerie", "parfumeries", "beauty", "cosmetics"], tags: [["shop", "beauty"], ["shop", "cosmetics"], ["shop", "perfumery"]] },
  { label: "Supermarché", aliases: ["supermarche", "supermarches", "supermarket", "epicerie", "epiceries", "grocery", "groceries"], tags: [["shop", "supermarket"], ["shop", "convenience"], ["shop", "greengrocer"]] },
  { label: "Mode", aliases: ["mode", "vetement", "vetements", "habillement", "chaussure", "chaussures", "clothing", "clothes", "fashion"], tags: [["shop", "clothes"], ["shop", "shoes"], ["shop", "fashion"], ["shop", "jewelry"], ["shop", "bags"]] },
  { label: "Sport", aliases: ["sport", "sports", "magasin de sport", "magasins de sport", "equipement sportif", "equipements sportifs", "materiel de sport", "sports shop", "sporting goods"], tags: [["shop", "sports"], ["shop", "bicycle"], ["leisure", "sports_centre"], ["leisure", "fitness_centre"]] },
  { label: "Restauration", aliases: ["restaurant", "restaurants", "resto", "restos", "pizza", "pizzeria", "pizzerias", "fast food", "restauration", "food"], tags: [["amenity", "restaurant"], ["amenity", "fast_food"], ["amenity", "food_court"]] },
  { label: "Café", aliases: ["cafe", "cafes", "coffee shop", "coffee shops", "salon de the", "salon de the"], tags: [["amenity", "cafe"]] },
  { label: "Boulangerie", aliases: ["boulangerie", "boulangeries", "boulanger", "bakery", "bakeries", "patisserie", "patisseries"], tags: [["shop", "bakery"], ["shop", "pastry"]] },
  { label: "Coiffure", aliases: ["coiffeur", "coiffeurs", "coiffeuse", "salon de coiffure", "hairdresser", "hair salon"], tags: [["shop", "hairdresser"]] },
  { label: "Emploi & intérim", aliases: ["interim", "agence interim", "agences interim", "agence d interim", "agence d emploi", "agence emploi", "emploi", "emplois", "recrutement", "travail temporaire", "employment agency", "temp agency", "staffing agency"], tags: [["office", "employment_agency"], ["company", "temporary_work_agency"], ["government", "employment_agency"]] },
  { label: "Plombier", aliases: ["plombier", "plombiers", "plomberie", "plumber", "plumbing"], tags: [["craft", "plumber"]] },
  { label: "Électricien", aliases: ["electricien", "electriciens", "electricite", "electrician", "electrical contractor"], tags: [["craft", "electrician"]] },
  { label: "Menuisier", aliases: ["menuisier", "menuisiers", "menuiserie", "carpenter", "carpentry"], tags: [["craft", "carpenter"]] },
  { label: "Serrurier", aliases: ["serrurier", "serrurerie", "locksmith", "locksmiths"], tags: [["craft", "locksmith"]] },
  { label: "Avocat", aliases: ["avocat", "avocats", "avocate", "cabinet avocat", "lawyer", "lawyers", "solicitor"], tags: [["office", "lawyer"]] },
  { label: "Agence immobilière", aliases: ["agence immobiliere", "agences immobilieres", "agent immobilier", "agents immobiliers", "immobilier", "real estate agent", "estate agent", "realtor"], tags: [["office", "estate_agent"]] },
  { label: "Assurance", aliases: ["assurance", "assurances", "assureur", "insurance", "insurance agency"], tags: [["office", "insurance"]] },
  { label: "Comptable", aliases: ["comptable", "comptables", "expert comptable", "expertise comptable", "accountant", "accounting"], tags: [["office", "accountant"]] },
  { label: "Architecte", aliases: ["architecte", "architectes", "architecture", "architect"], tags: [["office", "architect"]] },
  { label: "Banque", aliases: ["banque", "banques", "bank", "banks"], tags: [["amenity", "bank"]] },
  { label: "Bureau de poste", aliases: ["poste", "bureau de poste", "bureaux de poste", "post office"], tags: [["amenity", "post_office"]] },
  { label: "École", aliases: ["ecole", "ecoles", "school", "schools"], tags: [["amenity", "school"]] },
  { label: "Université", aliases: ["universite", "universites", "university", "universities"], tags: [["amenity", "university"]] },
  { label: "Crèche", aliases: ["creche", "creches", "garderie", "childcare", "daycare", "kindergarten"], tags: [["amenity", "kindergarten"], ["amenity", "childcare"]] },
  { label: "Hôpital", aliases: ["hopital", "hopitaux", "hospital", "hospitals"], tags: [["amenity", "hospital"], ["healthcare", "hospital"]] },
  { label: "Clinique", aliases: ["clinique", "cliniques", "clinic", "clinics"], tags: [["amenity", "clinic"], ["healthcare", "clinic"]] },
  { label: "Médecin", aliases: ["medecin", "medecins", "docteur", "docteurs", "doctor", "doctors", "physician"], tags: [["healthcare", "doctor"], ["amenity", "doctors"]] },
  { label: "Dentiste", aliases: ["dentiste", "dentistes", "dentist", "dentists"], tags: [["healthcare", "dentist"], ["amenity", "dentist"]] },
  { label: "Vétérinaire", aliases: ["veterinaire", "veterinaires", "veterinary", "vet", "vets"], tags: [["amenity", "veterinary"]] },
  { label: "Toilettage animalier", aliases: [
    "toilettage", "toilettages", "toilettage animalier",
    "toiletteur", "toiletteurs", "toiletteuse", "toiletteuses",
    "toilettage canin", "toiletteur canin", "toiletteurs canins",
    "salon de toilettage", "salon de toilettage canin",
    "toiletteur animalier", "toilettage pour chiens",
    "dog groomer", "dog groomers", "dog grooming",
    "pet groomer", "pet groomers", "pet grooming",
    "pet grooming salon", "pet salon", "dog salon",
    "dog hairdresser", "dog hairdressers"
  ], tags: [
    ["shop", "pet_grooming"],
    ["shop", "dog_grooming"],
    ["shop", "dog_hairdresser"],
    ["amenity", "dog_grooming"],
    ["animal", "wellness"]
  ] },
  { label: "Garage automobile", aliases: ["garage", "garages", "mecanicien", "mecanique auto", "reparation automobile", "car repair", "auto repair", "mechanic"], tags: [["shop", "car_repair"], ["craft", "car_repair"]] },
  { label: "Station-service", aliases: ["station service", "station essence", "essence", "carburant", "gas station", "petrol station"], tags: [["amenity", "fuel"]] },
  { label: "Lavage automobile", aliases: ["lavage auto", "lavage automobile", "car wash", "carwash"], tags: [["amenity", "car_wash"]] },
  { label: "Vélo", aliases: ["magasin de velo", "magasin velo", "reparation velo", "bike shop", "bicycle shop", "bicycle repair"], tags: [["shop", "bicycle"]] },
  { label: "Cordonnier", aliases: ["cordonnier", "cordonnerie", "shoe repair", "shoemaker"], tags: [["craft", "shoemaker"]] },
  { label: "Pressing", aliases: ["pressing", "laverie", "blanchisserie", "dry cleaner", "laundromat", "laundry"], tags: [["shop", "dry_cleaning"], ["shop", "laundry"]] },
  { label: "Fleuriste", aliases: ["fleuriste", "fleuristes", "fleurs", "florist", "florists"], tags: [["shop", "florist"]] },
  { label: "Librairie", aliases: ["librairie", "librairies", "bookstore", "book shop", "books"], tags: [["shop", "books"]] },
  { label: "Opticien", aliases: ["opticien", "opticiens", "optique", "optician", "opticians"], tags: [["shop", "optician"]] },
  { label: "Animalerie", aliases: ["animalerie", "animaleries", "magasin animaux", "pet shop", "pet store"], tags: [["shop", "pet"]] },
  { label: "Photographe", aliases: ["photographe", "photographes", "photographie", "photographer", "photography"], tags: [["craft", "photographer"]] },
  { label: "Hôtel", aliases: ["hotel", "hotels", "hébergement", "hebergement", "hostel", "auberge"], tags: [["tourism", "hotel"], ["tourism", "hostel"], ["tourism", "guest_house"]] },
  { label: "Salle de sport", aliases: ["salle de sport", "fitness", "gym", "fitness centre", "fitness center"], tags: [["leisure", "fitness_centre"], ["leisure", "sports_centre"]] },
  { label: "Piscine", aliases: ["piscine", "piscines", "swimming pool"], tags: [["leisure", "swimming_pool"]] },
  { label: "Cinéma", aliases: ["cinema", "cinemas", "movie theater", "movie theatre"], tags: [["amenity", "cinema"]] },
  { label: "Musée", aliases: ["musee", "musees", "museum", "museums"], tags: [["tourism", "museum"]] },
];

const UI_CATEGORY_TAGS = {
  "Beauté": [["shop", "beauty"], ["shop", "cosmetics"], ["shop", "perfumery"], ["shop", "hairdresser"]],
  "Supermarché": [["shop", "supermarket"], ["shop", "convenience"], ["shop", "greengrocer"]],
  "Mode": [["shop", "clothes"], ["shop", "shoes"], ["shop", "fashion"], ["shop", "jewelry"], ["shop", "bags"]],
  "Sport": [["shop", "sports"], ["shop", "bicycle"], ["leisure", "sports_centre"], ["leisure", "fitness_centre"]],
  "Restauration": [["amenity", "restaurant"], ["amenity", "fast_food"], ["amenity", "cafe"], ["amenity", "food_court"]],
  "Pharmacie": [["amenity", "pharmacy"], ["healthcare", "pharmacy"]],
  "Toilettage animalier": [
    ["shop", "pet_grooming"],
    ["shop", "dog_grooming"],
    ["shop", "dog_hairdresser"],
    ["amenity", "dog_grooming"],
    ["animal", "wellness"]
  ],
  "Emploi & intérim": [["office", "employment_agency"], ["company", "temporary_work_agency"]],
  "Autres": [["shop", "*"], ["office", "*"], ["craft", "*"]],
};

const clean = (value, max = 300) =>
  String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const fold = value => String(value ?? "")
  .toLocaleLowerCase("fr")
  .normalize("NFD")
  .replace(/\p{Diacritic}/gu, "")
  .replace(/[’']/g, "")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function wordsOf(value) {
  return [...String(value ?? "").matchAll(/[\p{L}\p{N}]+/gu)]
    .map(match => ({ value: match[0], start: match.index, end: match.index + match[0].length }));
}

function editDistance(a, b) {
  const matrix = Array.from(
    { length: a.length + 1 },
    () => Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
      if (
        i > 1 && j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        matrix[i][j] = Math.min(matrix[i][j], matrix[i - 2][j - 2] + 1);
      }
    }
  }
  return matrix[a.length][b.length];
}

function similarity(a, b) {
  const size = Math.max(a.length, b.length);
  return size ? 1 - editDistance(a, b) / size : 1;
}

function findActivityMatch(words, excludedIndexes = new Set()) {
  let best = null;
  for (const activity of ACTIVITY_DEFS) {
    for (const alias of activity.aliases) {
      const parts = fold(alias).split(" ").filter(Boolean);
      if (!parts.length) continue;
      for (let start = 0; start + parts.length <= words.length; start++) {
        let overlaps = false;
        for (let index = start; index < start + parts.length; index++) {
          if (excludedIndexes.has(index)) overlaps = true;
        }
        if (overlaps) continue;
        const selected = words.slice(start, start + parts.length);
        if (!selected.every((word, index) => fold(word.value) === parts[index])) continue;
        const match = {
          activity,
          alias,
          start: selected[0].start,
          end: selected.at(-1).end,
          wordStart: start,
          wordEnd: start + parts.length,
          span: parts.length,
        };
        if (!best || match.span > best.span) best = match;
      }
    }
  }
  return best;
}

function findKnownLocationSuffix(words, knownLocations = []) {
  const locationMap = new Map(knownLocations.map(value => [fold(value), clean(value, 120)]));
  let best = null;
  for (const [normalized, original] of locationMap.entries()) {
    const parts = normalized.split(" ").filter(Boolean);
    if (!parts.length || parts.length > words.length) continue;
    const start = words.length - parts.length;
    const matches = words.slice(start).every((word, index) => fold(word.value) === parts[index]);
    if (matches && (!best || parts.length > best.span)) {
      best = { value: original, wordStart: start, wordEnd: words.length, span: parts.length };
    }
  }
  return best;
}

function findBrandMatch(words, knownBrands, excludedIndexes = new Set(), protectedLocations = new Set()) {
  const candidates = [];
  for (const rawBrand of knownBrands) {
    const brand = clean(rawBrand, 120);
    const normalized = fold(brand).replace(/\s/g, "");
    if (normalized.length < 2 || normalized.length > 35) continue;
    const brandWordCount = fold(brand).split(" ").filter(Boolean).length;

    for (let size = 1; size <= Math.min(3, words.length); size++) {
      for (let start = 0; start + size <= words.length; start++) {
        let overlaps = false;
        for (let index = start; index < start + size; index++) {
          if (excludedIndexes.has(index)) overlaps = true;
        }
        if (overlaps) continue;

        const selected = words.slice(start, start + size);
        const candidate = selected.map(word => fold(word.value)).join("");
        if (candidate.length < 3) continue;
        const exact = candidate === normalized;
        if (!exact && protectedLocations.has(start) && size === 1) continue;

        const score = similarity(candidate, normalized);
        // Corrections orthographiques strictes : garde les fautes nettes
        // (Adiddas/Adidas, Zarra/Zara) et refuse les ressemblances faibles.
        const threshold = normalized.length <= 4 ? 0.78
          : normalized.length <= 6 ? 0.78
          : 0.76;
        if (!exact && (normalized.length < 4 || score < threshold)) continue;

        candidates.push({
          brand, normalized, score, exact,
          start: selected[0].start,
          end: selected.at(-1).end,
          wordStart: start,
          wordEnd: start + size,
          span: size,
          brandWordCount,
        });
      }
    }
  }

  candidates.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score || b.span - a.span || a.brandWordCount - b.brandWordCount);
  const best = candidates[0] || null;
  if (!best || best.exact) return best;

  const competitor = candidates.find(candidate =>
    candidate !== best &&
    candidate.wordStart === best.wordStart &&
    candidate.wordEnd === best.wordEnd &&
    candidate.normalized !== best.normalized &&
    !best.normalized.startsWith(candidate.normalized) &&
    !candidate.normalized.startsWith(best.normalized)
  );
  if (competitor && best.score - competitor.score < 0.06) return null;
  return best;
}

export function resolveSearchIntent(query, knownBrands = [], knownLocations = []) {
  const words = wordsOf(query);
  const locationMatch = findKnownLocationSuffix(words, knownLocations);
  const excludedByLocation = new Set();
  if (locationMatch) {
    for (let index = locationMatch.wordStart; index < locationMatch.wordEnd; index++) excludedByLocation.add(index);
  }
  const protectedLocations = new Set(locationMatch ? [locationMatch.wordStart] : []);

  // Les enseignes exactes gardent la priorité, sans bloquer une deuxième
  // intention indépendante (ex. « Nike magasin de sport Paris »).
  const preliminaryBrand = findBrandMatch(words, knownBrands, excludedByLocation, protectedLocations);
  const excluded = new Set(excludedByLocation);
  if (preliminaryBrand?.exact) {
    for (let index = preliminaryBrand.wordStart; index < preliminaryBrand.wordEnd; index++) excluded.add(index);
  }

  const activityMatch = findActivityMatch(words, excluded);
  if (activityMatch) {
    for (let index = activityMatch.wordStart; index < activityMatch.wordEnd; index++) excluded.add(index);
  }

  const brandMatch = preliminaryBrand?.exact
    ? preliminaryBrand
    : findBrandMatch(words, knownBrands, excluded, protectedLocations);
  if (brandMatch) {
    for (let index = brandMatch.wordStart; index < brandMatch.wordEnd; index++) excluded.add(index);
  }

  const remaining = words.filter((_, index) => !excluded.has(index));
  const remainingText = remaining.map(word => word.value).join(" ").trim();
  const hasPrimaryIntent = Boolean(activityMatch || brandMatch);
  const addressLike = remaining.some(word => /^\d+[a-z]?$/i.test(word.value)) ||
    /\b(rue|avenue|av|boulevard|bd|place|route|chemin|street|road|lane|gare|airport|aeroport)\b/i.test(fold(remainingText));

  let destinationQuery = "";
  let searchTokens = [];
  let destinationWords = [];

  if (locationMatch) {
    destinationWords = words.slice(locationMatch.wordStart);
    if (hasPrimaryIntent || addressLike) {
      destinationQuery = [remainingText, locationMatch.value].filter(Boolean).join(" ").trim();
    } else {
      destinationQuery = locationMatch.value;
      searchTokens = remaining.map(word => fold(word.value)).filter(value => value && !STOP_WORDS.has(value));
    }
  } else if (hasPrimaryIntent && remainingText) {
    destinationQuery = remainingText;
    destinationWords = remaining;
  } else if (addressLike && remainingText) {
    destinationQuery = remainingText;
    destinationWords = remaining;
  } else if (!hasPrimaryIntent) {
    // Fallback universel : tout terme non reconnu reste une recherche libre.
    // Il ne sera jamais réinterprété arbitrairement comme une marque.
    searchTokens = words.map(word => fold(word.value)).filter(value => value && !STOP_WORDS.has(value));
  }

  const locationTokens = destinationWords
    .map(word => fold(word.value))
    .filter(value => value && !STOP_WORDS.has(value));

  let correctedQuery = clean(query);
  let correction = null;
  if (brandMatch && !brandMatch.exact) {
    const original = correctedQuery.slice(brandMatch.start, brandMatch.end);
    correctedQuery = correctedQuery.slice(0, brandMatch.start) + brandMatch.brand + correctedQuery.slice(brandMatch.end);
    correction = { from: original, to: brandMatch.brand };
  }

  const activity = activityMatch?.activity || null;
  return {
    type: brandMatch ? "brand" : activity ? "activity" : destinationQuery ? "location" : searchTokens.length ? "free_text" : "empty",
    brand: brandMatch?.brand || null,
    brandScore: brandMatch?.score || 0,
    category: activity?.label || null,
    categoryQuery: activityMatch?.alias || null,
    categoryOsmTags: (activity?.tags || []).map(([key, value]) => `${key}:${value}`),
    osmFilters: activity?.tags || [],
    activityAliases: activity?.aliases || [],
    destinationQuery,
    locationTokens,
    searchTokens,
    correctedQuery,
    correction,
  };
}

let photonQueue = Promise.resolve();
let photonLastRequestAt = 0;
const photonCache = new Map();

async function photonSearch(fetcher, query, limit, options = {}, minIntervalMs = 1000, cacheEnabled = true) {
  const center = options.center || null;
  const osmTags = options.osmTags || [];
  const baseUrl = String(options.baseUrl || "https://photon.komoot.io")
    .trim()
    .replace(/\/+$/, "");
  const key = [baseUrl, fold(query), limit, center ? `${center.lat.toFixed(4)},${center.lon.toFixed(4)}` : "world", osmTags.join(",")].join("|");
  const cached = photonCache.get(key);
  if (cacheEnabled && cached && cached.expires > Date.now()) return cached.payload;

  const task = photonQueue.then(async () => {
    const delay = Math.max(0, minIntervalMs - (Date.now() - photonLastRequestAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    photonLastRequestAt = Date.now();
    const url = new URL(`${baseUrl}/api/`);
    url.searchParams.set("q", query);
    url.searchParams.set("lang", "fr");
    url.searchParams.set("limit", String(limit));
    if (center) {
      url.searchParams.set("lat", String(center.lat));
      url.searchParams.set("lon", String(center.lon));
      url.searchParams.set("zoom", "16");
      url.searchParams.set("location_bias_scale", "0.2");
    }
    for (const tag of osmTags) url.searchParams.append("osm_tag", tag);

    const response = await fetcher(url.toString(), {
      headers: { "user-agent": "MapNifique/2.0", accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`Photon HTTP ${response.status}`);
    const payload = await response.json();
    if (cacheEnabled) {
      photonCache.set(key, { expires: Date.now() + 60_000, payload });
      if (photonCache.size > 150) photonCache.delete(photonCache.keys().next().value);
    }
    return payload;
  });
  photonQueue = task.catch(() => null);
  return task;
}

// Secours de géocodage uniquement : Nominatim ne remplace pas Photon pour
// la découverte de commerces. Le cache et la file sont partagés par toutes
// les requêtes de ce processus API.
let nominatimQueue = Promise.resolve();
let nominatimLastRequestAt = 0;
const nominatimCache = new Map();

function nominatimToFeatures(results) {
  return (Array.isArray(results) ? results : []).map(item => {
    const lat = Number(item?.lat);
    const lon = Number(item?.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

    const address = item.address || {};
    const name = clean(
      item.name || item.namedetails?.['name:fr'] || item.namedetails?.name ||
      String(item.display_name || '').split(',')[0],
      120,
    );
    if (!name) return null;

    const city = clean(address.city || address.town || address.village || address.municipality || '', 120);
    const district = clean(
      address.suburb || address.city_district || address.neighbourhood ||
      address.quarter || address.district || '',
      120,
    );
    const street = clean(address.road || address.pedestrian || address.footway || address.path || '', 160);
    const postcode = clean(address.postcode || '', 20);

    // addresstype est plus précis que type pour différencier une ville d'un
    // quartier situé dans une commune (ex. La Défense / Courbevoie).
    const type = clean(item.addresstype || item.type || '', 40).toLowerCase();
    const boundaryGeoJSON = item.geojson &&
      ['Polygon', 'MultiPolygon'].includes(item.geojson.type) &&
      Array.isArray(item.geojson.coordinates)
      ? item.geojson
      : null;

    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [lon, lat] },
      properties: {
        name, type, city, district, street, postcode,
        boundaryGeoJSON,
        osmType: clean(item.osm_type || '', 8),
        osmId: item.osm_id == null ? null : String(item.osm_id),
        countryCode: clean(address.country_code || '', 8).toLowerCase(),
      },
    };
  }).filter(Boolean);
}

async function nominatimSearch(fetcher, query, options = {}) {
  const endpoint = String(
    options.url || process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search',
  ).trim();
  const userAgent = String(
    options.userAgent || process.env.GEOCODER_USER_AGENT || 'MapNifique/1.0',
  ).trim();
  // Un petit jeu de candidats suffit pour géocoder une destination ;
  // limiter la réponse réduit le temps de traitement du service public.
  const limit = Math.max(1, Math.min(5, Number(options.limit) || 5));
  const cacheEnabled = options.cacheEnabled !== false;
  const cacheTtlMs = Math.max(60_000, Number(options.cacheTtlMs) || 24 * 60 * 60 * 1000);
  const configuredTimeout = Number(options.timeoutMs ?? process.env.NOMINATIM_TIMEOUT_MS);
  // Nominatim public peut répondre plus lentement que Photon. 15 s par défaut,
  // configurable entre 10 et 25 s pour éviter les faux échecs à 10 s.
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 10_000
    ? Math.min(25_000, configuredTimeout)
    : 15_000;
  const includePolygon = options.includePolygon === true;
  const polygonThreshold = Math.max(0, Math.min(0.01, Number(options.polygonThreshold ?? 0.00001)));
  const key = `${endpoint}|${fold(query)}|fr|${limit}|polygon:${includePolygon ? polygonThreshold : 0}`;
  const cached = nominatimCache.get(key);
  if (cacheEnabled && cached && cached.expires > Date.now()) return cached.payload;

  const task = nominatimQueue.then(async () => {
    // Politique du serveur public : au maximum une requête par seconde et
    // pour l'application entière. Marge de 100 ms pour éviter les rafales.
    const configuredInterval = Number(options.minIntervalMs);
    const minIntervalMs = Number.isFinite(configuredInterval)
      ? Math.max(1000, configuredInterval)
      : 1100;
    const delay = Math.max(0, minIntervalMs - (Date.now() - nominatimLastRequestAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    nominatimLastRequestAt = Date.now();

    const url = new URL(endpoint);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '1');
    // La géométrie administrative est demandée uniquement pour les recherches
    // explicites déclenchées par l'utilisateur, jamais pendant l'autocomplétion.
    // Elle permet un filtre exact des communes au lieu d'un rayon approximatif.
    if (includePolygon) {
      url.searchParams.set('polygon_geojson', '1');
      url.searchParams.set('polygon_threshold', String(polygonThreshold));
    }
    // Les noms détaillés ne sont pas nécessaires : name/display_name suffisent
    // au résolveur et évitent de demander un payload plus lourd.
    url.searchParams.set('accept-language', 'fr');

    const response = await fetcher(url.toString(), {
      headers: {
        'user-agent': userAgent,
        accept: 'application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('Réponse Nominatim invalide');
    if (cacheEnabled) {
      nominatimCache.set(key, { expires: Date.now() + cacheTtlMs, payload });
      if (nominatimCache.size > 500) nominatimCache.delete(nominatimCache.keys().next().value);
    }
    return payload;
  });
  nominatimQueue = task.catch(() => null);
  return task;
}

let overpassQueue = Promise.resolve();
let overpassLastRequestAt = 0;
const overpassCache = new Map();

function escapeOverpassRegex(value) {
  return String(value ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 100);
}

export function buildOverpassQuery({ center, radiusM, intent, categoryFilter = "Tout" }) {
  if (!center || !Number.isFinite(Number(center.lat)) || !Number.isFinite(Number(center.lon))) return null;
  const radius = Math.max(100, Math.min(50000, Number(radiusM) || 3000));
  const around = `(around:${radius},${Number(center.lat)},${Number(center.lon)})`;
  const selectors = [];

  // Les recherches d'enseigne utilisent des filtres indexables par champ.
  // Le filtre regex multi-clés (~ name|brand|operator|name:fr) est très coûteux
  // sur certaines instances publiques, même pour une petite zone.
  // Les résultats sont ensuite validés par matchesIntent (marque + activité).
  if (intent?.brand) {
    const brand = String(intent.brand)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, String.fromCharCode(92) + '"')
      .replace(/[\r\n]/g, " ")
      .slice(0, 100);
    for (const key of ["name", "brand", "operator"]) {
      selectors.push(`nwr${around}["${key}"="${brand}"];`);
    }
  }

  const tagFilters = intent?.osmFilters?.length
    ? intent.osmFilters
    : (UI_CATEGORY_TAGS[categoryFilter] || []);

  if (!intent?.brand) {
    for (const [key, value] of tagFilters) {
      const tagSelector = value === "*" ? `["${key}"]` : `["${key}"="${value}"]`;
      selectors.push(`nwr${around}${tagSelector};`);
    }
  }

  if (!selectors.length && intent?.searchTokens?.length) {
    const terms = intent.searchTokens.slice(0, 4).map(escapeOverpassRegex);
    const fields = `^(name|brand|operator|name:fr|description)$`;
    const conditions = terms.map(term => `[~"${fields}"~"${term}",i]`).join("");
    selectors.push(`nwr${around}${conditions};`);
  }

  if (!selectors.length && !intent?.brand && !intent?.category && !intent?.searchTokens?.length) {
    for (const key of ["shop", "office", "craft", "amenity", "healthcare", "leisure", "tourism"]) {
      selectors.push(`nwr${around}["${key}"];`);
    }
  }

  if (!selectors.length) return null;
  return `[out:json][timeout:30];(${selectors.join("")});out center tags;`;
}

async function overpassSearch(fetcher, query, options = {}) {
  const {
    minIntervalMs = 10_000,
    cacheEnabled = true,
  } = options;
  const cacheKey = query;
  const cached = overpassCache.get(cacheKey);
  if (cacheEnabled && cached && cached.expires > Date.now()) return cached.elements;

  const task = overpassQueue.then(async () => {
    const delay = Math.max(0, minIntervalMs - (Date.now() - overpassLastRequestAt));
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    overpassLastRequestAt = Date.now();
    const endpoint = String(options.url || process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter").trim();
    const response = await fetcher(endpoint, {
      method: "POST",
      headers: {
        "user-agent": "MapNifique/2.0",
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.elements)) throw new Error(payload.remark || "Réponse Overpass invalide.");
    if (cacheEnabled) {
      overpassCache.set(cacheKey, { expires: Date.now() + 5 * 60_000, elements: payload.elements });
      if (overpassCache.size > 100) overpassCache.delete(overpassCache.keys().next().value);
    }
    return payload.elements;
  });
  overpassQueue = task.catch(() => null);
  return task;
}

function distanceMeters(a, b) {
  const radians = value => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export function resolveDestinationFeature(query, features, options = {}) {
  const tokens = fold(query).split(" ").filter(Boolean);
  if (!tokens.length) return null;

  const normalizedQuery = fold(query);
  const candidates = (features || []).map(feature => {
    const p = feature?.properties || {};
    const coords = feature?.geometry?.coordinates || [];
    const lat = Number(coords[1]);
    const lon = Number(coords[0]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    const displayName = clean(p.name || p.country || "", 120);
    const name = fold(displayName);
    const context = fold([
      p.name, p.city, p.district, p.street, p.postcode, p.country
    ].join(" "));
    const hits = tokens.filter(token => context.includes(token)).length;
    if (hits !== tokens.length) return null;

    const type = fold(p.type || "");
    const osmKey = fold(p.osm_key || p.osmKey || "");
    const osmValue = fold(p.osm_value || p.osmValue || "");

    const isCountry = type === "country" ||
      (osmKey === "place" && osmValue === "country");

    const isCity =
      /city|town|village|municipality/.test(type) ||
      (osmKey === "place" &&
        ["city", "town", "village", "municipality"].includes(osmValue));

    const isDistrict =
      /district|locality|suburb|neighbourhood/.test(type) ||
      (osmKey === "place" &&
        ["district", "locality", "suburb", "neighbourhood"].includes(osmValue));

    // Le texte libre n'est transformé en destination que sur correspondance
    // exacte avec un pays ou une ville administrative.
    if (options.requireAdministrative &&
        (!(isCountry || isCity) || name !== normalizedQuery)) {
      return null;
    }

    let score = hits * 20;
    if (name === normalizedQuery) score += 100;
    if (name && normalizedQuery.startsWith(name)) score += 45;
    if (isCountry) score += 28;
    else if (isCity) score += 12;
    else if (isDistrict) score += 8;
    if (osmKey === "shop") score -= 50;

    const boundaryGeoJSON = p.boundaryGeoJSON &&
      ["Polygon", "MultiPolygon"].includes(p.boundaryGeoJSON.type) &&
      Array.isArray(p.boundaryGeoJSON.coordinates)
      ? p.boundaryGeoJSON
      : null;

    return {
      lat, lon, score, type, name, displayName, context,
      isCountry, isCity, isDistrict, boundaryGeoJSON,
      countryName: isCountry ? (displayName || clean(query, 120)) : "",
      countryCode: clean(p.countryCode || p.countrycode || "", 8).toLowerCase(),
      osmType: p.osmType || p.osm_type || null,
      osmId: p.osmId || p.osm_id || null,
    };
  }).filter(Boolean);

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best) return null;

  let radiusM = 5000;
  const compact = normalizedQuery;

  if (best.isCountry) radiusM = 5000;
  else if (/centre commercial|mall|les passages|gare|airport|aeroport|parvis/.test(compact)) radiusM = 3000;
  else if (best.isCity) radiusM = 18000;
  else if (best.isDistrict) radiusM = 3000;
  else if (/street|road|house/.test(best.type)) radiusM = 3500;

  return {
    point: { lat: best.lat, lon: best.lon },
    radiusM,
    label: best.name,
    scope: best.isCountry ? "country" : best.isCity ? "city" : "local",
    cityName: best.isCity ? (best.name || clean(query, 120)) : "",
    countryName: best.countryName,
    countryCode: best.countryCode,
    cityFallbackRadiusM: best.isCity ? Math.min(radiusM, 10000) : 0,
    boundaryGeoJSON: (best.isCity || best.isCountry) ? best.boundaryGeoJSON : null,
    boundarySource: (best.isCity || best.isCountry) && best.boundaryGeoJSON ? "nominatim" : null,
    boundaryOsmType: (best.isCity || best.isCountry) ? best.osmType : null,
    boundaryOsmId: (best.isCity || best.isCountry) ? best.osmId : null,
  };
}

export function osmDisplayCategory(key, value, tags = {}) {
  if (key === "office" && value === "government" &&
      String(tags?.government || "").toLowerCase() === "employment_agency") {
    return "Emploi & intérim";
  }
  if (key === "animal" && value === "wellness") return "Toilettage animalier";
  if (key === "amenity" && value === "dog_grooming") return "Toilettage animalier";
  if (key === "shop") {
    if (value === "pet") return "Animalerie";
    if (["pet_grooming", "dog_grooming", "dog_hairdresser"].includes(value)) return "Toilettage animalier";
    if (["beauty", "cosmetics", "perfumery", "hairdresser"].includes(value)) return "Beauté";
    if (["supermarket", "convenience", "greengrocer"].includes(value)) return "Supermarché";
    if (value === "sports") return "Sport";
    if (["clothes", "shoes", "fashion", "jewelry", "bags"].includes(value)) return "Mode";
    if (value === "bakery" || value === "pastry") return "Boulangerie";
    return "Commerce";
  }
  if ((key === "amenity" || key === "healthcare") && value === "pharmacy") return "Pharmacie";
  if (key === "office" && ["employment_agency"].includes(value)) return "Emploi & intérim";
  if (key === "company" && value === "temporary_work_agency") return "Emploi & intérim";
  if (key === "craft") return "Artisanat";
  if (key === "office") return "Services professionnels";
  if (key === "amenity" && ["restaurant", "fast_food", "cafe", "food_court"].includes(value)) return "Restauration";
  if (key === "amenity" && ["school", "college", "university", "kindergarten", "childcare"].includes(value)) return "Éducation";
  if (key === "healthcare" || ["hospital", "clinic", "doctor", "doctors", "dentist", "veterinary"].includes(value)) return "Santé";
  if (key === "leisure" || key === "tourism") return "Loisirs";
  if (["public_transport", "railway", "aeroway"].includes(key)) return "Transport";
  if (key === "amenity") return "Services";
  return "Services";
}

function photonCategory(key, value, tags = {}) {
  return osmDisplayCategory(key, value, tags);
}

export function photonToPlace(feature) {
  const p = feature?.properties || {};
  const extra = p.extra && typeof p.extra === "object" ? p.extra : {};
  const coords = feature?.geometry?.coordinates || [];
  const lon = Number(coords[0]);
  const lat = Number(coords[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = clean(p.name || extra.name, 180);
  if (!name) return null;

  const osmType = clean(p.osm_type || "N", 5);
  const osmId = String(p.osm_id || "");
  const supportedBusinessKeys = [
    "shop", "office", "craft", "amenity", "healthcare", "company",
    "leisure", "tourism", "public_transport", "railway", "aeroway", "emergency",
  ];
  const extraBusinessKey = supportedBusinessKeys.find(key =>
    extra[key] !== undefined && extra[key] !== null && String(extra[key]).trim() !== ""
  );
  const photonOsmKey = clean(p.osm_key, 40);
  const osmKey = supportedBusinessKeys.includes(photonOsmKey)
    ? photonOsmKey
    : (extraBusinessKey || photonOsmKey);
  const osmValue = clean(
    extraBusinessKey && !supportedBusinessKeys.includes(photonOsmKey)
      ? extra[extraBusinessKey]
      : p.osm_value,
    80,
  );
  if (["vacant", "disused", "abandoned", "closed"].includes(osmValue.toLowerCase())) return null;

  const houseNumber = p.housenumber || extra["addr:housenumber"] || "";
  const street = p.street || extra["addr:street"] || "";
  const postcode = p.postcode || extra["addr:postcode"] || "";
  const city = p.city || p.district || extra["addr:city"] || "";
  const brand = clean(extra.brand || extra.operator || name, 180);

  return {
    id: osmId ? `osm-${osmType}-${osmId}` : `photon-${lat}-${lon}-${name}`,
    sourceId: "openstreetmap",
    externalId: osmId ? `${osmType}/${osmId}` : "",
    sourceLicense: "ODbL",
    sourceUrl: osmId ? `https://www.openstreetmap.org/${osmType}/${osmId}` : "",
    name,
    brand,
    brandKey: fold(brand).replace(/\s+/g, "-"),
    category: photonCategory(osmKey, osmValue, extra),
    category_key: osmKey,
    category_value: osmValue,
    lat,
    lon,
    address: { house_number: houseNumber, road: street, street, postcode, city, country: p.country || "" },
    city,
    street,
    postcode,
    phone: extra.phone || extra["contact:phone"] || "",
    website: extra.website || extra["contact:website"] || "",
    openingHours: extra.opening_hours || "",
    distance_m: null,
    osmKey,
    osmValue,
    tags: extra,
  };
}

export function overpassToPlace(element) {
  const tags = element?.tags || {};
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const name = clean(tags.name || tags.brand || tags.operator, 180);
  if (!name) return null;
  const inactive = ["disused", "abandoned", "closed", "vacant"].some(key => tags[key] === "yes" || tags[key] === "closed");
  if (inactive) return null;
  const type = clean(element.type || "node", 8);
  const id = String(element.id || "");
  const osmKey = Object.keys(tags).find(key => ["shop", "office", "craft", "amenity", "healthcare", "leisure", "tourism", "public_transport", "railway", "aeroway", "company"].includes(key)) || "";
  const osmValue = clean(tags[osmKey], 100);
  const brand = clean(tags.brand || tags.operator || name, 180);
  const street = tags["addr:street"] || "";
  const postcode = tags["addr:postcode"] || "";
  const city = tags["addr:city"] || tags["addr:town"] || tags["addr:village"] || "";
  const address = {
    house_number: tags["addr:housenumber"] || "",
    road: street,
    street,
    postcode,
    city,
    country: tags["addr:country"] || "",
  };
  return {
    id: `osm-${type}-${id}`,
    sourceId: "openstreetmap",
    externalId: `${type}/${id}`,
    sourceLicense: "ODbL",
    sourceUrl: `https://www.openstreetmap.org/${type}/${id}`,
    name,
    brand,
    brandKey: fold(brand).replace(/\s+/g, "-"),
    category: osmDisplayCategory(osmKey, osmValue, tags),
    category_key: osmKey,
    category_value: osmValue,
    lat,
    lon,
    address,
    city,
    street,
    postcode,
    phone: tags.phone || tags["contact:phone"] || "",
    website: tags.website || tags["contact:website"] || "",
    openingHours: tags.opening_hours || "",
    distance_m: null,
    osmKey,
    osmValue,
    tags,
  };
}

function placeSearchText(place) {
  const address = place.address && typeof place.address === "object" ? place.address : {};
  return fold([
    place.name, place.brand, place.category, place.category_key, place.category_value,
    place.city, place.street, place.postcode,
    address.city, address.road, address.street, address.postcode,
    place.osmKey, place.osmValue,
    place.tags && typeof place.tags === "object" ? Object.values(place.tags).join(" ") : "",
  ].join(" "));
}

function identityMatches(place, brand) {
  const expected = fold(brand);
  return fold(place.name) === expected || fold(place.brand) === expected;
}

function isBuildingOnlyPlace(place) {
  const tags = place.tags && typeof place.tags === "object" ? place.tags : {};
  const key = normalizedField(place.category_key || place.osmKey);
  const hasBusinessTag = [
    "shop", "office", "craft", "amenity", "healthcare", "company",
    "leisure", "tourism", "public_transport", "railway", "aeroway", "emergency",
  ].some(tag => tags[tag] !== undefined && tags[tag] !== null && String(tags[tag]).trim() !== "");
  const hasBuildingTag = key === "building" ||
    (tags.building !== undefined && tags.building !== null && String(tags.building).trim() !== "");
  return hasBuildingTag && !hasBusinessTag;
}

function pointInRing(lon, lat, ring) {
  if (!Array.isArray(ring) || ring.length < 4) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (!Array.isArray(a) || !Array.isArray(b)) continue;
    const [xi, yi] = a;
    const [xj, yj] = b;
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;

    // Un point exactement sur un segment appartient à la frontière.
    const cross = (lon - xi) * (yj - yi) - (lat - yi) * (xj - xi);
    if (Math.abs(cross) <= 1e-10 &&
        lon >= Math.min(xi, xj) - 1e-10 && lon <= Math.max(xi, xj) + 1e-10 &&
        lat >= Math.min(yi, yj) - 1e-10 && lat <= Math.max(yi, yj) + 1e-10) {
      return true;
    }

    const intersects = (yi > lat) !== (yj > lat) &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lon, lat, rings) {
  if (!Array.isArray(rings) || !rings.length || !pointInRing(lon, lat, rings[0])) return false;
  // Les anneaux intérieurs sont des trous : leur intérieur n'appartient pas à la commune.
  for (const hole of rings.slice(1)) {
    if (pointInRing(lon, lat, hole)) return false;
  }
  return true;
}

function pointInGeoJSON(lon, lat, geometry) {
  if (!Number.isFinite(lon) || !Number.isFinite(lat) || !geometry) return null;
  if (geometry.type === 'Polygon') return pointInPolygon(lon, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    return Array.isArray(geometry.coordinates) && geometry.coordinates.some(polygon =>
      pointInPolygon(lon, lat, polygon)
    );
  }
  return null;
}

export function matchesDestinationCity(place, destination) {
  const address = place.address && typeof place.address === "object" ? place.address : {};

  if (destination?.scope === "country") {
    const expectedName = fold(destination.countryName || destination.label || "");
    const expectedCode = fold(destination.countryCode || "");

    if (destination.boundaryGeoJSON) {
      const inside = pointInGeoJSON(
        Number(place.lon),
        Number(place.lat),
        destination.boundaryGeoJSON,
      );
      if (inside !== null) return inside;
    }

    const actualCode = fold(
      place.countryCode || address.country_code || place.tags?.["addr:country"] || ""
    );
    if (expectedCode && actualCode) return expectedCode === actualCode;

    const actualCountry = fold(
      place.country || address.country || place.tags?.["addr:country"] || ""
    );
    return Boolean(expectedName && actualCountry && actualCountry === expectedName);
  }

  if (destination?.scope !== "city") return true;
  const expected = fold(destination.cityName || destination.label || "");
  if (!expected) return true;

  if (destination.boundaryGeoJSON) {
    const inside = pointInGeoJSON(
      Number(place.lon),
      Number(place.lat),
      destination.boundaryGeoJSON,
    );
    if (inside !== null) return inside;
  }

  const actual = fold(
    place.city || address.city || address.town || address.village ||
    address["addr:city"] || address["addr:town"] || address["addr:village"] || ""
  );
  if (actual) {
    return actual === expected || actual.startsWith(`${expected} `) || actual.startsWith(`${expected},`);
  }

  const rawDistance = place.distance_m;
  const hasProvidedDistance =
    rawDistance !== null &&
    rawDistance !== undefined &&
    rawDistance !== "" &&
    Number.isFinite(Number(rawDistance));

  const distance = hasProvidedDistance
    ? Number(rawDistance)
    : distanceMeters(destination.point, { lat: Number(place.lat), lon: Number(place.lon) });

  return Number.isFinite(distance) && distance <= Number(destination.cityFallbackRadiusM || 0);
}

export function matchesIntent(place, intent, point = null, radiusM = 0) {
  if (intent.brand && (!identityMatches(place, intent.brand) || isBuildingOnlyPlace(place))) return false;
  if (intent.osmFilters?.length) {
    const pairs = intent.osmFilters;
    const matchesTag = pairs.some(([key, value]) => {
      const actual = place.osmKey === key ? place.osmValue : place.category_key === key ? place.category_value : place.tags?.[key];
      return value === "*" ? Boolean(actual) : String(actual || "") === value;
    });
    if (!matchesTag) return false;
  }
  if (intent.category && place.category && !intent.osmFilters?.length && place.category !== intent.category) return false;

  if (point) {
    const distance = distanceMeters(point, { lat: Number(place.lat), lon: Number(place.lon) });
    if (!Number.isFinite(distance) || distance > radiusM) return false;
  }

  const context = placeSearchText(place);
  for (const token of intent.locationTokens || []) {
    if (!point && !context.includes(token)) return false;
  }
  for (const token of intent.searchTokens || []) {
    if (!context.includes(token)) return false;
  }
  return true;
}

function relevance(place, intent, point = null) {
  const context = placeSearchText(place);
  let score = 0;
  if (intent.brand) {
    if (fold(place.name) === fold(intent.brand)) score += 1500;
    if (fold(place.brand) === fold(intent.brand)) score += 1500;
  }
  if (intent.osmFilters?.length) score += 800;
  for (const token of [...(intent.searchTokens || []), ...(intent.locationTokens || [])]) {
    if (context.includes(token)) score += 100;
  }
  if (point && Number.isFinite(Number(place.distance_m))) score += Math.max(0, 100 - Number(place.distance_m) / 1000);
  return score;
}

function isUseful(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function mergeDuplicateRows(existing, incoming) {
  const merged = { ...incoming, ...existing };
  const left = existing.address && typeof existing.address === "object" ? existing.address : {};
  const right = incoming.address && typeof incoming.address === "object" ? incoming.address : {};
  const address = { ...right };
  for (const [key, value] of Object.entries(left)) if (isUseful(value)) address[key] = value;
  merged.address = Object.keys(address).length ? address : null;
  for (const field of ["brand", "brandKey", "category", "category_key", "category_value", "city", "street", "postcode", "phone", "website", "imageUrl", "openingHours", "sourceLicense", "sourceUrl", "osmKey", "osmValue", "tags"]) {
    if (!isUseful(existing[field]) && isUseful(incoming[field])) merged[field] = incoming[field];
  }
  merged.city = existing.city || incoming.city || address.city || "";
  merged.street = existing.street || incoming.street || address.street || address.road || "";
  merged.postcode = existing.postcode || incoming.postcode || address.postcode || "";
  merged.tags = { ...(incoming.tags || {}), ...(existing.tags || {}) };
  return merged;
}

function normalizedField(value) {
  return fold(value).replace(/\s+/g, " ").trim();
}

function placeAddressValue(place, keys) {
  const address = place.address && typeof place.address === "object" ? place.address : {};
  const tags = place.tags && typeof place.tags === "object" ? place.tags : {};
  for (const key of keys) {
    const value = place[key] ?? address[key] ?? tags[key] ?? "";
    if (String(value).trim()) return normalizedField(value);
  }
  return "";
}

function hasConflictingBusinessDetails(a, b) {
  const addressFields = [
    ["house_number", "housenumber", "addr:housenumber"],
    ["postcode", "postal_code", "addr:postcode"],
    ["street", "road", "addr:street"],
    ["city", "town", "village", "addr:city", "addr:town", "addr:village"],
  ];
  for (const fields of addressFields) {
    const left = placeAddressValue(a, fields);
    const right = placeAddressValue(b, fields);
    if (left && right && left !== right) return true;
  }

  const brandA = normalizedField(a.brand || a.name);
  const brandB = normalizedField(b.brand || b.name);
  if (brandA && brandB && brandA !== brandB) return true;
  const categoryKeyA = normalizedField(a.category_key || a.osmKey);
  const categoryKeyB = normalizedField(b.category_key || b.osmKey);
  const categoryValueA = normalizedField(a.category_value || a.osmValue);
  const categoryValueB = normalizedField(b.category_value || b.osmValue);
  if (categoryKeyA && categoryKeyB && categoryKeyA !== categoryKeyB) return true;
  if (categoryValueA && categoryValueB && categoryValueA !== categoryValueB) return true;

  const tagsA = a.tags && typeof a.tags === "object" ? a.tags : {};
  const tagsB = b.tags && typeof b.tags === "object" ? b.tags : {};
  const discriminators = [
    [tagsA.level ?? tagsA["addr:floor"] ?? a.level ?? a.floor,
     tagsB.level ?? tagsB["addr:floor"] ?? b.level ?? b.floor],
    [tagsA["addr:unit"] ?? tagsA["addr:door"] ?? a.unit,
     tagsB["addr:unit"] ?? tagsB["addr:door"] ?? b.unit],
    [a.phone || tagsA.phone || tagsA["contact:phone"], b.phone || tagsB.phone || tagsB["contact:phone"]],
    [a.website || tagsA.website || tagsA["contact:website"], b.website || tagsB.website || tagsB["contact:website"]],
  ];
  return discriminators.some(([left, right]) => {
    const x = normalizedField(left);
    const y = normalizedField(right);
    return Boolean(x && y && x !== y);
  });
}

function sameCommercialPlace(a, b, distance) {
  if (fold(a.name) !== fold(b.name)) return false;
  const brandA = fold(a.brand || a.name);
  const brandB = fold(b.brand || b.name);
  if (!brandA || brandA !== brandB) return false;

  const keyA = normalizedField(a.category_key || a.osmKey);
  const keyB = normalizedField(b.category_key || b.osmKey);
  const valueA = normalizedField(a.category_value || a.osmValue);
  const valueB = normalizedField(b.category_value || b.osmValue);
  if (!keyA || !keyB || keyA !== keyB || !valueA || !valueB || valueA !== valueB) return false;

  const streetA = placeAddressValue(a, ["street", "road", "addr:street"]);
  const streetB = placeAddressValue(b, ["street", "road", "addr:street"]);
  const postcodeA = placeAddressValue(a, ["postcode", "postal_code", "addr:postcode"]);
  const postcodeB = placeAddressValue(b, ["postcode", "postal_code", "addr:postcode"]);
  const cityA = placeAddressValue(a, ["city", "town", "village", "addr:city"]);
  const cityB = placeAddressValue(b, ["city", "town", "village", "addr:city"]);
  if (cityA && cityB && cityA !== cityB) return false;

  // Cas le plus fiable : les deux objets portent la même adresse complète.
  if (streetA && streetB && postcodeA && postcodeB) {
    return streetA === streetB && postcodeA === postcodeB && distance <= 35;
  }

  // Si les deux fiches possèdent des indices d'adresse mais ne permettent
  // pas de confirmer une adresse complète identique, on reste conservateur.
  // En revanche, une fiche OSM peut être enrichie par Photon (rue/ville/code
  // postal) alors que le même nœud Overpass n'a aucun champ d'adresse. Cette
  // asymétrie ne doit pas bloquer une fusion fondée sur une identité OSM forte.
  // Les divergences connues ont déjà été rejetées par hasConflictingBusinessDetails.
  const houseA = placeAddressValue(a, ["house_number", "housenumber", "addr:housenumber"]);
  const houseB = placeAddressValue(b, ["house_number", "housenumber", "addr:housenumber"]);
  const hasAddressA = Boolean(houseA || streetA || postcodeA || cityA);
  const hasAddressB = Boolean(houseB || streetB || postcodeB || cityB);
  if (hasAddressA && hasAddressB) return false;

  // Si une seule fiche est enrichie, son adresse doit au minimum contenir
  // une rue et un code postal. Un indice partiel isolé (ex. code postal seul)
  // ne suffit pas pour lever le garde-fou.
  const enrichedAddress = hasAddressA ? a : hasAddressB ? b : null;
  if (enrichedAddress && !(streetA && postcodeA || streetB && postcodeB)) return false;

  // Repli pour deux représentations du même nœud commercial :
  // - le même identifiant Wikidata de marque des deux côtés ;
  // - le même étage/niveau explicitement renseigné des deux côtés ;
  // - au moins une fiche totalement dépourvue d'adresse normalisée ;
  // - distance maximale de 25 m ;
  // - aucune divergence d'adresse, d'unité ou de contact connue.
  const tagsA = a.tags && typeof a.tags === "object" ? a.tags : {};
  const tagsB = b.tags && typeof b.tags === "object" ? b.tags : {};
  const wikidataA = normalizedField(tagsA["brand:wikidata"] || a["brand:wikidata"]);
  const wikidataB = normalizedField(tagsB["brand:wikidata"] || b["brand:wikidata"]);
  const levelA = normalizedField(tagsA.level ?? tagsA["addr:floor"] ?? a.level ?? a.floor);
  const levelB = normalizedField(tagsB.level ?? tagsB["addr:floor"] ?? b.level ?? b.floor);
  const hasSameBrandIdentity = Boolean(wikidataA && wikidataA === wikidataB);
  const hasSameExplicitLevel = Boolean(levelA && levelB && levelA === levelB);
  return hasSameBrandIdentity && hasSameExplicitLevel && distance <= 25;
}

function osmElementIdentity(place) {
  const sourceId = normalizedField(place?.sourceId).replace(/[^a-z0-9]/g, "");
  const id = String(place?.id || "").trim();
  const looksLikeOsmId = /^osm-/i.test(id);
  if (sourceId !== "openstreetmap" && !looksLikeOsmId) return null;

  const candidates = [place?.externalId, id, place?.sourceUrl];
  for (const candidate of candidates) {
    const value = String(candidate || "").trim();
    let match = value.match(/^(?:osm[-/])?(n|node|w|way|r|relation)[/-](\d+)$/i);
    if (!match) {
      match = value.match(/\/(node|way|relation)\/(\d+)(?:[?#].*)?$/i);
    }
    if (!match) continue;

    const type = match[1].toLowerCase();
    const canonicalType = type === "n" || type === "node"
      ? "node"
      : type === "w" || type === "way"
        ? "way"
        : "relation";
    return `${canonicalType}:${match[2]}`;
  }
  return null;
}

function coalesceSameOsmElements(rows) {
  const result = [];
  const positions = new Map();

  for (const row of rows) {
    const identity = osmElementIdentity(row);
    if (!identity) {
      result.push(row);
      continue;
    }

    const existingIndex = positions.get(identity);
    if (existingIndex === undefined) {
      positions.set(identity, result.length);
      result.push(row);
    } else {
      // D'abord, rassembler les représentations du MÊME objet OSM :
      // PostgreSQL (tags complets), Photon (adresse) et Overpass (géométrie/tags).
      // On ne fusionne pas encore deux nœuds différents du même commerce.
      result[existingIndex] = mergeDuplicateRows(result[existingIndex], row);
    }
  }

  return result;
}

export function deduplicate(rows) {
  // Première passe : coalescence par identité OSM exacte, afin qu'une fiche
  // Photon sans tags ne soit pas comparée seule à un autre nœud déjà fusionné.
  // Deuxième passe : déduplication commerciale prudente entre objets distincts.
  const sourceCoalescedRows = coalesceSameOsmElements(rows);
  const result = [];
  for (const row of sourceCoalescedRows) {
    const index = result.findIndex(existing => {
      if (String(existing.id) === String(row.id)) return true;
      if (fold(existing.name) !== fold(row.name)) return false;

      const a = { lat: Number(existing.lat), lon: Number(existing.lon) };
      const b = { lat: Number(row.lat), lon: Number(row.lon) };
      if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) ||
          !Number.isFinite(b.lat) || !Number.isFinite(b.lon)) return false;
      const distance = distanceMeters(a, b);
      if (hasConflictingBusinessDetails(existing, row)) return false;

      // Garde le comportement historique pour les doublons quasi superposés.
      if (distance < 15) return true;
      // Fusion prudente jusqu'à 35 m seulement si enseigne, catégorie,
      // rue et code postal concordent. Les étages/unités différents restent séparés.
      return sameCommercialPlace(existing, row, distance);
    });
    if (index < 0) result.push(row);
    else result[index] = mergeDuplicateRows(result[index], row);
  }
  return result;
}

function buildSearchSql({ intent, categoryFilter, city, country, activePoint, activeRadius, cityFallbackRadiusM = 0, cityBoundaryGeoJSON = null, countryBoundaryGeoJSON = null, destinationCountryName = '', limit }) {
  const values = [];
  const bind = value => { values.push(value); return `$${values.length}`; };
  const filters = [];
  const hasCountryBoundary = Boolean(
    countryBoundaryGeoJSON &&
    ["Polygon", "MultiPolygon"].includes(countryBoundaryGeoJSON.type)
  );

  if (intent.brand) {
    const brand = bind(intent.brand.toLocaleLowerCase("fr"));
    filters.push(`(LOWER(COALESCE(p.brand,'')) = ${brand} OR LOWER(COALESCE(p.name,'')) = ${brand})`);
    // Un bâtiment nommé comme une enseigne n'est pas automatiquement un magasin.
    // On le conserve uniquement si ses tags contiennent aussi une véritable clé métier.
    filters.push(`NOT ((COALESCE(p.category_key,'') = 'building' OR COALESCE(p.tags->>'building','') <> '')
      AND NOT (p.tags ?| ARRAY['shop','office','craft','amenity','healthcare','company','leisure','tourism','public_transport','railway','aeroway','emergency']))`);
  }
  if (intent.osmFilters?.length) {
    const tagConditions = intent.osmFilters.map(([key, value]) => {
      const keyRef = bind(key);
      if (value === "*") return `(p.category_key = ${keyRef} OR COALESCE(p.tags->>${keyRef},'') <> '')`;
      const valueRef = bind(value);
      return `((p.category_key = ${keyRef} AND p.category_value = ${valueRef}) OR p.tags->>${keyRef} = ${valueRef})`;
    });
    filters.push(`(${tagConditions.join(" OR ")})`);
  }
  if (!intent.brand && !intent.osmFilters?.length) {
    for (const term of intent.searchTokens || []) {
      const termRef = bind(term);
      let fuzzy = "";
      if (term.length >= 6) {
        const fuzzyRef = bind(term);
        fuzzy = ` OR (similarity(LOWER(COALESCE(p.name,'')),${fuzzyRef}) >= 0.64 OR similarity(LOWER(COALESCE(p.brand,'')),${fuzzyRef}) >= 0.64)`;
      }
      filters.push(`(POSITION(${termRef} IN p.search_text) > 0${fuzzy})`);
    }
  }

  if (categoryFilter && categoryFilter !== "Tout") {
    filters.push(`LOWER(COALESCE(p.category,'')) = LOWER(${bind(categoryFilter)})`);
  }
  if (city) {
    const cityRef = bind(`%${city}%`);
    if (cityBoundaryGeoJSON && ['Polygon', 'MultiPolygon'].includes(cityBoundaryGeoJSON.type)) {
      const boundaryRef = bind(JSON.stringify(cityBoundaryGeoJSON));
      const boundaryGeometry = `ST_SetSRID(ST_GeomFromGeoJSON(${boundaryRef}::text),4326)`;
      // Filtre strict sur la commune : évite le cercle de 10 km qui incluait
      // Puteaux, Levallois ou Romainville dans une recherche Paris.
      filters.push(`((p.location IS NOT NULL AND ST_Covers(${boundaryGeometry},p.location::geometry)) OR (p.location IS NULL AND p.city ILIKE ${cityRef}))`);
    } else if (cityFallbackRadiusM > 0 && activePoint) {
      const fallbackLonRef = bind(activePoint.lon);
      const fallbackLatRef = bind(activePoint.lat);
      const fallbackRadiusRef = bind(cityFallbackRadiusM);
      const fallbackPoint = `ST_SetSRID(ST_MakePoint(${fallbackLonRef},${fallbackLatRef}),4326)::geography`;
      filters.push(`(p.city ILIKE ${cityRef} OR (NULLIF(BTRIM(COALESCE(p.city,'')),'') IS NULL AND ST_DWithin(p.location,${fallbackPoint},${fallbackRadiusRef})))`);
    } else {
      filters.push(`p.city ILIKE ${cityRef}`);
    }
  }
  if (country) filters.push(`UPPER(COALESCE(p.country,'')) = UPPER(${bind(country)})`);

  if (hasCountryBoundary) {
    const boundaryRef = bind(JSON.stringify(countryBoundaryGeoJSON));
    const boundaryGeometry = `ST_SetSRID(ST_GeomFromGeoJSON(${boundaryRef}::text),4326)`;
    const countryRef = bind(String(destinationCountryName || "").trim().toLocaleLowerCase("fr"));
    filters.push(
      `((p.location IS NOT NULL AND ST_Covers(${boundaryGeometry},p.location::geometry)) OR ` +
      `(p.location IS NULL AND LOWER(BTRIM(COALESCE(p.country,''))) = ${countryRef}))`
    );
  } else if (destinationCountryName) {
    filters.push(
      `LOWER(BTRIM(COALESCE(p.country,''))) = ${bind(String(destinationCountryName).trim().toLocaleLowerCase("fr"))}`
    );
  }

  let distanceExpression = "NULL::double precision";
  if (activePoint) {
    const lonRef = bind(activePoint.lon);
    const latRef = bind(activePoint.lat);
    const pointExpression = `ST_SetSRID(ST_MakePoint(${lonRef},${latRef}),4326)::geography`;
    distanceExpression = `ST_Distance(p.location,${pointExpression})`;
    if (!hasCountryBoundary) {
      const radiusRef = bind(activeRadius);
      filters.push(`ST_DWithin(p.location,${pointExpression},${radiusRef})`);
    }
  } else if (intent.locationTokens?.length) {
    for (const token of intent.locationTokens) {
      filters.push(`POSITION(${bind(token)} IN p.location_text) > 0`);
    }
  }

  const rankParts = [];
  if (intent.brand) {
    const brandRef = bind(intent.brand.toLocaleLowerCase("fr"));
    rankParts.push(`CASE WHEN LOWER(COALESCE(p.brand,'')) = ${brandRef} OR LOWER(COALESCE(p.name,'')) = ${brandRef} THEN 1500 ELSE 0 END`);
  }
  if (intent.osmFilters?.length) rankParts.push("800");
  for (const token of [...(intent.searchTokens || []), ...(intent.locationTokens || [])]) {
    const tokenRef = bind(token);
    rankParts.push(`CASE WHEN POSITION(${tokenRef} IN p.search_text) > 0 THEN 100 ELSE 0 END`);
  }
  const rankExpression = rankParts.length ? rankParts.join(" + ") : "0";
  const limitRef = bind(Math.min(500, Math.max(limit * 4, 100)));

  const sql = `
    WITH all_places AS (
      SELECT
        p.id::text AS id, p.source_id AS "sourceId", p.external_id AS "externalId",
        p.name, COALESCE(NULLIF(p.brand,''),p.name) AS brand, p.brand_key AS "brandKey",
        CASE
          WHEN p.raw_properties->>'shop'='pet' THEN 'Animalerie'
          WHEN p.raw_properties->>'amenity'='veterinary'
            OR p.raw_properties->>'healthcare'='veterinary'
            THEN 'Santé'
          WHEN COALESCE(p.raw_properties->>'shop','') IN ('pet_grooming','dog_grooming','dog_hairdresser')
            OR p.raw_properties->>'amenity'='dog_grooming'
            OR p.raw_properties->>'animal'='wellness'
            THEN 'Toilettage animalier'
          WHEN p.raw_properties->>'office'='government'
           AND p.raw_properties->>'government'='employment_agency'
            THEN 'Emploi & intérim'
          ELSE COALESCE(NULLIF(p.category,''),'Commerce')
        END AS category,
        COALESCE(
          p.raw_properties->>'category_key',
          CASE WHEN p.raw_properties ? 'shop' THEN 'shop'
               WHEN p.raw_properties ? 'office' THEN 'office'
               WHEN p.raw_properties ? 'craft' THEN 'craft'
               WHEN p.raw_properties ? 'amenity' THEN 'amenity'
               WHEN p.raw_properties ? 'healthcare' THEN 'healthcare'
               ELSE '' END
        ) AS category_key,
        COALESCE(
          p.raw_properties->>'category_value', p.raw_properties->>'shop',
          p.raw_properties->>'office', p.raw_properties->>'craft',
          p.raw_properties->>'amenity', p.raw_properties->>'healthcare', ''
        ) AS category_value,
        p.lat, p.lon, p.address, p.phone, p.website, p.image_url AS "imageUrl",
        p.opening_hours AS "openingHours", p.source_license AS "sourceLicense", p.source_url AS "sourceUrl",
        COALESCE(p.address->>'addr:city',p.address->>'city','') AS city,
        COALESCE(p.address->>'addr:street',p.address->>'street',p.address->>'road',p.address->>'addr:full','') AS street,
        COALESCE(p.address->>'addr:postcode',p.address->>'postcode','') AS postcode,
        COALESCE(p.address->>'addr:country',p.address->>'country','') AS country,
        COALESCE(p.raw_properties,'{}'::jsonb) AS tags,
        ST_SetSRID(ST_MakePoint(p.lon,p.lat),4326)::geography AS location
      FROM public.places p
      UNION ALL
      SELECT
        'osm-' || o.osm_type || '-' || o.osm_id::text AS id,
        'openstreetmap' AS "sourceId", o.osm_type || '/' || o.osm_id::text AS "externalId",
        COALESCE(NULLIF(o.name,''),NULLIF(o.brand,''),'Lieu sans nom') AS name,
        COALESCE(NULLIF(o.brand,''),NULLIF(o.name,''),'') AS brand,
        TRIM(BOTH '-' FROM REGEXP_REPLACE(LOWER(COALESCE(NULLIF(o.brand,''),NULLIF(o.name,''),'')),'[^[:alnum:]]+','-','g')) AS "brandKey",
        CASE
          WHEN o.category_key='shop' AND o.category_value='pet' THEN 'Animalerie'
          WHEN o.category_key IN ('amenity','healthcare') AND o.category_value='veterinary' THEN 'Santé'
          WHEN o.category_key='shop' AND o.category_value IN ('pet_grooming','dog_grooming','dog_hairdresser')
            THEN 'Toilettage animalier'
          WHEN o.category_key='amenity' AND o.category_value='dog_grooming'
            THEN 'Toilettage animalier'
          WHEN (o.category_key='animal' AND o.category_value='wellness')
            OR o.tags->>'animal'='wellness'
            THEN 'Toilettage animalier'
          WHEN o.category_key='shop' AND o.category_value IN ('beauty','cosmetics','perfumery','hairdresser') THEN 'Beauté'
          WHEN o.category_key='shop' AND o.category_value IN ('supermarket','convenience','greengrocer') THEN 'Supermarché'
          WHEN o.category_key='shop' AND o.category_value='sports' THEN 'Sport'
          WHEN o.category_key='shop' AND o.category_value IN ('clothes','shoes','fashion','jewelry','bags') THEN 'Mode'
          WHEN o.category_key IN ('amenity','healthcare') AND o.category_value='pharmacy' THEN 'Pharmacie'
          WHEN o.category_key='office' AND o.category_value='employment_agency' THEN 'Emploi & intérim'
          WHEN o.category_key='office' AND o.category_value='government' AND o.tags->>'government'='employment_agency' THEN 'Emploi & intérim'
          WHEN o.category_key='company' AND o.category_value='temporary_work_agency' THEN 'Emploi & intérim'
          WHEN o.category_key='craft' THEN 'Artisanat'
          WHEN o.category_key='office' THEN 'Services professionnels'
          WHEN o.category_key='amenity' AND o.category_value IN ('restaurant','fast_food','cafe','food_court') THEN 'Restauration'
          WHEN o.category_key IN ('leisure','tourism') THEN 'Loisirs'
          WHEN o.category_key='shop' THEN 'Commerce'
          ELSE 'Services'
        END AS category,
        o.category_key, o.category_value,
        ST_Y(o.location::geometry) AS lat, ST_X(o.location::geometry) AS lon,
        JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
          'house_number',NULLIF(o.house_number,''),'road',NULLIF(o.street,''),'street',NULLIF(o.street,''),
          'postcode',NULLIF(o.postcode,''),'city',NULLIF(o.city,''),'country',NULLIF(o.country,''))) AS address,
        o.phone, o.website, NULL::text AS "imageUrl", o.opening_hours AS "openingHours",
        o.source_license AS "sourceLicense", o.source_url AS "sourceUrl",
        COALESCE(o.city,'') AS city, COALESCE(o.street,'') AS street,
        COALESCE(o.postcode,'') AS postcode, COALESCE(o.country,'') AS country,
        COALESCE(o.tags,'{}'::jsonb) AS tags, o.location
      FROM public.osm_places o
    ), searchable AS (
      SELECT p.*,
        LOWER(CONCAT_WS(' ',p.name,p.brand,p.category,p.category_key,p.category_value,p.city,p.street,p.postcode,p.country,p.tags::text)) AS search_text,
        LOWER(CONCAT_WS(' ',p.city,p.street,p.postcode,p.name)) AS location_text
      FROM all_places p
    ), filtered AS (
      SELECT p.*, ${distanceExpression} AS distance_m, (${rankExpression}) AS search_rank
      FROM searchable p
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
    ), page AS (
      SELECT * FROM filtered p
      ORDER BY p.search_rank DESC,p.distance_m ASC NULLS LAST,p.name ASC
      LIMIT ${limitRef}
    )
    SELECT COALESCE(JSON_AGG(TO_JSON(page)) FILTER (WHERE page.id IS NOT NULL),'[]'::json) AS places,
           (SELECT COUNT(*) FROM filtered) AS total
    FROM page
  `;
  return { sql, values };
}

export function registerIntelligentSearchRoutes(app, pool, options = {}) {
  const fetcher = options.fetcher || globalThis.fetch;
  const photonBaseUrl = String(
    options.photonUrl || process.env.PHOTON_URL || "https://photon.komoot.io"
  ).trim().replace(/\/+$/, "");
  const parsedPhotonBaseUrl = new URL(photonBaseUrl);

  if (
    !["http:", "https:"].includes(parsedPhotonBaseUrl.protocol) ||
    parsedPhotonBaseUrl.username ||
    parsedPhotonBaseUrl.password
  ) {
    throw new Error("PHOTON_URL doit être une URL HTTP(S) valide sans identifiants.");
  }

  const minIntervalMs = options.minIntervalMs ?? 1000;
  const cacheEnabled = options.cacheEnabled ?? !options.fetcher;
  const overpassEnabled = options.overpassEnabled ?? !options.fetcher;
  const overpassMinIntervalMs = options.overpassMinIntervalMs ?? 10_000;

  app.get("/api/search/intelligent", async (request, reply) => {
    const query = clean(request.query.q, 300);
    const requestedMode = clean(request.query.mode || "smart", 20).toLowerCase();
    const categoryFilter = clean(request.query.category || "Tout", 60);
    const city = clean(request.query.city, 120);
    const country = clean(request.query.country, 80);
    if (!["smart", "global", "nearby"].includes(requestedMode)) return reply.code(400).send({ error: "Mode de recherche invalide." });
    if (query.length === 1) return reply.code(400).send({ error: "Saisis au moins deux caractères." });

    const lat = request.query.lat === undefined ? null : Number(request.query.lat);
    const lon = request.query.lon === undefined ? null : Number(request.query.lon);
    if ((lat !== null && (!Number.isFinite(lat) || Math.abs(lat) > 90)) ||
        (lon !== null && (!Number.isFinite(lon) || Math.abs(lon) > 180)) ||
        ((lat === null) !== (lon === null))) {
      return reply.code(400).send({ error: "Coordonnées géographiques invalides." });
    }

    const radiusAsked = Number(request.query.radiusM || 3000);
    const radius = Number.isFinite(radiusAsked) ? Math.max(100, Math.min(100000, radiusAsked)) : 3000;
    const suggest = String(request.query.suggest || "") === "1";
    const limitAsked = Number(request.query.limit || (suggest ? 6 : 50));
    const limit = Math.max(1, Math.min(suggest ? 8 : 100, Number.isFinite(limitAsked) ? Math.floor(limitAsked) : 50));
    const offset = Math.max(0, Math.min(500000, Math.floor(Number(request.query.offset || 0) || 0)));

    let knownBrands = [];
    let knownLocations = [];
    if (query) {
      try {
        const catalog = await pool.query(`
          /* brand catalog */
          SELECT DISTINCT brand FROM (
            SELECT NULLIF(BTRIM(brand),'') AS brand FROM public.places
            UNION ALL
            SELECT NULLIF(BTRIM(brand),'') FROM public.osm_places WHERE category_key='shop'
          ) catalog WHERE brand IS NOT NULL ORDER BY brand
        `);
        knownBrands = (catalog.rows || []).map(row => clean(row.brand, 120)).filter(Boolean);
      } catch (error) {
        request.log?.warn?.({ err: error }, "Catalogue des enseignes indisponible");
      }

      // Reconnaître un suffixe de ville de plusieurs mots (Paris, New York,
      // Boulogne-Billancourt, La Défense) sans confondre ces mots avec une marque.
      const queryWords = wordsOf(query).map(word => word.value);
      const suffixes = [];
      for (let start = 0; start < queryWords.length; start++) {
        const value = queryWords.slice(start).join(" ").trim();
        if (value) suffixes.push(value);
      }
      if (suffixes.length) {
        try {
          const locations = await pool.query(`
            /* location catalog */
            SELECT DISTINCT city FROM (
              SELECT NULLIF(BTRIM(COALESCE(p.address->>'addr:city',p.address->>'city')),'') AS city
              FROM public.places p
              UNION ALL
              SELECT NULLIF(BTRIM(o.city),'') AS city FROM public.osm_places o
            ) known
            WHERE city IS NOT NULL AND city ILIKE ANY($1::text[])
            LIMIT 100
          `, [suffixes]);
          knownLocations = (locations.rows || []).map(row => clean(row.city, 120)).filter(Boolean);
        } catch (error) {
          request.log?.warn?.({ err: error }, "Catalogue géographique indisponible");
        }
      }
    }

    let intent = resolveSearchIntent(query, knownBrands, knownLocations);
    const nearPhrase = /\b(autour de moi|pres de moi|proche de moi|a proximite|near me)\b/i.test(fold(query));
    // Recherche intelligente : une requête tapée est globale par défaut.
    // Le GPS ne devient une frontière que sur demande explicite de proximité.
    const mode = requestedMode === "smart"
      ? (nearPhrase || (!query && categoryFilter !== "Tout" && lat !== null && lon !== null) ? "nearby" : "global")
      : requestedMode;

    if (mode === "nearby" && (lat === null || lon === null)) {
      return reply.code(400).send({ error: "Le mode proximité nécessite une position GPS valide." });
    }

    const freeTextDestinationQuery =
      mode === "global" &&
      intent.type === "free_text" &&
      Array.isArray(intent.searchTokens) &&
      intent.searchTokens.length === 1
        ? String(intent.searchTokens[0] || "")
        : "";

    const geocodeQuery = intent.destinationQuery || freeTextDestinationQuery;
    const isFreeTextDestination = Boolean(
      freeTextDestinationQuery && !intent.destinationQuery
    );

    let destination = null;
    let destinationGeocoder = null;
    let photonGeocodingUnavailable = false;
    let externalError = null;
    if (mode === "global" && geocodeQuery) {
      try {
        const geocode = await photonSearch(fetcher, geocodeQuery, 12, { baseUrl: photonBaseUrl }, minIntervalMs, cacheEnabled);
        destination = resolveDestinationFeature(geocodeQuery, geocode.features, { requireAdministrative: isFreeTextDestination });
        if (destination) destinationGeocoder = "photon";
      } catch (error) {
        photonGeocodingUnavailable = true;
        request.log?.warn?.({ err: error }, "Géocodage Photon indisponible ; tentative Nominatim");
      }

      // Nominatim est exclusivement un secours de géocodage déclenché par
      // l'action de recherche. Il n'est jamais utilisé pour chercher des POI.
      let nominatimAttempted = false;
      if (!destination && !suggest && options.nominatimEnabled !== false) {
        nominatimAttempted = true;
        try {
          const results = await nominatimSearch(fetcher, geocodeQuery, {
            url: options.nominatimUrl,
            userAgent: options.nominatimUserAgent,
            minIntervalMs: options.nominatimMinIntervalMs,
            cacheTtlMs: options.nominatimCacheTtlMs,
            cacheEnabled,
            timeoutMs: options.nominatimTimeoutMs,
            limit: 5,
            includePolygon: true,
            polygonThreshold: options.nominatimPolygonThreshold,
          });
          destination = resolveDestinationFeature(geocodeQuery, nominatimToFeatures(results), { requireAdministrative: isFreeTextDestination });
          if (destination) destinationGeocoder = "nominatim";
        } catch (error) {
          request.log?.warn?.({ err: error }, "Géocodage Nominatim de secours impossible");
          externalError = "La résolution de cette destination est momentanément indisponible.";
        }
      }

      // Photon peut résoudre le centre d'une ville sans fournir sa frontière.
      // Une seule recherche Nominatim complémentaire, déclenchée après validation
      // par l'utilisateur et mise en cache 24 h, ajoute le polygone administratif.
      if (["city", "country"].includes(destination?.scope) && !destination.boundaryGeoJSON &&
          !nominatimAttempted && !suggest && options.nominatimBoundaryEnabled !== false) {
        try {
          const results = await nominatimSearch(fetcher, geocodeQuery, {
            url: options.nominatimUrl,
            userAgent: options.nominatimUserAgent,
            minIntervalMs: options.nominatimMinIntervalMs,
            cacheTtlMs: options.nominatimCacheTtlMs,
            cacheEnabled,
            timeoutMs: options.nominatimTimeoutMs,
            limit: 5,
            includePolygon: true,
            polygonThreshold: options.nominatimPolygonThreshold,
          });
          const boundaryDestination = resolveDestinationFeature(
            geocodeQuery,
            nominatimToFeatures(results),
            { requireAdministrative: isFreeTextDestination },
          );
          const sameGeographicPlace =
            boundaryDestination?.scope === destination.scope &&
            fold(boundaryDestination.label) === fold(destination.label) &&
            distanceMeters(destination.point, boundaryDestination.point) <=
              Math.max(10_000, Number(destination.radiusM) || 18_000);
          if (sameGeographicPlace && boundaryDestination.boundaryGeoJSON) {
            destination = {
              ...destination,
              boundaryGeoJSON: boundaryDestination.boundaryGeoJSON,
              boundarySource: "nominatim",
              boundaryOsmType: boundaryDestination.boundaryOsmType,
              boundaryOsmId: boundaryDestination.boundaryOsmId,
            };
          }
        } catch (error) {
          // Le géocodage Photon reste valable ; le rayon V7 demeure le secours.
          request.log?.warn?.({ err: error }, "Frontière administrative Nominatim indisponible");
        }
      }

      if (!destination && !externalError) {
        externalError = "La résolution de cette destination est momentanément indisponible.";
      }
      if (photonGeocodingUnavailable) {
        externalError = [externalError, "Photon est momentanément indisponible ; les données enregistrées et Overpass restent consultables."].filter(Boolean).join(" ");
      }
    }

    if (destination && isFreeTextDestination) {
      intent = {
        ...intent,
        type: "location",
        destinationQuery: geocodeQuery,
        searchTokens: [],
        locationTokens: [],
        destinationOnly: true,
      };
    }

    const destinationPoint = destination?.point || null;
    const destinationRadius = destination?.radiusM || 0;
    const activePoint = mode === "nearby" ? { lat, lon } : destinationPoint;
    const activeRadius = mode === "nearby" ? radius : destinationRadius;
    const resolvedCity = !city && destination?.scope === "city" ? destination.cityName : "";
    const effectiveCity = city || resolvedCity;
    const cityBoundaryGeoJSON = !city && resolvedCity ? destination.boundaryGeoJSON : null;
    const cityFallbackRadiusM = !city && resolvedCity && !cityBoundaryGeoJSON
      ? destination.cityFallbackRadiusM
      : 0;

    const destinationCountryName = destination?.scope === "country"
      ? (destination.countryName || destination.label || "")
      : "";
    const countryBoundaryGeoJSON = destination?.scope === "country"
      ? destination.boundaryGeoJSON
      : null;

    const { sql, values } = buildSearchSql({
      intent, categoryFilter, city: effectiveCity, country,
      activePoint, activeRadius, cityFallbackRadiusM, cityBoundaryGeoJSON,
      countryBoundaryGeoJSON, destinationCountryName, limit,
    });
    let localRows = [];
    let localTotal = 0;
    try {
      const result = await pool.query(sql, values);
      const row = result.rows?.[0] || {};
      localRows = Array.isArray(row.places) ? row.places : [];
      localTotal = Number(row.total || 0);
    } catch (error) {
      request.log?.error?.({ err: error }, "Recherche SQL universelle impossible");
      externalError = [
        externalError,
        "Les données enregistrées sont momentanément indisponibles ; les sources publiques sont encore interrogées.",
      ].filter(Boolean).join(" ");
    }

    let photonRows = [];
    // Si la requête de géocodage vient d'expirer sur le même hôte Photon,
    // éviter une seconde attente identique pour la recherche de POI.
    const photonQuery = intent.destinationOnly
      ? ""
      : intent.brand || intent.categoryQuery || intent.searchTokens.join(" ") || intent.destinationQuery || query;

    if (query && photonQuery && !photonGeocodingUnavailable) {
      try {
        const payload = await photonSearch(
          fetcher,
          photonQuery,
          Math.min(100, Math.max(30, limit * 3)),
          { center: activePoint || null, osmTags: intent.categoryOsmTags, baseUrl: photonBaseUrl },
          minIntervalMs,
          cacheEnabled,
        );
        photonRows = (Array.isArray(payload.features) ? payload.features : [])
          .map(photonToPlace)
          .filter(Boolean)
          .filter(place => matchesIntent(place, intent, activePoint, activeRadius))
          .map(place => ({
            ...place,
            distance_m: activePoint ? distanceMeters(activePoint, { lat: place.lat, lon: place.lon }) : null,
          }))
          .filter(place => matchesDestinationCity(place, destination));
      } catch (error) {
        externalError = [externalError, "Photon est momentanément indisponible ; les données enregistrées restent consultables."].filter(Boolean).join(" ");
        request.log?.warn?.({ err: error }, "Recherche Photon indisponible");
      }
    }

    let overpassRows = [];
    const overpassQuery = activePoint
      ? buildOverpassQuery({ center: activePoint, radiusM: activeRadius || radius, intent, categoryFilter })
      : null;
    // Les requêtes de suggestions sont fréquentes pendant la frappe :
    // ne pas mettre une requête Overpass en file pour chaque caractère.
    // Overpass intervient uniquement après validation de la recherche.
    if (
      overpassEnabled &&
      overpassQuery &&
      !suggest &&
      !(intent.destinationOnly && destination?.scope === "country" && !destination.boundaryGeoJSON)
    ) {
      try {
        const elements = await overpassSearch(fetcher, overpassQuery, {
          minIntervalMs: overpassMinIntervalMs,
          cacheEnabled,
          url: options.overpassUrl,
        });
        overpassRows = (elements || [])
          .map(overpassToPlace)
          .filter(Boolean)
          .filter(place => matchesIntent(place, intent, activePoint, activeRadius || radius))
          .filter(place => !categoryFilter || categoryFilter === "Tout" || place.category === categoryFilter)
          .map(place => ({
            ...place,
            distance_m: distanceMeters(activePoint, { lat: place.lat, lon: place.lon }),
          }))
          .filter(place => matchesDestinationCity(place, destination));
      } catch (error) {
        externalError = [externalError, "La recherche OSM étendue est momentanément indisponible ; les résultats locaux et Photon restent disponibles."].filter(Boolean).join(" ");
        request.log?.warn?.({ err: error }, "Recherche Overpass indisponible");
      }
    }

    const combined = deduplicate([...localRows, ...photonRows, ...overpassRows]);
    combined.sort((a, b) =>
      relevance(b, intent, activePoint) - relevance(a, intent, activePoint) ||
      (Number(a.distance_m ?? Infinity) - Number(b.distance_m ?? Infinity)) ||
      String(a.name).localeCompare(String(b.name), "fr")
    );

    const places = combined.slice(offset, offset + limit);
    const total = offset === 0 && localRows.length < limit && localTotal <= localRows.length
      ? combined.length
      : Math.max(localTotal, combined.length);
    return {
      places,
      total,
      limit,
      offset,
      mode,
      requestedMode,
      correctedQuery: intent.correctedQuery,
      correction: intent.correction,
      destination: intent.destinationQuery || null,
      destinationResolved: Boolean(destinationPoint),
      destinationGeocoder,
      destinationRadiusM: destinationRadius,
      destinationScope: destination?.scope || null,
      destinationCity: destination?.scope === "city" ? destination.cityName : null,
      destinationCountry: destination?.scope === "country" ? destination.countryName : null,
      destinationCountryCode: destination?.scope === "country" ? destination.countryCode : null,
      destinationBoundarySource: destination?.boundaryGeoJSON ? (destination.boundarySource || "nominatim") : null,
      destinationBoundaryOsmType: destination?.boundaryGeoJSON ? destination.boundaryOsmType : null,
      destinationBoundaryOsmId: destination?.boundaryGeoJSON ? destination.boundaryOsmId : null,
      intent: {
        type: intent.type,
        brand: intent.brand,
        activity: intent.category,
        freeText: intent.searchTokens,
        osmFilters: intent.osmFilters,
      },
      sources: {
        postgresql: localRows.length,
        photon: photonRows.length,
        overpass: overpassRows.length,
      },
      externalError,
    };
  });
}
