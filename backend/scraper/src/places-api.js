import { timingSafeEqual } from 'node:crypto';
import { registerGlobalSearchRoutes } from './global-search.js';
import { registerIntelligentSearchRoutes } from './intelligent-search.js';
import { getDateInTimeZone, parseDateOnly } from './offer-validity.js';

const clean = (value, max = 300) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const validHttpUrl = (value) => {
  if (!value) return null;
  const parsed = new URL(String(value));
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Les URL doivent être HTTP(S), sans identifiants intégrés.');
  }
  return parsed.href;
};
const numberOrNull = (value) => value === undefined || value === null || value === '' ? null : Number(value);

/**
 * Vérifie le schéma des lieux/offres sans jamais créer ni modifier de table.
 * Leur structure appartient exclusivement à la migration 20261120_002_places_offers.sql.
 */
export async function assertPlacesSchemaReady(db) {
  const requiredColumns = [
    ...['id','source_id','external_id','spider','name','brand','brand_key','category','lat','lon',
      'address','phone','website','image_url','opening_hours','source_url','source_license',
      'raw_properties','last_seen_at','created_at','updated_at'].map((column) => ['places', column]),
    ...['id','source_id','external_id','place_id','brand_key','title','description','offer_type','scope',
      'discount_label','promo_code','landing_url','source_url','source_name','terms','valid_from',
      'valid_until','status','verified_at','created_at','updated_at','catalog_items'].map((column) => ['offers', column]),
    ...['id','source_id','status','started_at','finished_at','offers_seen','offers_upserted','error','details']
      .map((column) => ['offer_sync_runs', column]),
    ...['id','enabled','license_approved','license_reviewed_at','license_review_note']
      .map((column) => ['sources', column]),
  ];
  const columns = await db.query(`
    WITH required(table_name, column_name) AS (
      SELECT * FROM unnest($1::text[], $2::text[])
    )
    SELECT r.table_name || '.' || r.column_name AS missing
      FROM required r
      LEFT JOIN information_schema.columns c
        ON c.table_schema = current_schema()
       AND c.table_name = r.table_name
       AND c.column_name = r.column_name
     WHERE c.column_name IS NULL
     ORDER BY r.table_name, r.column_name
  `, [requiredColumns.map(([table]) => table), requiredColumns.map(([, column]) => column)]);

  const missing = columns.rows.map((row) => row.missing);
  if (missing.length) {
    const error = new Error(`Schéma lieux/offres incomplet. Migration 20261120_002_places_offers.sql requise : ${missing.join(', ')}`);
    error.code = 'PLACES_SCHEMA_NOT_READY';
    error.missing = missing;
    throw error;
  }

  const constraints = await db.query(`
    SELECT
      EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = to_regclass(current_schema() || '.offers')
           AND c.confrelid = to_regclass(current_schema() || '.places')
           AND c.conname = 'offers_place_id_fkey'
           AND c.contype = 'f'
           AND c.confdeltype = 'r'
      ) AS restrictive_place_fk,
      EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = to_regclass(current_schema() || '.offers')
           AND c.conname = 'offers_store_place_required_check'
           AND c.contype = 'c'
      ) AS store_place_required,
      EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = to_regclass(current_schema() || '.offers')
           AND c.conname = 'offers_non_store_place_null_check'
           AND c.contype = 'c'
      ) AS non_store_place_null,
      EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = to_regclass(current_schema() || '.offers')
           AND c.conname = 'offers_brand_key_required_check'
           AND c.contype = 'c'
      ) AS brand_key_required,
      EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = to_regclass(current_schema() || '.sources')
           AND c.conname = 'sources_license_review_consistent_check'
           AND c.contype = 'c'
      ) AS source_license_review_required,
      EXISTS (
        SELECT 1 FROM pg_constraint c
         WHERE c.conrelid = to_regclass(current_schema() || '.sources')
           AND c.conname = 'sources_enabled_requires_license_approval_check'
           AND c.contype = 'c'
      ) AS source_enable_requires_approval
  `);
  const row = constraints.rows[0] || {};
  if (!row.restrictive_place_fk || !row.store_place_required
      || !row.non_store_place_null || !row.brand_key_required
      || !row.source_license_review_required || !row.source_enable_requires_approval) {
    const error = new Error('Contraintes offers/places/sources absentes ou incorrectes. Réapplique la migration contrôlée 20261120_002_places_offers.sql sur une base de test.');
    error.code = 'PLACES_SCHEMA_NOT_READY';
    throw error;
  }
  return { ready: true, requiredColumns: requiredColumns.length };
}


const discoveryCache = new Map();

let photonLastRequestAt = 0;
let photonRequestQueue = Promise.resolve();

async function requestPhoton(url) {
  const task = photonRequestQueue.then(async () => {
    const delay = Math.max(0, 1000 - (Date.now() - photonLastRequestAt));
    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    photonLastRequestAt = Date.now();

    const response = await fetch(url, {
      headers: {
        'user-agent': 'MapNifique/2.0',
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`Photon HTTP ${response.status}`);
    }

    return response.json();
  });

  photonRequestQueue = task.catch(() => null);
  return task;
}


const OVERPASS_URL = (
  process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter'
).trim();

let overpassLastRequestAt = 0;
let overpassRequestQueue = Promise.resolve();

async function requestOverpass(query) {
  const task = overpassRequestQueue.then(async () => {
    const delay = Math.max(0, 10000 - (Date.now() - overpassLastRequestAt));
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));

    overpassLastRequestAt = Date.now();

    const response = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: {
        'user-agent': 'MapNifique/2.0',
        'accept': 'application/json',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
      },
      body: new URLSearchParams({ data: query }),
      signal: AbortSignal.timeout(45000),
    });

    if (!response.ok) throw new Error(`Overpass HTTP ${response.status}`);

    const payload = await response.json();
    if (!Array.isArray(payload.elements)) {
      throw new Error(payload.remark || 'Réponse Overpass invalide.');
    }
    return payload.elements;
  });

  overpassRequestQueue = task.catch(() => null);
  return task;
}


function discoveryNormalize(value) {
  return String(value ?? '')
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

function discoveryCanonicalQuery(value) {
  const compact = discoveryNormalize(value)
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]/g, '');

  if ([
    'macdo', 'mcdo', 'mcdonald', 'mcdonalds',
    'macdonald', 'macdonalds',
  ].includes(compact)) {
    return "McDonald's";
  }

  return String(value ?? '').trim();
}

function discoveryEscapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function discoverySearchPattern(query) {
  const compact = discoveryNormalize(query).replace(/[^a-z0-9]/g, '');
  if (['macdo', 'mcdo', 'mcdonald', 'mcdonalds', 'macdonald'].includes(compact)) {
    return "mcdonald('?s)?|mac ?do|macdonald";
  }
  // Les clés d'enseigne sont des slugs ; Overpass cherche dans les noms lisibles.
  const readable = String(query).replace(/[-_]+/g, ' ').trim();
  return discoveryEscapeRegex(readable);
}

function discoveryCategorySelectors(category) {
  const key = discoveryNormalize(category).replace(/[^a-z0-9]/g, '');

  const selectors = {
    beaute: [
      '["shop"~"beauty|cosmetics|perfumery|hairdresser"]',
      '["amenity"="beauty"]',
    ],
    supermarche: [
      '["shop"~"supermarket|convenience|greengrocer"]',
    ],
    mode: [
      '["shop"~"clothes|shoes|fashion|jewelry|bags"]',
    ],
    restauration: [
      '["amenity"~"restaurant|fast_food|cafe|food_court"]',
    ],
    pharmacie: [
      '["amenity"="pharmacy"]',
      '["healthcare"="pharmacy"]',
    ],
    autres: [
      '["shop"]',
      '["office"]',
      '["craft"]',
    ],
  };

  return selectors[key] || null;
}

function discoveryDistance(aLat, aLon, bLat, bLon) {
  const rad = (v) => v * Math.PI / 180;
  const dLat = rad(bLat - aLat);
  const dLon = rad(bLon - aLon);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function discoveryDisplayCategory(tags) {
  const value = key => String(tags?.[key] || '').toLowerCase();

  const shop = value('shop');
  const amenity = value('amenity');
  const healthcare = value('healthcare');
  const emergency = value('emergency');
  const aeroway = value('aeroway');
  const sport = value('sport');
  const leisure = value('leisure');

  // Établissements de santé : distinguer les spécialités.
  if (amenity === 'hospital' || healthcare === 'hospital') return 'Hôpital';
  if (amenity === 'clinic' || healthcare === 'clinic') return 'Clinique';
  if (amenity === 'doctors' || healthcare === 'doctor') return 'Médecin';
  if (amenity === 'dentist' || healthcare === 'dentist') return 'Dentiste';
  if (amenity === 'pharmacy' || healthcare === 'pharmacy') return 'Pharmacie';

  if (emergency === 'control_centre') return 'Centre de régulation';

  if (
    amenity === 'ambulance_station' ||
    emergency === 'ambulance_station'
  ) return 'Ambulance / Urgences';

  if (healthcare) return 'Santé';

  // Un héliport reste un lieu de transport, même si son nom contient Hôpital.
  if (['helipad', 'heliport'].includes(aeroway)) return 'Transport';

  if (['beauty', 'cosmetics', 'perfumery', 'hairdresser'].includes(shop) ||
      amenity === 'beauty') return 'Beauté';

  if (['supermarket', 'convenience', 'greengrocer'].includes(shop)) {
    return 'Supermarché';
  }

  if (['clothes', 'shoes', 'fashion', 'jewelry', 'bags'].includes(shop)) {
    return 'Mode';
  }

  if (['restaurant', 'fast_food', 'cafe', 'food_court'].includes(amenity)) {
    return 'Restauration';
  }

  if (
    sport === 'laser_tag' ||
    ['amusement_arcade', 'escape_game', 'sports_centre', 'indoor_play', 'theme_park'].includes(leisure)
  ) {
    return 'Loisirs';
  }

  if (amenity === 'police') return 'Police';
  if (amenity === 'fire_station') return 'Pompiers';
  if (['bus_station', 'taxi', 'ferry_terminal'].includes(amenity)) return 'Transport';
  if (['bicycle_rental', 'car_rental'].includes(amenity)) return 'Mobilité';

  if (shop) return 'Commerce';
  if (aeroway) return 'Transport';
  if (amenity) return 'Services';
  if (tags?.office) return 'Services professionnels';
  if (tags?.craft) return 'Artisanat';

  return 'Lieu';
}

function discoveryMapElement(element, origin) {
  const tags = element.tags || {};
  const lat = Number(element.lat ?? element.center?.lat);
  const lon = Number(element.lon ?? element.center?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = clean(tags.name || tags.brand || tags.operator || '', 180);
  if (!name) return null;

  const brand = clean(tags.brand || tags.operator || name, 180);
  const brandKey = discoveryNormalize(brand)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  const address = [
    tags['addr:housenumber'],
    tags['addr:street'],
    tags['addr:postcode'],
    tags['addr:city'] || tags['addr:town'],
  ].filter(Boolean).join(', ');

  return {
    id: `osm-${element.type}-${element.id}`,
    sourceId: 'openstreetmap',
    externalId: `${element.type}/${element.id}`,
    sourceLicense: 'ODbL',
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,
    name,
    brand,
    brandKey,
    category: discoveryDisplayCategory(tags),
    lat,
    lon,
    address,
    phone: tags.phone || tags['contact:phone'] || '',
    website: tags.website || tags['contact:website'] || '',
    openingHours: tags.opening_hours || '',
    distance_m: discoveryDistance(origin.lat, origin.lon, lat, lon),
  };
}

function discoveryBuildQuery({ lat, lon, radius, query, category }) {
  const around = `nwr(around:${radius},${lat},${lon})`;

  let selectors = [];
  if (query) {
    const patterns = String(query).split('|')
      .map(value => discoverySearchPattern(value.trim()))
      .filter(Boolean)
      .slice(0, 20)
      .map(value => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"'));

    // Recherche locale des enseignes avec offres : magasins physiques uniquement.
    // Les autres catégories restent gérées par la découverte générale.
    const businessFilters = [
      '["shop"]',
    ];

    const combinedPattern = patterns.join('|');

    for (const filter of businessFilters) {
      selectors.push(
        `${around}[~"^(name|brand|operator)$"~"${combinedPattern}",i]${filter};`
      );
    }
  } else if (category && category !== 'Tout') {
    const filters = discoveryCategorySelectors(category);
    if (filters) {
      selectors = filters.map((filter) => `${around}${filter};`);
    } else {
      selectors = [
        `${around}["shop"];`,
        `${around}["amenity"~"restaurant|fast_food|cafe|pharmacy"];`,
      ];
    }
  } else {
    selectors = [
      `${around}["shop"];`,
      `${around}["amenity"~"restaurant|fast_food|cafe|pharmacy|bank|post_office|clinic|dentist"];`,
      `${around}["healthcare"];`,
      `${around}["office"];`,
    ];
  }

  return `[out:json][timeout:25];(${selectors.join('')});out center tags;`;
}

export function registerPlaceRoutes(app, pool) {
  registerGlobalSearchRoutes(app, pool);
  registerIntelligentSearchRoutes(app, pool);

  app.get('/api/discover', async (request, reply) => {
    const query = clean(request.query.q, 500);
    const category = clean(request.query.category || 'Tout', 50);
    const lat = numberOrNull(request.query.lat);
    const lon = numberOrNull(request.query.lon);
    const askedRadius = Number(request.query.radiusM || 3000);
    const askedLimit = Number(request.query.limit || 80);
    const radius = Number.isFinite(askedRadius)
      ? Math.max(100, Math.min(10000, askedRadius))
      : 3000;
    const limit = Number.isFinite(askedLimit)
      ? Math.max(1, Math.min(100, Math.floor(askedLimit)))
      : 80;

    if (query.length === 1) {
      return reply.code(400).send({ error: 'Saisis au moins deux caractères pour rechercher.' });
    }
    if (
      lat === null || lon === null ||
      !Number.isFinite(lat) || !Number.isFinite(lon) ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180
    ) {
      return reply.code(400).send({ error: 'Une position géographique valide est nécessaire.' });
    }

    // 1. Les données du scraper restent la première source locale.
    // `q` accepte plusieurs enseignes séparées par `|` pour la page Bons plans.
    // Les brand_key sont comparés séparément des noms affichés (ex. super-u / Super U).
    const values = [lat, lon, radius];
    let queryClause = '';
    if (query) {
      const queryTerms = [...new Set(query.split('|').map((term) => clean(term, 120)).filter(Boolean))].slice(0, 20);
      const likeTerms = queryTerms.map((term) => `%${term}%`);
      const brandKeys = queryTerms.map((term) => discoveryNormalize(term)
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, ''));
      values.push(likeTerms, brandKeys);
      queryClause = `AND (
        p.name ILIKE ANY($4::text[])
        OR COALESCE(p.brand,'') ILIKE ANY($4::text[])
        OR COALESCE(p.address->>'addr:full','') ILIKE ANY($4::text[])
        OR p.brand_key = ANY($5::text[])
      )`;
    }
    values.push(limit);

    const localResult = await pool.query(`
      SELECT p.id,p.source_id AS "sourceId",p.external_id AS "externalId",
             p.name,p.brand,p.brand_key AS "brandKey",p.category,p.lat,p.lon,p.address,
             p.phone,p.website,p.image_url AS "imageUrl",
             p.opening_hours AS "openingHours",p.source_url AS "sourceUrl",
             p.source_license AS "sourceLicense",
             (6371000 * 2 * ASIN(SQRT(LEAST(1,
               POWER(SIN(RADIANS(p.lat - $1) / 2), 2) +
               COS(RADIANS($1)) * COS(RADIANS(p.lat)) *
               POWER(SIN(RADIANS(p.lon - $2) / 2), 2)
             )))) AS distance_m
        FROM places p
       WHERE (6371000 * 2 * ASIN(SQRT(LEAST(1,
               POWER(SIN(RADIANS(p.lat - $1) / 2), 2) +
               COS(RADIANS($1)) * COS(RADIANS(p.lat)) *
               POWER(SIN(RADIANS(p.lon - $2) / 2), 2)
             )))) <= $3
         ${queryClause}
       ORDER BY distance_m ASC
       LIMIT $${values.length}
    `, values);

    // 2. Cache mémoire pour limiter les appels à l'instance Overpass publique.
    const cacheKey = [
      lat.toFixed(4), lon.toFixed(4), radius,
      discoveryNormalize(query), discoveryNormalize(category),
      String(request.query.localOnly || '0'),
    ].join('|');

    let mapPlaces = [];
    let externalError = null;
    const cached = discoveryCache.get(cacheKey);

    if (cached && cached.expires > Date.now()) {
      mapPlaces = cached.places;
    } else {
      try {
        const photonBase = (
          process.env.PHOTON_URL || 'https://photon.komoot.io'
        ).replace(/\/$/, '');

        const searchingByName = Boolean(query);
        const localBrandSearch =
          searchingByName && String(request.query.localOnly || '') === '1';
        const photonQuery = searchingByName ? discoveryCanonicalQuery(query) : '';
        if (!searchingByName || localBrandSearch) {
          const overpassQuery = discoveryBuildQuery({
            lat,
            lon,
            radius,
            query: localBrandSearch ? query : '',
            category: localBrandSearch ? 'Tout' : category,
          });

          const elements = await requestOverpass(overpassQuery);

          mapPlaces = elements
            .map(element => discoveryMapElement(element, { lat, lon }))
            .filter(place => place && place.distance_m <= radius)
            .sort((a, b) => a.distance_m - b.distance_m)
            .slice(0, Math.max(limit * 3, limit));
        } else {
          const photonUrl = new URL(`${photonBase}/api`);

        photonUrl.searchParams.set('limit', String(Math.min(100, Math.max(25, limit))));
        photonUrl.searchParams.set('lang', 'fr');

        if (searchingByName) {
          // Une enseigne demandée explicitement n'est pas limitée au rayon local.
          // La position sert au classement de proximité, pas de frontière stricte.
          photonUrl.searchParams.set('q', photonQuery);
          photonUrl.searchParams.set('lat', String(lat));
          photonUrl.searchParams.set('lon', String(lon));
          photonUrl.searchParams.set('zoom', '14');
          photonUrl.searchParams.set('location_bias_scale', '0.2');
          // L'index local couvre France et Monaco : ne pas limiter à FR.
          photonUrl.searchParams.set('limit', String(Math.min(50, Math.max(20, limit))));
        } else {
          // Recherche des commerces proches par catégories OpenStreetMap.
          const tagsByCategory = {
            tout: [
              'shop',
              'amenity:restaurant',
              'amenity:fast_food',
              'amenity:cafe',
              'amenity:pharmacy',
              'amenity:bank',
              'amenity:post_office',
              'amenity:clinic',
              'amenity:dentist',
              'healthcare',
              'office',
            ],
            beaute: [
              'shop:beauty',
              'shop:cosmetics',
              'shop:perfumery',
              'shop:hairdresser',
            ],
            supermarche: [
              'shop:supermarket',
              'shop:convenience',
              'shop:greengrocer',
            ],
            mode: [
              'shop:clothes',
              'shop:shoes',
              'shop:fashion',
              'shop:jewelry',
              'shop:bags',
            ],
            restauration: [
              'amenity:restaurant',
              'amenity:fast_food',
              'amenity:cafe',
              'amenity:food_court',
            ],
            pharmacie: [
              'amenity:pharmacy',
              'healthcare:pharmacy',
            ],
            autres: [
              'shop',
              'office',
              'craft',
            ],
          };

          const categoryKey = discoveryNormalize(category).replace(/[^a-z0-9]/g, '');
          const tags = tagsByCategory[categoryKey] || tagsByCategory.tout;

          photonUrl.searchParams.set('lat', String(lat));
          photonUrl.searchParams.set('lon', String(lon));

          for (const tag of tags) {
            photonUrl.searchParams.append('osm_tag', tag);
          }
        }

        const payload = await requestPhoton(photonUrl.toString());
        const features = Array.isArray(payload.features) ? payload.features : [];

        mapPlaces = features.map((feature) => {
          const properties = feature.properties || {};
          const coordinates = feature.geometry?.coordinates || [];
          const lonValue = Number(coordinates[0]);
          const latValue = Number(coordinates[1]);

          if (!Number.isFinite(latValue) || !Number.isFinite(lonValue)) {
            return null;
          }

          const extra = (
            properties.extra &&
            typeof properties.extra === 'object'
          ) ? properties.extra : {};

          const tags = { ...extra };
          if (properties.osm_key) {
            tags[properties.osm_key] = properties.osm_value;
          }

          const name = clean(properties.name || extra.name, 180);
          if (!name) return null;

          const inactiveValues = ['vacant', 'disused', 'abandoned', 'closed'];
          if (
            properties.osm_key === 'shop' &&
            inactiveValues.includes(String(properties.osm_value || '').toLowerCase())
          ) {
            return null;
          }

          if (extra.disused || extra.abandoned || extra.closed) return null;

          const distance = discoveryDistance(lat, lon, latValue, lonValue);
          if (distance > radius) return null;

          const osmType = clean(properties.osm_type || 'N', 5);
          const osmId = String(properties.osm_id || '');
          const brand = clean(extra.brand || extra.operator || name, 180);
          const brandKey = discoveryNormalize(brand)
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '');

          return {
            id: `osm-${osmType}-${osmId || name}`,
            sourceId: 'openstreetmap',
            externalId: `${osmType}/${osmId}`,
            sourceLicense: 'ODbL',
            sourceUrl: osmId
              ? `https://www.openstreetmap.org/${osmType}/${osmId}`
              : '',
            name,
            brand,
            brandKey,
            category: discoveryDisplayCategory(tags),
            lat: latValue,
            lon: lonValue,
            address: {
              house_number: properties.housenumber || extra['addr:housenumber'] || '',
              road: properties.street || extra['addr:street'] || '',
              postcode: properties.postcode || extra['addr:postcode'] || '',
              city: properties.city || properties.district || extra['addr:city'] || '',
            },
            phone: extra.phone || extra['contact:phone'] || '',
            website: extra.website || extra['contact:website'] || '',
            openingHours: extra.opening_hours || '',
            distance_m: distance,
          };
        })
        .filter(Boolean)

        .sort((a, b) => a.distance_m - b.distance_m);

        if (searchingByName && !localBrandSearch) {
          const needle = discoveryNormalize(photonQuery)
            .replace(/[’']/g, '')
            .replace(/[^a-z0-9]+/g, ' ')
            .trim();

          const escapeRegex = value =>
            value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          const variants = needle === 'mcdonalds'
            ? ['mcdonalds', 'mcdonald', 'mcdo', 'macdo']
            : [needle];

          const patterns = variants.map(value =>
            new RegExp(`(^|\\s)${escapeRegex(value)}($|\\s)`, 'i')
          );

          mapPlaces = mapPlaces.filter(place => {
            const candidate = discoveryNormalize(
              `${place.name} ${place.brand || ''}`
            )
              .replace(/[’']/g, '')
              .replace(/[^a-z0-9]+/g, ' ')
              .trim();

            return patterns.some(pattern => pattern.test(candidate));
          });

          // Une recherche d'hôpital ne doit pas retourner un héliport
          // ou un autre lieu simplement parce que son nom contient ce mot.
          const hospitalIntent =
            /(^| )(hopital|hopitaux|hospital|hospitals|hospitalier)( |$)/.test(needle);

          if (hospitalIntent) {
            mapPlaces = mapPlaces.filter(place => place.category === 'Hôpital');
          }

          // Une recherche laser game doit privilégier les véritables lieux de loisirs.
          const laserGameIntent =
            /(^| )(laser game|laser tag)( |$)/.test(needle);

          if (laserGameIntent) {
            mapPlaces = mapPlaces.filter(place => place.category === 'Loisirs');
          }
        }

        }

        discoveryCache.set(cacheKey, {
          expires: Date.now() + 5 * 60 * 1000,
          places: mapPlaces,
        });

        if (discoveryCache.size > 150) {
          const firstKey = discoveryCache.keys().next().value;
          if (firstKey) discoveryCache.delete(firstKey);
        }
      } catch (error) {
        externalError = 'La source géographique externe est momentanément indisponible. Les commerces déjà enregistrés restent consultables.';
        request.log.warn({ err: error }, 'Source géographique indisponible');
      }
    }

    // 3. Fusion des sources sans conserver deux fois le même magasin.
    const combined = [...localResult.rows];

    for (const candidate of mapPlaces) {
      const candidateName = discoveryNormalize(candidate.name);
      const duplicate = combined.some((existing) => {
        const existingName = discoveryNormalize(existing.name);
        if (candidateName !== existingName) return false;
        return discoveryDistance(
          Number(existing.lat), Number(existing.lon),
          Number(candidate.lat), Number(candidate.lon),
        ) < 90;
      });
      if (!duplicate) combined.push(candidate);
    }

    combined.sort((a, b) => Number(a.distance_m) - Number(b.distance_m));

    return {
      places: combined.slice(0, limit),
      sources: {
        scraper: localResult.rows.length,
        openstreetmap: mapPlaces.length,
      },
      externalError,
    };
  });

  app.get('/api/places', async (request, reply) => {
    const q = clean(request.query.q, 120);
    const brandKey = clean(request.query.brandKey, 100).toLowerCase();
    const category = clean(request.query.category, 100);
    const lat = numberOrNull(request.query.lat);
    const lon = numberOrNull(request.query.lon);
    const radiusAsked = Number(request.query.radiusM || 5000);
    const limitAsked = Number(request.query.limit || 50);
    const offsetAsked = Number(request.query.offset || 0);
    const radiusM = Number.isFinite(radiusAsked) ? Math.max(100, Math.min(50000, radiusAsked)) : 5000;
    const limit = Number.isFinite(limitAsked) ? Math.max(1, Math.min(100, Math.floor(limitAsked))) : 50;
    const offset = Number.isFinite(offsetAsked) ? Math.max(0, Math.min(1_000_000, Math.floor(offsetAsked))) : 0;

    if ((lat === null) !== (lon === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180))) {
      return reply.code(400).send({ error: 'Fournis une latitude et une longitude valides ensemble.' });
    }

    const values = [];
    const clauses = [];
    let latIndex = null;
    let lonIndex = null;
    let radiusIndex = null;
    if (q) {
      values.push(`%${q}%`);
      clauses.push(`(p.name ILIKE $${values.length} OR COALESCE(p.brand,'') ILIKE $${values.length} OR COALESCE(p.address->>'addr:full','') ILIKE $${values.length})`);
    }
    if (brandKey) {
      values.push(brandKey);
      clauses.push(`p.brand_key = $${values.length}`);
    }
    if (category) {
      values.push(category);
      clauses.push(`p.category = $${values.length}`);
    }
    if (lat !== null) {
      latIndex = values.push(lat);
      lonIndex = values.push(lon);
      radiusIndex = values.push(radiusM);
      clauses.push(`p.lat BETWEEN ($${latIndex} - ($${radiusIndex} / 111320.0)) AND ($${latIndex} + ($${radiusIndex} / 111320.0))`);
      const lonDeltaSql = `($${radiusIndex} / (111320.0 * GREATEST(0.15, COS(RADIANS($${latIndex})))))`;
      clauses.push(`p.lon BETWEEN ($${lonIndex} - ${lonDeltaSql}) AND ($${lonIndex} + ${lonDeltaSql})`);
      clauses.push(`(6371000 * 2 * ASIN(SQRT(LEAST(1, POWER(SIN(RADIANS(p.lat - $${latIndex}) / 2), 2) + COS(RADIANS($${latIndex})) * COS(RADIANS(p.lat)) * POWER(SIN(RADIANS(p.lon - $${lonIndex}) / 2), 2))))) <= $${radiusIndex}`);
    }
    values.push(limit);
    const limitIndex = values.length;
    values.push(offset);
    const offsetIndex = values.length;

    const distanceExpr = latIndex !== null
      ? `(6371000 * 2 * ASIN(SQRT(LEAST(1, POWER(SIN(RADIANS(p.lat - $${latIndex}) / 2), 2) + COS(RADIANS($${latIndex})) * COS(RADIANS(p.lat)) * POWER(SIN(RADIANS(p.lon - $${lonIndex}) / 2), 2)))))`
      : 'NULL::double precision';

    const result = await pool.query(`
      SELECT p.id,p.source_id AS "sourceId",p.external_id AS "externalId",p.spider,
             p.name,p.brand,p.brand_key AS "brandKey",p.category,p.lat,p.lon,p.address,
             p.phone,p.website,p.image_url AS "imageUrl",p.opening_hours AS "openingHours",
             p.source_url AS "sourceUrl",p.source_license AS "sourceLicense",p.last_seen_at AS "lastSeenAt",
             ${distanceExpr} AS distance_m
        FROM places p
       ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY ${latIndex !== null ? 'distance_m ASC NULLS LAST,' : ''} p.name ASC
       LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `, values);
    return { places: result.rows, limit, offset };
  });

  app.get('/api/places/:id', async (request, reply) => {
    const id = Number(request.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return reply.code(400).send({ error: 'Identifiant invalide.' });
    const result = await pool.query(`
      SELECT id,source_id AS "sourceId",external_id AS "externalId",spider,name,brand,
             brand_key AS "brandKey",category,lat,lon,address,phone,website,
             image_url AS "imageUrl",opening_hours AS "openingHours",source_url AS "sourceUrl",
             source_license AS "sourceLicense",last_seen_at AS "lastSeenAt"
        FROM places WHERE id=$1
    `, [id]);
    if (!result.rows[0]) return reply.code(404).send({ error: 'Établissement introuvable.' });
    return { place: result.rows[0] };
  });

  app.get('/api/offers/brands', async () => {
    const today = getDateInTimeZone();
    const result = await pool.query(`
      SELECT DISTINCT brand_key AS "brandKey"
        FROM offers
       WHERE status='active'
         AND verified_at IS NOT NULL
         AND brand_key <> ''
         AND scope IN ('store','brand','online')
         AND (valid_from IS NULL OR valid_from <= $1::date)
         AND valid_until IS NOT NULL
         AND valid_until >= $1::date
       ORDER BY brand_key
       LIMIT 20
    `, [today]);

    return { brands: result.rows.map(row => row.brandKey) };
  });

  app.get('/api/offers', async (request, reply) => {
    const brandKey = clean(request.query.merchantKey || request.query.brandKey, 100).toLowerCase();
    const placeId = numberOrNull(request.query.placeId);
    const lat = numberOrNull(request.query.lat);
    const lon = numberOrNull(request.query.lon);
    const radiusAsked = Number(request.query.radiusM || 180);
    const radiusM = Number.isFinite(radiusAsked) ? Math.max(50, Math.min(10000, radiusAsked)) : 180;
    const today = getDateInTimeZone();
    if ((lat === null) !== (lon === null) || (lat !== null && (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180))) {
      return reply.code(400).send({ error: 'Coordonnées invalides.' });
    }
    if (placeId !== null && (!Number.isSafeInteger(placeId) || placeId < 1)) {
      return reply.code(400).send({ error: 'Identifiant de magasin invalide.' });
    }
    if (!brandKey && placeId === null) return { storeOffers: [], brandOffers: [], onlineOffers: [], cashbackOffers: [] };

    const result = await pool.query(`
      SELECT o.id,o.place_id AS "placeId",o.brand_key AS "brandKey",o.title,o.description,
             o.offer_type AS "offerType",o.scope,o.discount_label AS "discountLabel",
             o.promo_code AS "promoCode",o.landing_url AS "landingUrl",o.source_url AS "sourceUrl",
             o.source_name AS "sourceName",o.terms,o.valid_from AS "validFrom",o.valid_until AS "validUntil",
             o.verified_at AS "verifiedAt",o.status AS status,o.catalog_items AS "catalogItems",
             p.name AS "storeName",p.brand_key AS "storeBrandKey",p.lat AS "storeLat",p.lon AS "storeLon"
        FROM offers o
        LEFT JOIN places p ON p.id=o.place_id
       WHERE o.status='active' AND o.verified_at IS NOT NULL
         AND (o.valid_from IS NULL OR o.valid_from <= $5::date)
         AND o.valid_until IS NOT NULL
         AND o.valid_until >= $5::date
         AND ($1='' OR o.brand_key=$1)
         AND (
           (o.scope='store' AND (
             ($2::bigint IS NOT NULL AND o.place_id=$2)
             OR ($3::double precision IS NOT NULL AND p.id IS NOT NULL AND
                 (6371000 * 2 * ASIN(SQRT(LEAST(1, POWER(SIN(RADIANS(p.lat - $3) / 2), 2) + COS(RADIANS($3)) * COS(RADIANS(p.lat)) * POWER(SIN(RADIANS(p.lon - $4) / 2), 2))))) <= $6)
           ))
           OR (o.scope IN ('brand','online') AND $1 <> '')
         )
       ORDER BY CASE WHEN o.scope='store' THEN 0 WHEN o.scope='brand' THEN 1 ELSE 2 END,
                o.valid_until NULLS LAST, o.created_at DESC
       LIMIT 100
    `, [brandKey, placeId, lat, lon, today, radiusM]);

    const offers = result.rows;
    // Les groupes de réponse sont disjoints : un cashback ne doit pas apparaître
    // à la fois dans son périmètre commercial et dans cashbackOffers.
    return {
      storeOffers: offers.filter((offer) => offer.scope === 'store' && offer.offerType !== 'cashback'),
      brandOffers: offers.filter((offer) => offer.scope === 'brand' && offer.offerType !== 'cashback'),
      onlineOffers: offers.filter((offer) => offer.scope === 'online' && offer.offerType !== 'cashback'),
      cashbackOffers: offers.filter((offer) => offer.offerType === 'cashback'),
    };
  });

  app.post('/api/offers', async (request, reply) => {
    const expectedToken = Buffer.from(String(process.env.PLACES_ADMIN_TOKEN || ''));
    const suppliedToken = Buffer.from(String(request.headers['x-admin-token'] || ''));
    const tokenMatches = expectedToken.length > 0
      && expectedToken.length === suppliedToken.length
      && timingSafeEqual(expectedToken, suppliedToken);
    if (!tokenMatches) return reply.code(401).send({ error: 'Authentification administrateur requise.' });
    try {
      const body = request.body || {};
      const sourceId = clean(body.sourceId, 80);
      const rawExternalId = String(body.externalId ?? '').trim();
      const externalId = clean(rawExternalId, 160);
      const title = clean(body.title, 180);
      const sourceUrl = validHttpUrl(body.sourceUrl);
      const landingUrl = validHttpUrl(body.landingUrl);
      const scope = clean(body.scope, 20);
      const offerType = clean(body.offerType, 20);
      const requestedPlaceId = numberOrNull(body.placeId);
      const placeId = scope === 'store' ? requestedPlaceId : null;
      const brandKey = clean(body.brandKey, 100).toLowerCase();
      const statusAsked = clean(body.status || 'draft', 20);
      const verifiedAt = body.verifiedAt ? new Date(body.verifiedAt) : null;
      const hasValidFrom = body.validFrom !== undefined
        && body.validFrom !== null
        && body.validFrom !== '';
      const hasValidUntil = body.validUntil !== undefined
        && body.validUntil !== null
        && body.validUntil !== '';
      const validFrom = hasValidFrom ? parseDateOnly(body.validFrom) : null;
      const validUntil = hasValidUntil ? parseDateOnly(body.validUntil) : null;
      if (!/^[a-z0-9][a-z0-9:_-]{1,79}$/.test(sourceId)) throw new Error('sourceId invalide.');
      if (!externalId || rawExternalId.length > 160) {
        throw new Error('externalId stable obligatoire (160 caractères maximum) pour éviter les doublons.');
      }
      if (!title || !sourceUrl) throw new Error('Titre et URL source officiels obligatoires.');
      if (!['store','brand','online'].includes(scope)) throw new Error('scope doit être store, brand ou online.');
      if (!['promotion','voucher','cashback'].includes(offerType)) throw new Error('offerType doit être promotion, voucher ou cashback.');
      if (scope === 'store' && (!Number.isSafeInteger(placeId) || placeId < 1)) throw new Error('Une offre magasin doit être liée à un placeId.');
      if (scope !== 'store' && requestedPlaceId !== null) throw new Error('Une offre enseigne ou en ligne ne doit pas être liée à un magasin précis.');
      if (scope !== 'store' && !brandKey) throw new Error('brandKey obligatoire pour une offre enseigne ou en ligne.');
      if (!['draft','active','expired','rejected'].includes(statusAsked)) throw new Error('Statut invalide.');
      if (hasValidFrom && !validFrom) throw new Error('validFrom doit être une date réelle au format YYYY-MM-DD.');
      if (hasValidUntil && !validUntil) throw new Error('validUntil doit être une date réelle au format YYYY-MM-DD.');
      if (statusAsked === 'active' && (!verifiedAt || Number.isNaN(verifiedAt.getTime()))) throw new Error('Une offre active doit comporter verifiedAt.');
      if (statusAsked === 'active' && !validUntil) throw new Error('Une offre active doit comporter validUntil.');
      if (validFrom && validUntil && validUntil < validFrom) throw new Error('La date de fin précède la date de début.');
      if (statusAsked === 'active') {
        const today = getDateInTimeZone();
        if (validUntil < today) throw new Error('Une offre expirée ne peut pas être activée.');
        if (validFrom && validFrom > today) throw new Error('Une offre future doit rester en brouillon.');
      }

      const result = await pool.query(`
        INSERT INTO offers (source_id,external_id,place_id,brand_key,title,description,offer_type,scope,
          discount_label,promo_code,landing_url,source_url,source_name,terms,valid_from,valid_until,status,verified_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
        ON CONFLICT (source_id, external_id) DO UPDATE SET
          place_id=EXCLUDED.place_id,brand_key=EXCLUDED.brand_key,title=EXCLUDED.title,
          description=EXCLUDED.description,offer_type=EXCLUDED.offer_type,scope=EXCLUDED.scope,
          discount_label=EXCLUDED.discount_label,promo_code=EXCLUDED.promo_code,
          landing_url=EXCLUDED.landing_url,source_url=EXCLUDED.source_url,source_name=EXCLUDED.source_name,
          terms=EXCLUDED.terms,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,
          status=EXCLUDED.status,verified_at=EXCLUDED.verified_at,updated_at=NOW()
        RETURNING id,title,scope,status,verified_at AS "verifiedAt"
      `, [sourceId, externalId, placeId, brandKey, title, clean(body.description, 1000) || null,
        offerType, scope, clean(body.discountLabel, 100) || null, clean(body.promoCode, 80) || null,
        landingUrl, sourceUrl, clean(body.sourceName, 120) || null, clean(body.terms, 1500) || null,
        validFrom,
        validUntil,
        statusAsked, verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt.toISOString() : null]);
      return reply.code(201).send({ offer: result.rows[0] });
    } catch (error) {
      return reply.code(400).send({ error: error.message });
    }
  });

  app.get('/api/route', async (request, reply) => {
    const number = (key) => {
      const value = Number(request.query[key]);
      return Number.isFinite(value) ? value : null;
    };

    const originLat = number('originLat');
    const originLon = number('originLon');
    const destinationLat = number('destinationLat');
    const destinationLon = number('destinationLon');
    const mode = clean(request.query.mode || 'auto', 20);

    const validPoint = (lat, lon) =>
      lat !== null && lon !== null &&
      Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

    if (
      !validPoint(originLat, originLon) ||
      !validPoint(destinationLat, destinationLon)
    ) {
      return reply.code(400).send({ error: 'Coordonnées de départ ou d’arrivée invalides.' });
    }

    if (!['auto', 'pedestrian', 'bicycle', 'multimodal'].includes(mode)) {
      return reply.code(400).send({ error: 'Mode de déplacement inconnu.' });
    }

    try {
      const payload = {
        locations: [
          { lat: originLat, lon: originLon, type: 'break' },
          { lat: destinationLat, lon: destinationLon, type: 'break' },
        ],
        costing: mode,
        directions_options: {
          units: 'kilometers',
          language: 'fr-FR',
        },
      };

      const endpoint = (
        process.env.VALHALLA_URL || 'https://valhalla1.openstreetmap.de/route'
      ).replace(/\/$/, '');

      const url = new URL(endpoint);
      url.searchParams.set('json', JSON.stringify(payload));

      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(18000),
      });

      let data = {};
      try {
        data = await response.json();
      } catch {
        data = {};
      }

      if (!response.ok || !data.trip?.summary) {
        const reason = clean(
          data.error || data.status_message || `Valhalla HTTP ${response.status}`,
          300
        );

        request.log.warn({ mode, reason }, 'Calcul d’itinéraire indisponible');
        return reply.code(response.status === 400 ? 422 : 502).send({
          error: mode === 'multimodal'
            ? `Aucun trajet en transports en commun disponible : ${reason}`
            : `Calcul de l’itinéraire impossible : ${reason}`,
        });
      }

      const summary = data.trip.summary;
      const steps = (data.trip.legs || []).flatMap((leg) =>
        (leg.maneuvers || []).map((maneuver) => ({
          instruction: clean(maneuver.instruction || 'Continuer', 400),
          distanceKm: Number(maneuver.length || 0),
          durationSeconds: Number(maneuver.time || 0),
          type: Number(maneuver.type || 0),
        }))
      );

      const shapes = (data.trip.legs || [])
        .map((leg) => leg.shape)
        .filter((shape) => typeof shape === 'string' && shape.length > 0);

      if (!shapes.length) {
        return reply.code(502).send({ error: 'Le moteur n’a fourni aucun tracé exploitable.' });
      }

      return {
        route: {
          distanceKm: Number(summary.length || 0),
          durationSeconds: Number(summary.time || 0),
          shape: shapes[0],
          steps,
          source: 'Valhalla / OpenStreetMap',
        },
      };
    } catch (error) {
      request.log.warn({ err: error, mode }, 'Erreur du calcul d’itinéraire');
      return reply.code(502).send({
        error: 'Le moteur de calcul d’itinéraire est temporairement indisponible.',
      });
    }
  });


}
