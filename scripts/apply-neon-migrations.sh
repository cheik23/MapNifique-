#!/usr/bin/env bash

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

: "${DATABASE_URL:?DATABASE_URL requis (connexion Neon directe)}"

command -v docker >/dev/null 2>&1 || { echo 'Docker requis pour utiliser psql 17 dans le conteneur officiel.' >&2; exit 2; }

command -v node >/dev/null 2>&1 || { echo 'Node.js requis.' >&2; exit 2; }

# Refuser toute relation du schéma public : la base doit réellement être vide avant le premier déploiement.
# Vérifie pg_class JOIN pg_namespace sur n.nspname='public' et c.relkind IN ('r','p','v','m','S','f').

EXISTING="$(docker run --rm -e DATABASE_URL="$DATABASE_URL" postgres:17-alpine \
psql "$DATABASE_URL" -XAtqc "
SELECT COUNT(*)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relkind IN ('r','p','v','m','S','f')
")"

[[ "$EXISTING" == '0' ]] || { echo 'Refus : des relations existent déjà dans le schéma public. La base doit être réellement vide.' >&2; exit 3; }

MIGRATIONS="$ROOT/backend/scraper/migrations"

docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$MIGRATIONS:/migrations:ro" \
postgres:17-alpine sh -ec '

for file in \
/migrations/20261120_000_baseline_schema.sql \
/migrations/20261120_001_product_identity.sql \
/migrations/20261120_002_places_offers.sql \
/migrations/20261120_003_identity_reconcile_preflight.sql; do
	echo "--- $file ---"
	psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$file"
done
'

npm --prefix "$ROOT/backend/scraper" ci

export DATABASE_URL
node "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --audit
node "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --execute
node "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --audit

VERSION="$(docker run --rm -e DATABASE_URL="$DATABASE_URL" postgres:17-alpine \
psql "$DATABASE_URL" -XAtqc 'SELECT version FROM schema_state LIMIT 1')"

[[ "$VERSION" == '2' ]] || { echo "Schéma attendu v2, trouvé $VERSION" >&2; exit 4; }

echo 'NEON_MIGRATIONS=PASS schema_version=2'
