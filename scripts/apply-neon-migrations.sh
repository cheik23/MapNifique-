#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${DATABASE_URL:?DATABASE_URL requis (connexion Neon directe)}"
command -v docker >/dev/null 2>&1 || { echo 'Docker requis pour utiliser psql 17 dans le conteneur officiel.' >&2; exit 2; }
command -v node >/dev/null 2>&1 || { echo 'Node.js requis.' >&2; exit 2; }

# Refuse toute base dont le schéma public contient déjà une relation
# utilisateur : ce script ne sert qu'au premier déploiement sur une base
# réellement vide. Les objets appartenant à une extension PostgreSQL
# (relkind, dépendance pg_depend de type 'e') ne bloquent pas une
# initialisation légitime, car ils ne sont pas des données MapNifique.
EXISTING="$(docker run --rm -e DATABASE_URL="$DATABASE_URL" postgres:17-alpine \
  psql "$DATABASE_URL" -XAtqc "SELECT CASE WHEN EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_depend d
      ON d.classid = 'pg_class'::regclass
     AND d.objid = c.oid
     AND d.refclassid = 'pg_extension'::regclass
     AND d.deptype = 'e'
    LEFT JOIN pg_extension e ON e.oid = d.refobjid
    WHERE n.nspname='public'
      AND c.relkind IN ('r','p','v','m','S','f')
      AND e.oid IS NULL
  ) THEN 1 ELSE 0 END")"
if [[ "$EXISTING" != '0' ]]; then
  echo 'Refus : le schéma public contient déjà au moins une relation (table, partition, vue, séquence ou table étrangère). Utilise une base réellement vide ou une procédure de migration contrôlée.' >&2
  exit 3
fi

MIGRATIONS="$ROOT/backend/scraper/migrations"
MIGRATE_RUN="$ROOT/scripts/migrations-run.sh"
[[ -f "$MIGRATE_RUN" ]] || { echo 'Fichier de migrations introuvable.' >&2; exit 2; }
docker run --rm -e DATABASE_URL="$DATABASE_URL" -v "$MIGRATIONS:/migrations:ro" -v "$MIGRATE_RUN:/migrate.sh:ro" \
  postgres:17-alpine sh /migrate.sh

npm --prefix "$ROOT/backend/scraper" ci
export DATABASE_URL
node "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --audit
node "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --execute
node "$ROOT/backend/scraper/scripts/reconcile-product-identity.js" --audit
VERSION="$(docker run --rm -e DATABASE_URL="$DATABASE_URL" postgres:17-alpine \
  psql "$DATABASE_URL" -XAtqc 'SELECT version FROM schema_state LIMIT 1')"
if [[ "$VERSION" != '2' ]]; then
  echo "Schéma attendu v2, trouvé $VERSION" >&2
  exit 4
fi
echo 'NEON_MIGRATIONS=PASS schema_version=2'
