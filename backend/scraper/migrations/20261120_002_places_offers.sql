-- Schéma explicite des commerces, promotions et journaux de collecte.
-- À appliquer après 000 et 001, avant la réconciliation qui fixe schema_state à 2.
-- Cette migration ne crée aucune donnée commerciale et ne supprime aucune ligne.
BEGIN;

DO $$
DECLARE v_version INTEGER;
BEGIN
  IF to_regclass('public.schema_state') IS NULL THEN
    RAISE EXCEPTION 'schema_state absent : appliquer la migration 20261120_000_baseline_schema.sql';
  END IF;
  SELECT version INTO v_version FROM public.schema_state WHERE singleton;
  IF v_version NOT IN (1, 2) THEN
    RAISE EXCEPTION 'Migration places/offers attend la version 1 ou 2, version actuelle : %', v_version;
  END IF;
END $$;

ALTER TABLE public.sources ALTER COLUMN enabled SET DEFAULT FALSE;
ALTER TABLE public.sources
  ADD COLUMN IF NOT EXISTS license_approved BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS license_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS license_review_note TEXT;
ALTER TABLE public.sources ALTER COLUMN license_approved SET DEFAULT FALSE;

-- Les anciennes sources actives n'ont pas de preuve de revue dans ce schéma.
-- Elles sont conservées mais désactivées jusqu'à une approbation administrative explicite.
UPDATE public.sources
   SET enabled = FALSE,
       license_approved = FALSE,
       license_reviewed_at = NULL,
       license_review_note = NULL
 WHERE (enabled IS TRUE AND NOT (
          license_approved IS TRUE
          AND license_reviewed_at IS NOT NULL
          AND length(btrim(COALESCE(license_review_note,''))) > 0
        ))
    OR (license_approved IS TRUE AND (
          license_reviewed_at IS NULL
          OR length(btrim(COALESCE(license_review_note,''))) = 0
        ))
    OR (license_approved IS FALSE AND (
          license_reviewed_at IS NOT NULL OR license_review_note IS NOT NULL
        ));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.sources'::regclass
       AND conname='sources_license_review_consistent_check'
  ) THEN
    ALTER TABLE public.sources
      ADD CONSTRAINT sources_license_review_consistent_check CHECK (
        (license_approved = FALSE AND license_reviewed_at IS NULL AND license_review_note IS NULL)
        OR (license_approved = TRUE AND license_reviewed_at IS NOT NULL AND length(btrim(license_review_note)) > 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.sources'::regclass
       AND conname='sources_enabled_requires_license_approval_check'
  ) THEN
    ALTER TABLE public.sources
      ADD CONSTRAINT sources_enabled_requires_license_approval_check
      CHECK (NOT enabled OR license_approved);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.places (
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
  CONSTRAINT places_source_external_uidx UNIQUE(source_id, external_id)
);

CREATE INDEX IF NOT EXISTS places_brand_key_idx ON public.places(brand_key);
CREATE INDEX IF NOT EXISTS places_category_idx ON public.places(category);
CREATE INDEX IF NOT EXISTS places_geo_idx ON public.places(lat, lon);
CREATE INDEX IF NOT EXISTS places_last_seen_idx ON public.places(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.offers (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  place_id BIGINT,
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
  catalog_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT offers_store_place_required_check CHECK (scope <> 'store' OR place_id IS NOT NULL),
  CONSTRAINT offers_non_store_place_null_check CHECK (scope = 'store' OR place_id IS NULL),
  CONSTRAINT offers_brand_key_required_check CHECK (scope = 'store' OR length(btrim(brand_key)) > 0),
  CONSTRAINT offers_active_validity_check CHECK (status <> 'active' OR (verified_at IS NOT NULL AND valid_until IS NOT NULL)),
  CONSTRAINT offers_date_range_check CHECK (valid_from IS NULL OR valid_until IS NULL OR valid_from <= valid_until),
  CONSTRAINT offers_source_external_uidx UNIQUE(source_id, external_id),
  CONSTRAINT offers_external_id_nonempty_check CHECK (length(btrim(external_id)) BETWEEN 1 AND 160)
);

ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS catalog_items JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Les anciennes lignes sont contrôlées avant d'ajouter les contraintes de scope.
-- Aucune donnée n'est corrigée ou déplacée automatiquement : une ambiguïté bloque
-- la migration et doit être résolue explicitement à partir de la source.
DO $$
DECLARE v_non_store_place BIGINT; v_missing_brand BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_non_store_place
    FROM public.offers WHERE scope <> 'store' AND place_id IS NOT NULL;
  SELECT COUNT(*) INTO v_missing_brand
    FROM public.offers WHERE scope IN ('brand','online') AND length(btrim(COALESCE(brand_key,''))) = 0;
  IF v_non_store_place > 0 OR v_missing_brand > 0 THEN
    RAISE EXCEPTION 'Migration offers refusée : % offre(s) brand/online liées à un magasin, % offre(s) brand/online sans brand_key. Aucune donnée n''a été modifiée.',
      v_non_store_place, v_missing_brand;
  END IF;
END $$;

-- Normalise les contraintes créées implicitement par l'ancien DDL applicatif.
-- RESTRICT est cohérent avec CHECK (scope='store' => place_id NOT NULL).
DO $$
DECLARE c RECORD;
BEGIN
  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.offers'::regclass
       AND contype = 'c'
       AND position('store' in pg_get_constraintdef(oid)) > 0
       AND position('place_id' in pg_get_constraintdef(oid)) > 0
       AND conname <> 'offers_non_store_place_null_check'
  LOOP
    EXECUTE format('ALTER TABLE public.offers DROP CONSTRAINT %I', c.conname);
  END LOOP;

  FOR c IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'public.offers'::regclass
       AND confrelid = 'public.places'::regclass
       AND contype = 'f'
  LOOP
    EXECUTE format('ALTER TABLE public.offers DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.offers
  ADD CONSTRAINT offers_store_place_required_check
  CHECK (scope <> 'store' OR place_id IS NOT NULL);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass AND conname='offers_non_store_place_null_check'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_non_store_place_null_check CHECK (scope = 'store' OR place_id IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass AND conname='offers_brand_key_required_check'
  ) THEN
    ALTER TABLE public.offers
      ADD CONSTRAINT offers_brand_key_required_check CHECK (scope = 'store' OR length(btrim(brand_key)) > 0);
  END IF;
END $$;

ALTER TABLE public.offers
  ADD CONSTRAINT offers_place_id_fkey
  FOREIGN KEY (place_id) REFERENCES public.places(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS offers_place_status_idx ON public.offers(place_id, status, valid_until);
CREATE INDEX IF NOT EXISTS offers_brand_status_idx ON public.offers(brand_key, status, valid_until);
CREATE INDEX IF NOT EXISTS offers_scope_type_idx ON public.offers(scope, offer_type, status);

CREATE TABLE IF NOT EXISTS public.offer_sync_runs (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success','partial','failed')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  offers_seen INTEGER NOT NULL DEFAULT 0,
  offers_upserted INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS offer_sync_runs_source_date_idx
  ON public.offer_sync_runs(source_id, started_at DESC);

CREATE OR REPLACE FUNCTION public.places_schema_problems()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE v_missing TEXT;
BEGIN
  IF to_regclass('public.places') IS NULL
     OR to_regclass('public.offers') IS NULL
     OR to_regclass('public.offer_sync_runs') IS NULL THEN
    IF to_regclass('public.places') IS NULL THEN RETURN NEXT 'table absente : places'; END IF;
    IF to_regclass('public.offers') IS NULL THEN RETURN NEXT 'table absente : offers'; END IF;
    IF to_regclass('public.offer_sync_runs') IS NULL THEN RETURN NEXT 'table absente : offer_sync_runs'; END IF;
    RETURN;
  END IF;

  WITH required(table_name, column_name) AS (
    VALUES
      ('places','source_id'),('places','external_id'),('places','spider'),('places','name'),('places','brand'),('places','brand_key'),
      ('places','category'),('places','lat'),('places','lon'),('places','address'),('places','phone'),('places','website'),
      ('places','image_url'),('places','opening_hours'),('places','source_url'),('places','source_license'),
      ('places','raw_properties'),('places','last_seen_at'),('places','created_at'),('places','updated_at'),
      ('offers','source_id'),('offers','external_id'),('offers','place_id'),('offers','brand_key'),('offers','title'),
      ('offers','description'),('offers','offer_type'),('offers','scope'),('offers','discount_label'),('offers','promo_code'),
      ('offers','landing_url'),('offers','source_url'),('offers','source_name'),('offers','terms'),('offers','valid_from'),
      ('offers','valid_until'),('offers','status'),('offers','verified_at'),('offers','created_at'),('offers','updated_at'),
      ('offers','catalog_items'),
      ('offer_sync_runs','source_id'),('offer_sync_runs','status'),('offer_sync_runs','started_at'),
      ('offer_sync_runs','finished_at'),('offer_sync_runs','offers_seen'),('offer_sync_runs','offers_upserted'),
      ('offer_sync_runs','error'),('offer_sync_runs','details'),
      ('sources','enabled'),('sources','license_approved'),('sources','license_reviewed_at'),('sources','license_review_note')
  )
  SELECT string_agg(r.table_name || '.' || r.column_name, ', ' ORDER BY r.table_name, r.column_name)
    INTO v_missing
    FROM required r
    LEFT JOIN information_schema.columns c
      ON c.table_schema='public' AND c.table_name=r.table_name AND c.column_name=r.column_name
   WHERE c.column_name IS NULL;
  IF v_missing IS NOT NULL THEN
    RETURN NEXT 'colonnes absentes : ' || v_missing;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sources' AND column_name='enabled'
       AND lower(column_default) IN ('false', 'false::boolean')
  ) THEN
    RETURN NEXT 'sources.enabled doit être FALSE par défaut';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='sources' AND column_name='license_approved'
       AND lower(column_default) IN ('false', 'false::boolean')
  ) THEN
    RETURN NEXT 'sources.license_approved doit être FALSE par défaut';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.sources'::regclass AND conname='sources_license_review_consistent_check'
  ) THEN
    RETURN NEXT 'contrainte absente : sources_license_review_consistent_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.sources'::regclass AND conname='sources_enabled_requires_license_approval_check'
  ) THEN
    RETURN NEXT 'contrainte absente : sources_enabled_requires_license_approval_check';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND confrelid='public.places'::regclass
       AND conname='offers_place_id_fkey'
       AND contype='f' AND confdeltype='r'
  ) THEN
    RETURN NEXT 'FK offers.place_id -> places.id doit utiliser ON DELETE RESTRICT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND conname='offers_store_place_required_check' AND contype='c'
  ) THEN
    RETURN NEXT 'contrainte absente : offers_store_place_required_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND conname='offers_non_store_place_null_check' AND contype='c'
  ) THEN
    RETURN NEXT 'contrainte absente : offers_non_store_place_null_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND conname='offers_brand_key_required_check' AND contype='c'
  ) THEN
    RETURN NEXT 'contrainte absente : offers_brand_key_required_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND conname='offers_active_validity_check' AND contype='c'
  ) THEN
    RETURN NEXT 'contrainte absente : offers_active_validity_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND conname='offers_date_range_check' AND contype='c'
  ) THEN
    RETURN NEXT 'contrainte absente : offers_date_range_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='public.offers'::regclass
       AND conname='offers_external_id_nonempty_check' AND contype='c'
  ) THEN
    RETURN NEXT 'contrainte absente : offers_external_id_nonempty_check';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.offers'::regclass AND c.contype='u'
       AND c.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid='public.offers'::regclass AND attname='source_id' AND NOT attisdropped),
         (SELECT attnum FROM pg_attribute WHERE attrelid='public.offers'::regclass AND attname='external_id' AND NOT attisdropped)
       ]::smallint[]
  ) THEN
    RETURN NEXT 'unicité absente : offers(source_id, external_id)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
     WHERE c.conrelid='public.places'::regclass AND c.contype='u'
       AND c.conkey = ARRAY[
         (SELECT attnum FROM pg_attribute WHERE attrelid='public.places'::regclass AND attname='source_id' AND NOT attisdropped),
         (SELECT attnum FROM pg_attribute WHERE attrelid='public.places'::regclass AND attname='external_id' AND NOT attisdropped)
       ]::smallint[]
  ) THEN
    RETURN NEXT 'unicité absente : places(source_id, external_id)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.offers'::regclass AND conname='offers_offer_type_check' AND contype='c') THEN
    RETURN NEXT 'contrainte absente : offers_offer_type_check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.offers'::regclass AND conname='offers_scope_check' AND contype='c') THEN
    RETURN NEXT 'contrainte absente : offers_scope_check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.offers'::regclass AND conname='offers_status_check' AND contype='c') THEN
    RETURN NEXT 'contrainte absente : offers_status_check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.places'::regclass AND conname='places_lat_check' AND contype='c') THEN
    RETURN NEXT 'contrainte absente : places_lat_check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.places'::regclass AND conname='places_lon_check' AND contype='c') THEN
    RETURN NEXT 'contrainte absente : places_lon_check';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.offer_sync_runs'::regclass AND conname='offer_sync_runs_status_check' AND contype='c') THEN
    RETURN NEXT 'contrainte absente : offer_sync_runs_status_check';
  END IF;
  IF to_regclass('public.places_geo_idx') IS NULL THEN
    RETURN NEXT 'index absent : places_geo_idx';
  END IF;
  IF to_regclass('public.offers_place_status_idx') IS NULL THEN
    RETURN NEXT 'index absent : offers_place_status_idx';
  END IF;
  IF to_regclass('public.offers_brand_status_idx') IS NULL THEN
    RETURN NEXT 'index absent : offers_brand_status_idx';
  END IF;
  IF to_regclass('public.offer_sync_runs_source_date_idx') IS NULL THEN
    RETURN NEXT 'index absent : offer_sync_runs_source_date_idx';
  END IF;
END;
$$;

COMMIT;
