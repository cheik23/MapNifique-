-- Reproduction synthétique du DDL historique de src/places-api.js
-- avant la migration explicite 20261120_002_places_offers.sql.
-- À exécuter uniquement dans la base jetable mapnifique_prompt26_legacy_upgrade.
CREATE TABLE places (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  spider TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  brand_key TEXT NOT NULL DEFAULT '',
  category TEXT,
  lat DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lon DOUBLE PRECISION NOT NULL CHECK (lon BETWEEN -180 AND 180),
  address JSONB NOT NULL DEFAULT '{}'::jsonb,
  phone TEXT,
  website TEXT,
  image_url TEXT,
  opening_hours TEXT,
  source_url TEXT,
  source_license TEXT,
  raw_properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(source_id, external_id)
);
CREATE INDEX places_brand_key_idx ON places(brand_key);
CREATE INDEX places_category_idx ON places(category);
CREATE INDEX places_geo_idx ON places(lat, lon);
CREATE INDEX places_last_seen_idx ON places(last_seen_at DESC);

CREATE TABLE offers (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  place_id BIGINT REFERENCES places(id) ON DELETE SET NULL,
  brand_key TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  description TEXT,
  offer_type TEXT NOT NULL CHECK (offer_type IN ('promotion','voucher','cashback')),
  scope TEXT NOT NULL CHECK (scope IN ('store','brand','online')),
  discount_label TEXT,
  promo_code TEXT,
  landing_url TEXT,
  source_url TEXT NOT NULL,
  source_name TEXT,
  terms TEXT,
  valid_from DATE,
  valid_until DATE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','expired','rejected')),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (scope <> 'store' OR place_id IS NOT NULL),
  CONSTRAINT offers_active_validity_check
    CHECK (status <> 'active' OR (verified_at IS NOT NULL AND valid_until IS NOT NULL)),
  CONSTRAINT offers_date_range_check
    CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until),
  UNIQUE(source_id, external_id),
  CONSTRAINT offers_external_id_nonempty_check
    CHECK (length(btrim(external_id)) BETWEEN 1 AND 160)
);
ALTER TABLE offers ADD COLUMN catalog_items JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX offers_place_status_idx ON offers(place_id, status, valid_until);
CREATE INDEX offers_brand_status_idx ON offers(brand_key, status, valid_until);
CREATE INDEX offers_scope_type_idx ON offers(scope, offer_type, status);

-- Une seule source synthétique et deux offres physiques distinctes : elles
-- doivent conserver leur place_id et leur scope pendant la migration.
INSERT INTO sources (id,name,base_url)
VALUES ('prompt26-legacy-source','Prompt26 legacy','https://legacy.example.test');

INSERT INTO places (source_id,external_id,name,brand,brand_key,lat,lon,address)
VALUES ('prompt26-legacy-source','legacy-place-1','Magasin historique','Enseigne Legacy','enseigne-legacy',48.8566,2.3522,'{}'::jsonb);

INSERT INTO offers (source_id,external_id,place_id,brand_key,title,offer_type,scope,source_url,status)
SELECT 'prompt26-legacy-source','legacy-store-offer',p.id,'enseigne-legacy',
       'Offre magasin legacy','promotion','store','https://legacy.example.test/store','draft'
  FROM places p WHERE p.source_id='prompt26-legacy-source' AND p.external_id='legacy-place-1';

INSERT INTO offers (source_id,external_id,place_id,brand_key,title,offer_type,scope,source_url,status)
VALUES ('prompt26-legacy-source','legacy-brand-offer',NULL,'enseigne-legacy',
        'Offre enseigne legacy','voucher','brand','https://legacy.example.test/brand','draft');
