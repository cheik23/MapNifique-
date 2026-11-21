-- Version 1 : identité produit, staging reprenable, provenances d'observation.
-- La version 2 n'est posée que par scripts/reconcile-product-identity.js, après
-- validation complète des données et avant COMMIT.
BEGIN;

DO $$
DECLARE
  current_version INTEGER;
BEGIN
  SELECT version INTO current_version FROM schema_state WHERE singleton;
  IF current_version IS NULL THEN
    RAISE EXCEPTION 'schema_state absent : applique d''abord 20261120_000_baseline_schema.sql';
  END IF;
  IF current_version > 1 THEN
    RAISE EXCEPTION 'Migration 001 refusée : la base est déjà en version %', current_version;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1. Produits : URL de fiche nullable, provenance de découverte, identité.
-- ---------------------------------------------------------------------------
ALTER TABLE products ALTER COLUMN product_url DROP NOT NULL;
ALTER TABLE products DROP CONSTRAINT IF EXISTS products_source_id_product_url_key;
CREATE UNIQUE INDEX IF NOT EXISTS products_source_product_url_uidx
  ON products(source_id, product_url) WHERE product_url IS NOT NULL;

ALTER TABLE products ADD COLUMN IF NOT EXISTS discovered_from TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS identity_key TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS identity JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS products_identity_idx
  ON products(source_id, identity_key) WHERE identity_key IS NOT NULL;

-- La devise inconnue reste NULL : aucune substitution implicite par EUR.
ALTER TABLE price_observations ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE price_observations ALTER COLUMN currency DROP DEFAULT;
ALTER TABLE price_observations DROP CONSTRAINT IF EXISTS price_observations_currency_check;
ALTER TABLE price_observations
  ADD CONSTRAINT price_observations_currency_check
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$');

-- ---------------------------------------------------------------------------
-- 2. Staging : candidats, observations, provenances.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_candidates (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT NOT NULL REFERENCES scrape_jobs(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id),
  discovery_key TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  product_url TEXT,
  discovered_from TEXT NOT NULL,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  image_url TEXT,
  identity JSONB NOT NULL DEFAULT '{}'::jsonb,
  identifiers JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'staged'
    CHECK (status IN ('staged','classified','blocked','finalized')),
  block_reason TEXT,
  product_id BIGINT REFERENCES products(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (job_id, discovery_key),
  CHECK (jsonb_typeof(identity) = 'object'),
  CHECK (jsonb_typeof(identifiers) = 'array'),
  CHECK (discovered_from ~ '^https?://')
);

CREATE INDEX IF NOT EXISTS product_candidates_job_status_idx
  ON product_candidates(job_id, status);
CREATE INDEX IF NOT EXISTS product_candidates_identity_idx
  ON product_candidates(source_id, identity_key);
CREATE INDEX IF NOT EXISTS product_candidates_product_idx
  ON product_candidates(product_id) WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_candidate_observations (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES product_candidates(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  store_code TEXT,
  price NUMERIC(14,4),
  regular_price NUMERIC(14,4),
  currency CHAR(3),
  promotion TEXT,
  availability TEXT,
  price_scope TEXT NOT NULL DEFAULT 'unknown'
    CHECK (price_scope IN ('store','drive','national','unknown')),
  source_url TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, fingerprint),
  CHECK (price IS NULL OR price >= 0),
  CHECK (regular_price IS NULL OR regular_price >= 0),
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')
);

CREATE INDEX IF NOT EXISTS product_candidate_observations_candidate_idx
  ON product_candidate_observations(candidate_id);
-- Relie chaque observation de staging à l'observation de production créée.
-- NULL signifie qu'elle attend encore sa finalisation ; la reprise ne la perd pas.
ALTER TABLE product_candidate_observations
  ADD COLUMN IF NOT EXISTS product_observation_id BIGINT
  REFERENCES price_observations(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS product_candidate_observations_pending_idx
  ON product_candidate_observations(candidate_id)
  WHERE product_observation_id IS NULL;

CREATE TABLE IF NOT EXISTS product_candidate_observation_sources (
  id BIGSERIAL PRIMARY KEY,
  observation_id BIGINT NOT NULL REFERENCES product_candidate_observations(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  discovered_from TEXT NOT NULL,
  discovered_url TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL,
  jsonld_index INTEGER NOT NULL DEFAULT -1,
  selector_index INTEGER NOT NULL DEFAULT -1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (observation_id, method, discovered_from, discovered_url, evidence, jsonld_index, selector_index)
);

CREATE TABLE IF NOT EXISTS product_candidate_sources (
  id BIGSERIAL PRIMARY KEY,
  candidate_id BIGINT NOT NULL REFERENCES product_candidates(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  discovered_from TEXT NOT NULL,
  discovered_url TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (candidate_id, method, discovered_from, discovered_url, evidence)
);

-- ---------------------------------------------------------------------------
-- 3. Alias vérifiés : un alias ne peut désigner qu'un produit par source.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_identifiers (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  namespace TEXT NOT NULL
    CHECK (namespace IN ('gtin','merchant_ref','ref','sku','url')),
  source_id TEXT NOT NULL REFERENCES sources(id),
  value TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 2048),
  kind TEXT NOT NULL CHECK (kind IN ('primary','secondary')),
  evidence TEXT NOT NULL,
  verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (namespace, source_id, value),
  CHECK (namespace <> 'gtin' OR value ~ '^[0-9]{14}$')
);

CREATE INDEX IF NOT EXISTS product_identifiers_product_idx
  ON product_identifiers(product_id);

CREATE TABLE IF NOT EXISTS price_observation_sources (
  observation_id BIGINT NOT NULL REFERENCES price_observations(id) ON DELETE CASCADE,
  discovered_from TEXT NOT NULL,
  method TEXT NOT NULL,
  evidence TEXT NOT NULL,
  discovered_url TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (observation_id, discovered_from, method, evidence, discovered_url)
);

-- ---------------------------------------------------------------------------
-- 4. Anomalies d'identité.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_identity_anomalies (
  id BIGSERIAL PRIMARY KEY,
  job_id BIGINT REFERENCES scrape_jobs(id) ON DELETE SET NULL,
  source_id TEXT REFERENCES sources(id),
  candidate_id BIGINT,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS product_identity_anomalies_open_idx
  ON product_identity_anomalies(created_at DESC) WHERE reviewed_at IS NULL;

CREATE TABLE IF NOT EXISTS product_identity_anomaly_archive (
  id BIGINT PRIMARY KEY,
  job_id BIGINT,
  source_id TEXT,
  candidate_id BIGINT,
  kind TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  reviewed_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 5. Fonctions de support.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION identity_gtin_normalize(p_value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  v TEXT;
  padded TEXT;
  total INTEGER := 0;
  i INTEGER;
BEGIN
  v := regexp_replace(btrim(p_value), '[[:space:]-]', '', 'g');
  IF v !~ '^[0-9]+$' OR length(v) NOT IN (8, 12, 13, 14) THEN
    RETURN NULL;
  END IF;
  padded := lpad(v, 14, '0');
  FOR i IN 0..12 LOOP
    total := total + (substr(padded, 13 - i, 1)::int * CASE WHEN i % 2 = 0 THEN 3 ELSE 1 END);
  END LOOP;
  IF ((10 - (total % 10)) % 10) <> substr(padded, 14, 1)::int THEN
    RETURN NULL;
  END IF;
  RETURN padded;
END $$;

CREATE OR REPLACE FUNCTION identity_gtin_valid(p_value TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT identity_gtin_normalize(p_value) IS NOT NULL
$$;

-- Les alias GTIN sont toujours stockés sous leur forme canonique GTIN-14.
DO $$
DECLARE
  v_constraint TEXT;
BEGIN
  FOR v_constraint IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid='product_identifiers'::regclass
       AND contype='c'
       AND pg_get_constraintdef(oid) ILIKE '%gtin%'
       AND pg_get_constraintdef(oid) ILIKE '%14%'
  LOOP
    EXECUTE format('ALTER TABLE product_identifiers DROP CONSTRAINT %I', v_constraint);
  END LOOP;
END $$;
ALTER TABLE product_identifiers
  ADD CONSTRAINT product_identifiers_gtin_valid_check
  CHECK (namespace <> 'gtin' OR (value ~ '^[0-9]{14}$' AND identity_gtin_valid(value)));

CREATE OR REPLACE FUNCTION identity_guard_candidate_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('mapnifique.maintenance', TRUE) = 'on' THEN
    RETURN OLD;
  END IF;
  IF OLD.status = 'finalized' THEN
    RAISE EXCEPTION 'Suppression interdite du candidat finalisé %', OLD.id
      USING ERRCODE = 'MN003';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS product_candidates_guard_delete ON product_candidates;
CREATE TRIGGER product_candidates_guard_delete
  BEFORE DELETE ON product_candidates
  FOR EACH ROW EXECUTE FUNCTION identity_guard_candidate_delete();

CREATE OR REPLACE FUNCTION identity_purge_stale_candidates(
  p_retention_days INTEGER DEFAULT 7,
  p_anomaly_archive_days INTEGER DEFAULT 400
)
RETURNS TABLE (
  candidates_deleted BIGINT,
  observations_deleted BIGINT,
  observation_sources_deleted BIGINT,
  anomalies_archived BIGINT
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_candidates BIGINT := 0;
  v_observations BIGINT := 0;
  v_sources BIGINT := 0;
  v_archived BIGINT := 0;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 1
     OR p_anomaly_archive_days IS NULL OR p_anomaly_archive_days < 1 THEN
    RAISE EXCEPTION 'identity_purge_stale_candidates: retention invalide';
  END IF;

  -- Les anomalies revues sont archivées AVANT toute purge de candidat.
  INSERT INTO product_identity_anomaly_archive
    (id, job_id, source_id, candidate_id, kind, detail, created_at, reviewed_at)
  SELECT a.id, a.job_id, a.source_id, a.candidate_id, a.kind,
         CASE WHEN a.candidate_id IS NULL THEN a.detail
              ELSE a.detail || jsonb_build_object(
                'archiveCandidateSnapshot', (
                  SELECT jsonb_build_object(
                    'candidate', jsonb_build_object(
                      'id', c.id, 'sourceId', c.source_id, 'identityKey', c.identity_key,
                      'identifiers', c.identifiers, 'identity', c.identity, 'status', c.status,
                      'productId', c.product_id, 'name', c.name, 'brand', c.brand,
                      'productUrl', c.product_url, 'discoveredFrom', c.discovered_from
                    ),
                    'observations', COALESCE((
                      SELECT jsonb_agg(jsonb_build_object(
                        'id', o.id, 'fingerprint', o.fingerprint, 'storeCode', o.store_code,
                        'price', o.price, 'regularPrice', o.regular_price, 'currency', o.currency,
                        'promotion', o.promotion, 'availability', o.availability,
                        'priceScope', o.price_scope, 'sourceUrl', o.source_url,
                        'observedAt', o.observed_at,
                        'sources', COALESCE((
                          SELECT jsonb_agg(jsonb_build_object(
                            'method', os.method, 'discoveredFrom', os.discovered_from,
                            'discoveredUrl', os.discovered_url, 'evidence', os.evidence,
                            'jsonldIndex', os.jsonld_index, 'selectorIndex', os.selector_index
                          ) ORDER BY os.id)
                            FROM product_candidate_observation_sources os
                           WHERE os.observation_id=o.id
                        ), '[]'::jsonb)
                      ) ORDER BY o.id)
                        FROM product_candidate_observations o
                       WHERE o.candidate_id=c.id
                    ), '[]'::jsonb),
                    'discoverySources', COALESCE((
                      SELECT jsonb_agg(jsonb_build_object(
                        'method', cs.method, 'discoveredFrom', cs.discovered_from,
                        'discoveredUrl', cs.discovered_url, 'evidence', cs.evidence
                      ) ORDER BY cs.id)
                        FROM product_candidate_sources cs
                       WHERE cs.candidate_id=c.id
                    ), '[]'::jsonb)
                  )
                    FROM product_candidates c
                   WHERE c.id=a.candidate_id
                )
              ) END,
         a.created_at, a.reviewed_at
    FROM product_identity_anomalies a
   WHERE a.reviewed_at IS NOT NULL
     AND a.created_at < NOW() - make_interval(days => p_anomaly_archive_days)
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_archived = ROW_COUNT;

  DELETE FROM product_identity_anomalies a
   WHERE a.reviewed_at IS NOT NULL
     AND a.created_at < NOW() - make_interval(days => p_anomaly_archive_days)
     AND EXISTS (SELECT 1 FROM product_identity_anomaly_archive ar WHERE ar.id = a.id);

  -- Toute anomalie encore présente, revue ou non, bloque la purge du candidat.
  -- Les observations/provenances restent ainsi accessibles au diagnostic tant
  -- que l'anomalie n'a pas été revue ET archivée explicitement.
  SELECT COUNT(*) INTO v_observations
    FROM product_candidate_observations o
    JOIN product_candidates c ON c.id = o.candidate_id
    JOIN scrape_jobs j ON j.id = c.job_id
   WHERE j.status IN ('completed','failed')
     AND c.status <> 'blocked'
     AND c.block_reason IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM product_candidate_observations pending
        WHERE pending.candidate_id=c.id AND pending.product_observation_id IS NULL
     )
     AND j.finished_at IS NOT NULL
     AND j.finished_at < NOW() - make_interval(days => p_retention_days)
     AND NOT EXISTS (
       SELECT 1 FROM product_identity_anomalies a
        WHERE a.candidate_id = c.id OR a.detail->'candidateIds' @> jsonb_build_array(c.id)
     );

  SELECT COUNT(*) INTO v_sources
    FROM product_candidate_observation_sources s
    JOIN product_candidate_observations o ON o.id = s.observation_id
    JOIN product_candidates c ON c.id = o.candidate_id
    JOIN scrape_jobs j ON j.id = c.job_id
   WHERE j.status IN ('completed','failed')
     AND c.status <> 'blocked'
     AND c.block_reason IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM product_candidate_observations pending
        WHERE pending.candidate_id=c.id AND pending.product_observation_id IS NULL
     )
     AND j.finished_at IS NOT NULL
     AND j.finished_at < NOW() - make_interval(days => p_retention_days)
     AND NOT EXISTS (
       SELECT 1 FROM product_identity_anomalies a
        WHERE a.candidate_id = c.id OR a.detail->'candidateIds' @> jsonb_build_array(c.id)
     );

  PERFORM set_config('mapnifique.maintenance', 'on', TRUE);
  DELETE FROM product_candidates c
   USING scrape_jobs j
   WHERE c.job_id = j.id
     AND j.status IN ('completed','failed')
     AND c.status <> 'blocked'
     AND c.block_reason IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM product_candidate_observations pending
        WHERE pending.candidate_id=c.id AND pending.product_observation_id IS NULL
     )
     AND j.finished_at IS NOT NULL
     AND j.finished_at < NOW() - make_interval(days => p_retention_days)
     AND NOT EXISTS (
       SELECT 1 FROM product_identity_anomalies a
        WHERE a.candidate_id = c.id OR a.detail->'candidateIds' @> jsonb_build_array(c.id)
     );
  GET DIAGNOSTICS v_candidates = ROW_COUNT;
  PERFORM set_config('mapnifique.maintenance', 'off', TRUE);

  candidates_deleted := v_candidates;
  observations_deleted := v_observations;
  observation_sources_deleted := v_sources;
  anomalies_archived := v_archived;
  RETURN NEXT;
END $$;

DROP FUNCTION IF EXISTS identity_schema_problems();
CREATE FUNCTION identity_schema_problems()
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_version INTEGER;
  v_table TEXT;
  v_column RECORD;
BEGIN
  IF to_regclass('schema_state') IS NULL THEN
    RETURN NEXT 'table absente : schema_state';
    RETURN;
  END IF;
  SELECT version INTO v_version FROM schema_state WHERE singleton;
  IF v_version IS NULL THEN
    RETURN NEXT 'schema_state absent';
    RETURN;
  END IF;
  IF v_version < 1 THEN
    RETURN NEXT format('version de schéma %s : migration 001 non appliquée', v_version);
  END IF;

  FOREACH v_table IN ARRAY ARRAY[
    'product_candidates',
    'product_candidate_observations',
    'product_candidate_observation_sources',
    'product_candidate_sources',
    'product_identifiers',
    'price_observation_sources',
    'product_identity_anomalies',
    'product_identity_anomaly_archive'
  ] LOOP
    IF to_regclass(v_table) IS NULL THEN
      RETURN NEXT format('table absente : %s', v_table);
      -- Les contrôles de colonnes suivants utilisent ::regclass ; ne pas
      -- tenter de résoudre une table absente.
      RETURN;
    END IF;
  END LOOP;

  FOR v_column IN
    SELECT * FROM (VALUES
      ('products','discovered_from'),
      ('products','identity_key'),
      ('products','identity'),
      ('price_observations','currency'),
      ('product_candidate_observations','product_observation_id')
    ) AS expected(table_name, column_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_attribute
       WHERE attrelid = v_column.table_name::regclass
         AND attname = v_column.column_name
         AND NOT attisdropped
    ) THEN
      RETURN NEXT format('colonne absente : %s.%s', v_column.table_name, v_column.column_name);
    END IF;
  END LOOP;

  IF to_regclass('products_source_product_url_uidx') IS NULL THEN
    RETURN NEXT 'index absent : products_source_product_url_uidx';
  END IF;
  IF to_regprocedure('identity_purge_stale_candidates(integer,integer)') IS NULL THEN
    RETURN NEXT 'fonction absente : identity_purge_stale_candidates';
  END IF;
  IF to_regprocedure('identity_gtin_valid(text)') IS NULL THEN
    RETURN NEXT 'fonction absente : identity_gtin_valid';
  END IF;
  IF to_regprocedure('identity_gtin_normalize(text)') IS NULL THEN
    RETURN NEXT 'fonction absente : identity_gtin_normalize';
  END IF;
END $$;

DROP FUNCTION IF EXISTS identity_data_problems();
CREATE FUNCTION identity_data_problems()
RETURNS SETOF TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v RECORD;
BEGIN
  FOR v IN
    SELECT id FROM products WHERE identity_key IS NULL ORDER BY id LIMIT 200
  LOOP
    RETURN NEXT format('produit %s sans identity_key', v.id);
  END LOOP;

  FOR v IN
    SELECT id, gtin FROM products
     WHERE gtin IS NOT NULL AND (gtin !~ '^[0-9]{14}$' OR NOT identity_gtin_valid(gtin))
     ORDER BY id LIMIT 200
  LOOP
    RETURN NEXT format('produit %s avec GTIN non canonique : %s', v.id, v.gtin);
  END LOOP;

  FOR v IN
    SELECT id FROM product_candidates
     WHERE status = 'finalized' AND product_id IS NULL
     ORDER BY id LIMIT 200
  LOOP
    RETURN NEXT format('candidat finalisé %s sans produit', v.id);
  END LOOP;

  FOR v IN
    SELECT o.id FROM product_candidate_observations o
     WHERE NOT EXISTS (
       SELECT 1 FROM product_candidate_observation_sources s WHERE s.observation_id = o.id
     )
     ORDER BY o.id LIMIT 200
  LOOP
    RETURN NEXT format('observation de staging %s sans provenance', v.id);
  END LOOP;

  FOR v IN
    SELECT c.id FROM product_candidates c
     WHERE c.status = 'blocked'
       AND NOT EXISTS (
         SELECT 1 FROM product_identity_anomalies a
          WHERE a.candidate_id = c.id OR a.detail->'candidateIds' @> jsonb_build_array(c.id)
       )
     ORDER BY c.id LIMIT 200
  LOOP
    RETURN NEXT format('candidat bloqué %s sans anomalie', v.id);
  END LOOP;

  FOR v IN
    SELECT j.id, COUNT(*) AS pending
      FROM scrape_jobs j
      JOIN product_candidates c ON c.job_id = j.id
     WHERE j.status = 'completed' AND c.status <> 'finalized'
     GROUP BY j.id
  LOOP
    RETURN NEXT format('job %s terminé avec %s candidats non finalisés', v.id, v.pending);
  END LOOP;

  FOR v IN
    SELECT c.id, COUNT(*) AS pending
      FROM product_candidates c
      JOIN scrape_jobs j ON j.id=c.job_id
      JOIN product_candidate_observations o ON o.candidate_id=c.id
     WHERE j.status='completed' AND o.product_observation_id IS NULL
     GROUP BY c.id
     ORDER BY c.id LIMIT 200
  LOOP
    RETURN NEXT format('candidat %s finalisé avec %s observations de staging non consommées', v.id, v.pending);
  END LOOP;

  FOR v IN
    SELECT a.id FROM product_identity_anomalies a
     WHERE a.reviewed_at IS NULL AND a.created_at < NOW() - INTERVAL '400 days'
     ORDER BY a.id LIMIT 50
  LOOP
    RETURN NEXT format('anomalie non revue ancienne : %s', v.id);
  END LOOP;

  FOR v IN
    SELECT source_id, identity_key, array_agg(id ORDER BY id) AS ids
      FROM products
     WHERE identity_key LIKE 'f:%'
     GROUP BY source_id, identity_key
    HAVING COUNT(*) > 1
     ORDER BY source_id, identity_key LIMIT 100
  LOOP
    RETURN NEXT format('collision identité de secours source=%s clé=%s produits=%s', v.source_id, v.identity_key, v.ids);
  END LOOP;

  FOR v IN
    SELECT pi.id FROM product_identifiers pi
     WHERE pi.namespace='gtin'
       AND (pi.value !~ '^[0-9]{14}$' OR NOT identity_gtin_valid(pi.value))
     ORDER BY pi.id LIMIT 100
  LOOP
    RETURN NEXT format('alias GTIN invalide : %s', v.id);
  END LOOP;
END $$;

UPDATE schema_state SET version = 1, updated_at = NOW() WHERE singleton;

COMMIT;
