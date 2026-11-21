#!/usr/bin/env bash
# Restauration d'un dump pg_dump texte. En production locale, confirmation
# interactive obligatoire. Le mode de test n'accepte que le conteneur et la
# base éphémères nommés Prompt26.
set -euo pipefail
cd "$(dirname "$0")/.."

file="${1:-}"
if [[ -z "$file" || ! -f "$file" ]]; then
  echo "Usage : scripts/restore.sh backups/mapnifique-scraper-AAAAMMJJ-HHMMSS.sql" >&2
  exit 64
fi

if [[ -n "${MAPNIFIQUE_TEST_CONTAINER:-}" ]]; then
  case "$MAPNIFIQUE_TEST_CONTAINER" in
    mapnifique-pg-prompt26-test-*) ;;
    *) echo "REFUS: conteneur de test hors périmètre Prompt26." >&2; exit 64 ;;
  esac
  user="${MAPNIFIQUE_TEST_USER:?MAPNIFIQUE_TEST_USER requis en mode test}"
  database="${MAPNIFIQUE_TEST_DB:?MAPNIFIQUE_TEST_DB requis en mode test}"
  password="${MAPNIFIQUE_TEST_PASSWORD:?MAPNIFIQUE_TEST_PASSWORD requis en mode test}"
  [[ "$database" == mapnifique_prompt26_* ]] || { echo "REFUS: base hors périmètre Prompt26." >&2; exit 64; }
  [[ "${MAPNIFIQUE_RESTORE_CONFIRM:-}" == "RESTORER" ]] || {
    echo "REFUS: MAPNIFIQUE_RESTORE_CONFIRM=RESTORER requis en mode test." >&2
    exit 64
  }
  pg_exec() { docker exec -i -e "PGPASSWORD=$password" "$MAPNIFIQUE_TEST_CONTAINER" "$@"; }
else
  [[ -f .env ]] || { echo "Fichier .env absent. Lance d'abord scripts/start.sh."; exit 1; }
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
  user="${POSTGRES_USER:-mapnifique}"
  database="${POSTGRES_DB:-mapnifique_scraper}"
  pg_exec() { docker compose exec -T db "$@"; }
  echo "Cette opération ÉCRASE la base ${database} du conteneur db."
  echo "Le dump restaure les données telles qu'elles étaient : les migrations appliquées"
  echo "après sa création ne sont PAS rejouées automatiquement."
  read -r -p "Tape RESTAURER pour confirmer : " answer
  [[ "$answer" == "RESTAURER" ]] || { echo "Restauration annulée."; exit 1; }
fi

pg_exec psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" < "$file"

version_exists="$(pg_exec psql -X -At -U "$user" -d "$database" \
  -c "SELECT to_regclass('public.schema_state') IS NOT NULL")"
if [[ "$version_exists" == "t" ]]; then
  echo "--- Version de schéma restaurée"
  pg_exec psql -v ON_ERROR_STOP=1 -U "$user" -d "$database" \
    -c "SELECT version, updated_at FROM schema_state WHERE singleton;"
else
  echo "--- Version de schéma restaurée : legacy/unknown (schema_state absent)"
fi

echo "Restauration terminée. Si la version est inférieure à 2, applique les migrations"
echo "manquantes puis relance scripts/reconcile-product-identity.js --audit."
