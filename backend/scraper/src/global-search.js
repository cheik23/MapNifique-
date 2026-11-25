const clean = (value, max = 300) =>
  String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const numberOrNull = value => {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const OSM_CATEGORY_SQL = `
CASE
  WHEN category_key = 'shop'
   AND category_value IN ('beauty','cosmetics','perfumery','hairdresser')
    THEN 'Beauté'

  WHEN category_key = 'shop'
   AND category_value IN ('supermarket','convenience','greengrocer')
    THEN 'Supermarché'

  WHEN category_key = 'shop'
   AND category_value IN ('clothes','shoes','fashion','jewelry','bags')
    THEN 'Mode'

  WHEN category_key = 'healthcare' AND category_value = 'pharmacy'
    THEN 'Pharmacie'
  WHEN category_key = 'amenity' AND category_value = 'pharmacy'
    THEN 'Pharmacie'

  WHEN category_key IN ('healthcare','amenity')
   AND category_value IN ('hospital')
    THEN 'Hôpital'
  WHEN category_key IN ('healthcare','amenity')
   AND category_value IN ('clinic')
    THEN 'Clinique'
  WHEN category_key IN ('healthcare','amenity')
   AND category_value IN ('doctor','doctors')
    THEN 'Médecin'
  WHEN category_key IN ('healthcare','amenity')
   AND category_value = 'dentist'
    THEN 'Dentiste'

  WHEN category_key = 'amenity'
   AND category_value IN ('restaurant','fast_food','cafe','food_court')
    THEN 'Restauration'

  WHEN category_key = 'leisure'
   AND category_value IN (
     'fitness_centre','sports_centre','gym','bowling_alley',
     'escape_game','amusement_arcade','swimming_pool',
     'water_park','miniature_golf','dance'
   )
    THEN 'Loisirs'

  WHEN category_key = 'tourism'
   AND category_value IN ('attraction','museum','gallery','zoo','aquarium','theme_park')
    THEN 'Loisirs'

  WHEN category_key = 'tourism'
   AND category_value IN ('hotel','hostel','motel','guest_house','camp_site')
    THEN 'Hébergement'

  WHEN category_key IN ('public_transport','railway','aeroway')
    THEN 'Transport'

  WHEN category_key = 'amenity'
   AND category_value IN ('school','college','university','kindergarten','childcare')
    THEN 'Éducation'

  WHEN category_key = 'office'
    THEN 'Services professionnels'
  WHEN category_key = 'craft'
    THEN 'Artisanat'

  WHEN category_key = 'shop'
    THEN 'Commerce'

  WHEN category_key = 'emergency'
    THEN 'Urgences'

  ELSE 'Services'
END
`;

export function registerGlobalSearchRoutes(app, pool) {
  app.get('/api/search/places', async (request, reply) => {
    const query = clean(request.query.q, 300);
    const mode = clean(request.query.mode || 'global', 20).toLowerCase();
    const category = clean(request.query.category || 'Tout', 60);
    const city = clean(request.query.city, 120);
    const country = clean(request.query.country, 80);

    if (!['global', 'nearby'].includes(mode)) {
      return reply.code(400).send({
        error: 'Mode invalide. Utilise global ou nearby.',
      });
    }

    if (query.length === 1) {
      return reply.code(400).send({
        error: 'Saisis au moins deux caractères pour rechercher.',
      });
    }

    const lat = numberOrNull(request.query.lat);
    const lon = numberOrNull(request.query.lon);

    if (mode === 'nearby' && (
      lat === null || lon === null ||
      Math.abs(lat) > 90 || Math.abs(lon) > 180
    )) {
      return reply.code(400).send({
        error: 'Le mode proximité nécessite une latitude et une longitude valides.',
      });
    }

    const radiusAsked = Number(request.query.radiusM || 3000);
    const radius = Number.isFinite(radiusAsked)
      ? Math.max(100, Math.min(100000, radiusAsked))
      : 3000;

    const limitAsked = Number(request.query.limit || 50);
    const limit = Number.isFinite(limitAsked)
      ? Math.max(1, Math.min(100, Math.floor(limitAsked)))
      : 50;

    const offsetAsked = Number(request.query.offset || 0);
    const offset = Number.isFinite(offsetAsked)
      ? Math.max(0, Math.min(500000, Math.floor(offsetAsked)))
      : 0;

    const values = [];
    const bind = value => {
      values.push(value);
      return `$${values.length}`;
    };

    const filters = [];

    if (query) {
      const qRef = bind(query);
      const likeRef = bind(`%${query}%`);

      filters.push(`(
        COALESCE(p.name,'') ILIKE ${likeRef}
        OR COALESCE(p.brand,'') ILIKE ${likeRef}
        OR COALESCE(p.city,'') ILIKE ${likeRef}
        OR COALESCE(p.street,'') ILIKE ${likeRef}
        OR COALESCE(p.house_number,'') ILIKE ${likeRef}
        OR COALESCE(p.postcode,'') ILIKE ${likeRef}
        OR COALESCE(p.category_value,'') ILIKE ${likeRef}
        OR COALESCE(p.tags->>'name:fr','') ILIKE ${likeRef}
        OR COALESCE(p.tags->>'operator','') ILIKE ${likeRef}
        ${query.length >= 3 ? `
        OR similarity(COALESCE(p.name,''),${qRef}) >= 0.28
        OR similarity(COALESCE(p.brand,''),${qRef}) >= 0.28
        ` : ''}
      )`);
    }

    if (category && category !== 'Tout') {
      filters.push(`p.category = ${bind(category)}`);
    }

    if (city) {
      filters.push(`p.city ILIKE ${bind(`%${city}%`)}`);
    }

    if (country) {
      filters.push(`UPPER(COALESCE(p.country,'')) = UPPER(${bind(country)})`);
    }

    let pointExpression = null;

    if (mode === 'nearby') {
      const lonRef = bind(lon);
      const latRef = bind(lat);
      const radiusRef = bind(radius);

      pointExpression =
        `ST_SetSRID(ST_MakePoint(${lonRef},${latRef}),4326)::geography`;

      filters.push(
        `ST_DWithin(p.location,${pointExpression},${radiusRef})`,
      );
    }

    const distanceExpression = mode === 'nearby'
      ? `ST_Distance(p.location,${pointExpression})`
      : 'NULL::double precision';

    let orderSql = '';

    if (query) {
      const qRef = bind(query);
      const prefixRef = bind(`${query}%`);

      const relevance = `
        CASE
          WHEN LOWER(COALESCE(p.name,'')) = LOWER(${qRef}) THEN 0
          WHEN p.name ILIKE ${prefixRef} THEN 1
          ELSE 2
        END,
        GREATEST(
          similarity(COALESCE(p.name,''),${qRef}),
          similarity(COALESCE(p.brand,''),${qRef})
        ) DESC,
      `;

      orderSql = mode === 'nearby'
        ? `${relevance} p.distance_m ASC NULLS LAST, p.name ASC`
        : `${relevance} COALESCE(p.city,''), p.name ASC`;
    } else {
      orderSql = mode === 'nearby'
        ? 'p.distance_m ASC NULLS LAST, p.name ASC'
        : "COALESCE(p.city,''), p.name ASC";
    }

    const limitRef = bind(limit);
    const offsetRef = bind(offset);

    const sql = `
      WITH all_places AS (
        SELECT
          p.id::text AS id,
          p.source_id AS "sourceId",
          p.external_id AS "externalId",
          p.name,
          COALESCE(NULLIF(p.brand,''),p.name) AS brand,
          p.brand_key AS "brandKey",
          COALESCE(NULLIF(p.category,''),'Commerce') AS category,
          NULL::text AS category_value,
          p.lat,
          p.lon,
          p.address,
          p.phone,
          p.website,
          p.image_url AS "imageUrl",
          p.opening_hours AS "openingHours",
          p.source_license AS "sourceLicense",
          p.source_url AS "sourceUrl",
          COALESCE(p.address->>'addr:city',p.address->>'city','') AS city,
          COALESCE(p.address->>'addr:street_address',p.address->>'addr:full','') AS street,
          COALESCE(p.address->>'addr:housenumber','') AS house_number,
          COALESCE(p.address->>'addr:postcode',p.address->>'postcode','') AS postcode,
          COALESCE(p.address->>'addr:country','') AS country,
          COALESCE(p.raw_properties,'{}'::jsonb) AS tags,
          ST_SetSRID(ST_MakePoint(p.lon,p.lat),4326)::geography AS location
        FROM public.places p

        UNION ALL

        SELECT
          'osm-' || o.osm_type || '-' || o.osm_id::text AS id,
          'openstreetmap' AS "sourceId",
          o.osm_type || '/' || o.osm_id::text AS "externalId",
          COALESCE(NULLIF(o.name,''),NULLIF(o.brand,''),'Lieu sans nom') AS name,
          COALESCE(NULLIF(o.brand,''),NULLIF(o.name,''),'') AS brand,
          TRIM(BOTH '-' FROM REGEXP_REPLACE(
            LOWER(COALESCE(NULLIF(o.brand,''),NULLIF(o.name,''),'')),
            '[^[:alnum:]]+','-','g'
          )) AS "brandKey",
          ${OSM_CATEGORY_SQL} AS category,
          o.category_value,
          ST_Y(o.location::geometry) AS lat,
          ST_X(o.location::geometry) AS lon,
          JSONB_STRIP_NULLS(JSONB_BUILD_OBJECT(
            'street_address',
              NULLIF(CONCAT_WS(' ',NULLIF(o.house_number,''),NULLIF(o.street,'')),''),
            'addr:street_address',
              NULLIF(CONCAT_WS(' ',NULLIF(o.house_number,''),NULLIF(o.street,'')),''),
            'street',NULLIF(o.street,''),
            'addr:street',NULLIF(o.street,''),
            'postcode',NULLIF(o.postcode,''),
            'addr:postcode',NULLIF(o.postcode,''),
            'city',NULLIF(o.city,''),
            'addr:city',NULLIF(o.city,''),
            'country',NULLIF(o.country,'')
          )) AS address,
          o.phone,
          o.website,
          NULL::text AS "imageUrl",
          o.opening_hours AS "openingHours",
          o.source_license AS "sourceLicense",
          o.source_url AS "sourceUrl",
          COALESCE(o.city,'') AS city,
          COALESCE(o.street,'') AS street,
          COALESCE(o.house_number,'') AS house_number,
          COALESCE(o.postcode,'') AS postcode,
          COALESCE(o.country,'') AS country,
          COALESCE(o.tags,'{}'::jsonb) AS tags,
          o.location
        FROM public.osm_places o
      ),
      filtered AS (
        SELECT
          p.*,
          ${distanceExpression} AS distance_m
        FROM all_places p
        ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''}
      ),
      page AS (
        SELECT *
        FROM filtered p
        ORDER BY ${orderSql}
        LIMIT ${limitRef}
        OFFSET ${offsetRef}
      )
      SELECT
        COALESCE(JSON_AGG(TO_JSON(page)),'[]'::json) AS places,
        (SELECT COUNT(*) FROM filtered) AS total
      FROM page
    `;

    try {
      const result = await pool.query(sql, values);
      const row = result.rows?.[0] || {};

      return {
        places: Array.isArray(row.places) ? row.places : [],
        total: Number(row.total || 0),
        limit,
        offset,
        mode,
        source: 'postgresql_postgis',
      };
    } catch (error) {
      request.log?.error?.({ err: error }, 'Recherche mondiale MapNifique impossible');
      return reply.code(500).send({
        error: 'Le moteur de recherche géographique est momentanément indisponible.',
      });
    }
  });
}
