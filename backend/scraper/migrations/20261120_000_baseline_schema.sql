-- Version 0 : schéma historique MapNifique, recréé à l'identique et sans perte.
-- Cette migration ne crée aucune table d'identité et ne marque jamais la base prête.
-- À appliquer une seule fois sur une base neuve ; sur une base existante, elle est
-- idempotente et se contente d'enregistrer la version 0.
BEGIN;

CREATE TABLE IF NOT EXISTS schema_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version INTEGER NOT NULL CHECK (version >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO schema_state (singleton, version)
VALUES (TRUE, 0)
ON CONFLICT (singleton) DO NOTHING;

DO $$
DECLARE
  current_version INTEGER;
BEGIN
  SELECT version INTO current_version FROM schema_state WHERE singleton;
  IF current_version > 0 THEN
    RAISE EXCEPTION
      'Baseline migration refused: schema version is already % (expected 0)',
      current_version;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  product_url_regex TEXT,
  selectors JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  requests_per_minute INTEGER NOT NULL DEFAULT 12 CHECK (requests_per_minute BETWEEN 1 AND 120),
  same_domain_delay_secs NUMERIC(6,2) NOT NULL DEFAULT 2 CHECK (same_domain_delay_secs >= 1),
  max_pages_per_run INTEGER NOT NULL DEFAULT 100 CHECK (max_pages_per_run BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE sources ALTER COLUMN enabled SET DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS scrape_jobs (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  start_urls JSONB NOT NULL,
  max_pages INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  pages_seen INTEGER NOT NULL DEFAULT 0,
  products_found INTEGER NOT NULL DEFAULT 0,
  skipped_by_robots INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  lease_token TEXT,
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scrape_jobs_queue_idx ON scrape_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS scrape_jobs_lease_idx ON scrape_jobs(status, heartbeat_at);

CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  product_url TEXT NOT NULL,
  gtin TEXT,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT,
  image_url TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (source_id, product_url)
);

CREATE INDEX IF NOT EXISTS products_name_idx ON products USING GIN (to_tsvector('simple', name));
CREATE INDEX IF NOT EXISTS products_source_idx ON products(source_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS products_gtin_idx ON products(gtin) WHERE gtin IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_observations (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  store_code TEXT,
  price NUMERIC(14,4),
  regular_price NUMERIC(14,4),
  currency CHAR(3) NOT NULL DEFAULT 'EUR',
  promotion TEXT,
  availability TEXT,
  price_scope TEXT NOT NULL DEFAULT 'unknown' CHECK (price_scope IN ('store','drive','national','unknown')),
  source_url TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (product_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS price_product_date_idx ON price_observations(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS price_date_idx ON price_observations(observed_at DESC);
CREATE INDEX IF NOT EXISTS price_store_date_idx ON price_observations(store_code, observed_at DESC) WHERE store_code IS NOT NULL;

-- Le schéma baseline est complet, mais la version reste 0 : l'API et le worker
-- doivent refuser de démarrer tant que 001 et la réconciliation n'ont pas abouti.
COMMIT;
