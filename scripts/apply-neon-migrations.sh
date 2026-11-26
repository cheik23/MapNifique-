#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DATABASE_URL:?DATABASE_URL requis (connexion Neon directe)}"
command -v docker >/dev/null 2>&1 || { echo 'Docker requis pour utiliser psql 17 dans le conteneur officiel.' >&2; exit 2; }
command -v ode >/dev/null 2>&1 || { echo 'Node.js requis.' >&2; exit 2; }

# Refuse toute base dont le schéma public contient déjà une relation : ce script
# ne sert qu'au premier déploiement sur une base réellement vide.
EXISTING="$(docker run --rm -e DATABASE_URL="$DATABASE_URL" postgres:17-alpine \
 psql "$DATABASE_URL" -XAtqc "SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) THEN 1 ELSE 0 END")"
[[ "$EXISTING" == '0' ]] || { echo 'Refus : le schéma public contient déjà au moins une relation (table, partition, vue, séquence ou table étrangère). Utilise une base réellement vide ou une procédure de migration contrôlée.' >&2; exit 3; }

MIGRATIONS="$ROOT/backend/scraper/migrations"
docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$MIGRATIONS:/migrations:ro" 
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

 pm --prefix "$ROOT/backend/scraper" ci
export DATABASE_URL
 ode "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --audit
 ode "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --execute
 ode "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --audit
VERSION="$(docker run --rm -e DATABASE_URL="$DATABASE_URL" postgres:17-alpine \
 psql "$DATABASE_URL" -XAtqc 'SELECT version FROM schema_state LIMIT 1')"
[[ "$VERSION" == '2' ]] || { echo "Schéma attendu v2, trouvé $VERSION" >&2; exit 4; }
echo 'NEON_MIGRATIONS=PASS schema_version=2'
