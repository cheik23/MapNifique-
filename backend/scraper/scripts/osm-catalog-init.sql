CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

BEGIN;

CREATE TABLE IF NOT EXISTS public.osm_regions (
    region_id TEXT PRIMARY KEY,
    region_name TEXT NOT NULL,
    extract_url TEXT NOT NULL,
    replication_url TEXT NOT NULL,
    replication_sequence BIGINT,
    replication_timestamp TIMESTAMPTZ,
    last_synced_at TIMESTAMPTZ,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.osm_places (
    osm_type CHAR(1) NOT NULL CHECK (osm_type IN ('N','W','R')),
    osm_id BIGINT NOT NULL,
    name TEXT,
    brand TEXT,
    category_key TEXT NOT NULL,
    category_value TEXT NOT NULL,
    city TEXT,
    postcode TEXT,
    street TEXT,
    house_number TEXT,
    country TEXT,
    phone TEXT,
    website TEXT,
    opening_hours TEXT,
    osm_version INTEGER,
    osm_timestamp TIMESTAMPTZ,
    tags JSONB NOT NULL DEFAULT '{}'::jsonb,
    geom GEOMETRY(Geometry,4326) NOT NULL,
    location GEOGRAPHY(Point,4326) NOT NULL,
    source_license TEXT NOT NULL DEFAULT 'ODbL',
    source_url TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (osm_type,osm_id)
);

CREATE TABLE IF NOT EXISTS public.osm_place_regions (
    region_id TEXT NOT NULL REFERENCES public.osm_regions(region_id) ON DELETE CASCADE,
    osm_type CHAR(1) NOT NULL,
    osm_id BIGINT NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (region_id,osm_type,osm_id),
    FOREIGN KEY (osm_type,osm_id)
        REFERENCES public.osm_places(osm_type,osm_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS osm_places_location_gix
ON public.osm_places USING GIST(location);

CREATE INDEX IF NOT EXISTS osm_places_name_trgm_idx
ON public.osm_places USING GIN(name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS osm_places_brand_trgm_idx
ON public.osm_places USING GIN(brand gin_trgm_ops);

CREATE INDEX IF NOT EXISTS osm_places_category_idx
ON public.osm_places(category_key,category_value);

CREATE INDEX IF NOT EXISTS osm_places_city_idx
ON public.osm_places(city);

CREATE INDEX IF NOT EXISTS osm_place_regions_region_idx
ON public.osm_place_regions(region_id);

INSERT INTO public.osm_regions (
    region_id,region_name,extract_url,replication_url,
    replication_sequence,replication_timestamp,last_synced_at
)
SELECT
    'fr-idf',
    'Île-de-France',
    'https://download.geofabrik.de/europe/france/ile-de-france-261108.osm.pbf',
    MAX(value) FILTER (WHERE property='replication_base_url'),
    MAX(value) FILTER (WHERE property='replication_sequence_number')::BIGINT,
    MAX(value) FILTER (WHERE property='replication_timestamp')::TIMESTAMPTZ,
    NOW()
FROM osm_stage.osm2pgsql_properties
ON CONFLICT (region_id) DO UPDATE SET
    replication_url=EXCLUDED.replication_url,
    replication_sequence=EXCLUDED.replication_sequence,
    replication_timestamp=EXCLUDED.replication_timestamp,
    last_synced_at=NOW(),
    updated_at=NOW();

INSERT INTO public.osm_places (
    osm_type,osm_id,name,brand,category_key,category_value,
    city,postcode,street,house_number,country,
    phone,website,opening_hours,
    osm_version,osm_timestamp,tags,geom,location,
    source_license,source_url,last_seen_at,updated_at
)
SELECT
    s.osm_type,s.osm_id,
    NULLIF(BTRIM(s.name),''),
    NULLIF(BTRIM(s.brand),''),
    s.category_key,s.category_value,
    s.city,s.postcode,s.street,s.house_number,s.country,
    s.phone,s.website,s.opening_hours,
    s.osm_version,s.osm_timestamp,s.tags,s.geom,
    ST_PointOnSurface(s.geom)::geography,
    'ODbL',
    'https://www.openstreetmap.org/' ||
        CASE s.osm_type
            WHEN 'N' THEN 'node/'
            WHEN 'W' THEN 'way/'
            WHEN 'R' THEN 'relation/'
        END || s.osm_id::TEXT,
    NOW(),NOW()
FROM osm_stage.osm_pilot_places s
ON CONFLICT (osm_type,osm_id) DO UPDATE SET
    name=EXCLUDED.name,
    brand=EXCLUDED.brand,
    category_key=EXCLUDED.category_key,
    category_value=EXCLUDED.category_value,
    city=EXCLUDED.city,
    postcode=EXCLUDED.postcode,
    street=EXCLUDED.street,
    house_number=EXCLUDED.house_number,
    country=EXCLUDED.country,
    phone=EXCLUDED.phone,
    website=EXCLUDED.website,
    opening_hours=EXCLUDED.opening_hours,
    osm_version=EXCLUDED.osm_version,
    osm_timestamp=EXCLUDED.osm_timestamp,
    tags=EXCLUDED.tags,
    geom=EXCLUDED.geom,
    location=EXCLUDED.location,
    last_seen_at=NOW(),
    updated_at=NOW();

INSERT INTO public.osm_place_regions(region_id,osm_type,osm_id)
SELECT 'fr-idf',osm_type,osm_id
FROM osm_stage.osm_pilot_places
ON CONFLICT (region_id,osm_type,osm_id)
DO UPDATE SET last_seen_at=NOW();

ANALYZE public.osm_places;
ANALYZE public.osm_place_regions;

COMMIT;
