/**
 * Service d'itinéraires multimodaux basé sur l'API Navitia.
 *
 * La clé est lue depuis l'environnement Vite : VITE_NAVITIA_API_KEY.
 * Sans clé (ou si l'API échoue côté réseau), on renvoie des itinéraires de
 * démonstration afin que l'interface reste utilisable et testable.
 */

import { cachedJson, buildCacheKey, DEFAULT_TTL_MS } from '../api-manager.js';

const NAVITIA_BASE_URL = 'https://api.navitia.io/v1';
const NAVITIA_TIMEOUT_MS = 12000;

// Vite remplace `import.meta.env` par un objet à la compilation.
const ENV = import.meta.env || {};
const NAVITIA_API_KEY = String(ENV.VITE_NAVITIA_API_KEY || '').trim();
// Couverture Navitia : fr-idf (Paris) par défaut, surchargeable via .env.
const NAVITIA_COVERAGE = String(ENV.VITE_NAVITIA_COVERAGE || 'fr-idf').trim();

/** Métadonnées d'affichage par mode de transport. */
export const MODE_META = {
  walk: { label: 'Marche', icon: '🚶', color: '#2f9e44' },
  bike: { label: 'Vélo', icon: '🚲', color: '#0c8599' },
  metro: { label: 'Métro', icon: '🚇', color: '#1976d2' },
  bus: { label: 'Bus', icon: '🚌', color: '#e8590c' },
  tram: { label: 'Tram', icon: '🚊', color: '#7048e8' },
  train: { label: 'Train', icon: '🚆', color: '#c2255c' },
  car: { label: 'Voiture', icon: '🚗', color: '#495057' },
};

// Modes Navitia -> modes internes.
const MODE_BY_NAVITIA = {
  walking: 'walk',
  bike: 'bike',
  car: 'car',
  metro: 'metro',
  rapid_transit: 'metro',
  bus: 'bus',
  coach: 'bus',
  tramway: 'tram',
  train: 'train',
  rail: 'train',
  long_distance_train: 'train',
};

const normalizeMode = (raw) => MODE_BY_NAVITIA[String(raw || '').toLowerCase()] || 'walk';

const isStreetMode = (mode) => mode === 'walk' || mode === 'bike' || mode === 'car';

const round1 = (value) => Math.round(value * 10) / 10;

/** Distance à vol d'oiseau en kilomètres. */
const haversineKm = (a, b) => {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
};

/** Point intermédiaire sur le segment [a, b]. */
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/**
 * Coordonnées [lat, lon] d'une section Navitia.
 * Les sections de transport en commun n'ont pas toujours de tracé : on relie
 * alors les coordonnées des deux points d'arrêt.
 */
const coordsFromSection = (section) => {
  const geometry = section?.geojson;
  if (geometry && Array.isArray(geometry.coordinates)) {
    if (geometry.type === 'LineString') {
      return geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    }
    if (geometry.type === 'MultiLineString') {
      return geometry.coordinates.flat().map(([lon, lat]) => [lat, lon]);
    }
  }

  const fromCoord = section?.from?.stop_point?.coord || section?.from?.address?.coord;
  const toCoord = section?.to?.stop_point?.coord || section?.to?.address?.coord;
  if (fromCoord && toCoord) {
    return [
      [Number(fromCoord.lat), Number(fromCoord.lon)],
      [Number(toCoord.lat), Number(toCoord.lon)],
    ];
  }
  return [];
};

/** Mode dominant : le transport en commun prime sur la marche. */
const pickDominantMode = (legs) => {
  const transit = legs.filter((leg) => !isStreetMode(leg.mode) && leg.mode !== 'car');
  const pool = transit.length ? transit : legs;
  return pool.reduce((best, leg) => (leg.durationMin > best.durationMin ? leg : best), pool[0])?.mode || 'walk';
};

/** Résumé lisible : « Marche 5 min → Métro 4 → Marche 3 min ». */
const buildSummary = (legs) => legs
  .map((leg) => (isStreetMode(leg.mode) || leg.mode === 'car'
    ? `${MODE_META[leg.mode].label} ${leg.durationMin} min`
    : leg.label || `${MODE_META[leg.mode].label} ${leg.durationMin} min`))
  .join(' → ');

/** Transforme une entrée `journeys[]` de Navitia en itinéraire exploitable. */
export const parseJourney = (journey, index = 0) => {
  const sections = Array.isArray(journey?.sections) ? journey.sections : [];

  const legs = sections
    .map((section) => {
      const mode = normalizeMode(section.mode);
      const durationMin = Math.max(1, Math.round((section.duration || 0) / 60));
      const coords = coordsFromSection(section).filter(
        ([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon),
      );
      const info = section.display_informations || {};
      const distanceM = Math.round(
        section.distance || (coords.length > 1 ? haversineKm(coords[0], coords[coords.length - 1]) * 1000 : 0),
      );

      return {
        mode,
        durationMin,
        distanceM,
        label: String(info.label || info.code || '').trim() || MODE_META[mode].label,
        coords,
      };
    })
    .filter((leg) => leg.coords.length > 0 || leg.durationMin > 0);

  if (!legs.length) return null;

  const durationMin = Math.max(
    1,
    Math.round((journey?.duration || legs.reduce((sum, leg) => sum + leg.durationMin * 60, 0)) / 60),
  );
  const distanceKm = round1(
    (journey?.distances?.total ?? legs.reduce((sum, leg) => sum + leg.distanceM, 0)) / 1000,
  );
  const mode = pickDominantMode(legs);

  return {
    id: journey?.id || `journey-${index}`,
    mode,
    icon: MODE_META[mode].icon,
    durationMin,
    distanceKm,
    summary: buildSummary(legs),
    legs: legs.map((leg) => ({ ...leg, color: MODE_META[leg.mode].color })),
    demo: false,
  };
};

/** Itinéraire de démonstration : deux points reliés à vol d'oiseau. */
const demoLeg = (mode, durationMin, from, to, label = '') => {
  const distanceM = Math.round(haversineKm(from, to) * 1000);
  return { mode, durationMin, distanceM, label: label || MODE_META[mode].label, coords: [from, to] };
};

const demoJourney = (id, legs, distanceKm) => {
  const mode = pickDominantMode(legs);
  return {
    id,
    mode,
    icon: MODE_META[mode].icon,
    durationMin: legs.reduce((sum, leg) => sum + leg.durationMin, 0),
    distanceKm: round1(distanceKm),
    summary: buildSummary(legs),
    legs: legs.map((leg) => ({ ...leg, color: MODE_META[leg.mode].color })),
    demo: true,
  };
};

const demoJourneys = (fromLat, fromLon, toLat, toLon) => {
  const start = [fromLat, fromLon];
  const end = [toLat, toLon];
  const distanceKm = haversineKm(start, end);
  const stopA = lerp(start, end, 0.15);
  const stopB = lerp(start, end, 0.85);

  const walkMin = Math.max(1, Math.round(distanceKm / 0.075));
  const bikeMin = Math.max(1, Math.round(distanceKm / 0.25));
  const metroRideMin = Math.max(4, Math.round(distanceKm / 0.45));

  return [
    demoJourney('demo-metro', [
      demoLeg('walk', 5, start, stopA),
      demoLeg('metro', metroRideMin, stopA, stopB, 'Métro 4'),
      demoLeg('walk', 3, stopB, end),
    ], distanceKm),
    demoJourney('demo-bike', [
      demoLeg('bike', bikeMin, start, end),
    ], distanceKm),
    demoJourney('demo-walk', [
      demoLeg('walk', walkMin, start, end),
    ], distanceKm),
  ];
};

/**
 * Calcule des itinéraires entre deux points.
 * @param {number} fromLat latitude de départ
 * @param {number} fromLon longitude de départ
 * @param {number} toLat latitude d'arrivée
 * @param {number} toLon longitude d'arrivée
 * @returns {Promise<Array<{id: string, mode: string, icon: string, durationMin: number,
 *   distanceKm: number, summary: string, legs: Array<object>, demo: boolean}>>}
 */
export const getJourneys = async (fromLat, fromLon, toLat, toLon) => {
  const coordinates = [fromLat, fromLon, toLat, toLon];
  if (!coordinates.every((value) => Number.isFinite(Number(value)))) {
    throw new Error('Coordonnées invalides');
  }
  if (!NAVITIA_API_KEY) {
    return demoJourneys(Number(fromLat), Number(fromLon), Number(toLat), Number(toLon));
  }

  const url = new URL(`${NAVITIA_BASE_URL}/coverage/${encodeURIComponent(NAVITIA_COVERAGE)}/journeys`);
  // Navitia attend « lon;lat ».
  url.searchParams.set('from', `${fromLon};${fromLat}`);
  url.searchParams.set('to', `${toLon};${toLat}`);
  url.searchParams.set('count', '5');
  url.searchParams.set('depth', '3');
  url.searchParams.set('data_freshness', 'base_schedule');

  // Cache 24 h (IndexedDB) : un meme trajet ne consomme pas deux fois le quota.
  const cacheKey = buildCacheKey('navitia:journeys', [
    NAVITIA_COVERAGE,
    `${fromLat},${fromLon}`,
    `${toLat},${toLon}`,
  ]);
  const { data: payload } = await cachedJson(cacheKey, url.toString(), {
    ttlMs: DEFAULT_TTL_MS,
    init: {
      headers: {
        Authorization: NAVITIA_API_KEY,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(NAVITIA_TIMEOUT_MS),
    },
  });

  const journeys = Array.isArray(payload?.journeys) ? payload.journeys : [];
  return journeys
    .map((journey, index) => parseJourney(journey, index))
    .filter(Boolean)
    .slice(0, 5);
};

/** Indique si une clé Navitia est configurée (sinon : mode démo). */
export const hasNavitiaKey = () => Boolean(NAVITIA_API_KEY);
