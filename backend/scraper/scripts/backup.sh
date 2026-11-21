#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

# Prompt26 test mode is intentionally restricted to the disposable runner's
# container/database names. It bypasses .env and docker compose completely.
if [[ -n "${MAPNIFIQUE_TEST_CONTAINER:-}" ]]; then
  case "$MAPNIFIQUE_TEST_CONTAINER" in
    mapnifique-pg-prompt26-test-*) ;;
    *) echo "REFUS: conteneur de test hors périmètre Prompt26." >&2; exit 64 ;;
  esac
  user="${MAPNIFIQUE_TEST_USER:?MAPNIFIQUE_TEST_USER requis en mode test}"
  database="${MAPNIFIQUE_TEST_DB:?MAPNIFIQUE_TEST_DB requis en mode test}"
  password="${MAPNIFIQUE_TEST_PASSWORD:?MAPNIFIQUE_TEST_PASSWORD requis en mode test}"
  [[ "$database" == mapnifique_prompt26_* ]] || { echo "REFUS: base hors périmètre Prompt26." >&2; exit 64; }
  pg_exec() { docker exec -i -e "PGPASSWORD=$password" "$MAPNIFIQUE_TEST_CONTAINER" "$@"; }
else
  set -a
  # shellcheck disable=SC1091
  if [[ -f .env ]]; then . ./.env; fi
  set +a
  user="${POSTGRES_USER:-mapnifique}"
  database="${POSTGRES_DB:-mapnifique_scraper}"
  pg_exec() { docker compose exec -T db "$@"; }
fi

backup_dir="${MAPNIFIQUE_BACKUP_DIR:-backups}"
mkdir -p "$backup_dir"
stamp="$(date +%Y%m%d-%H%M%S)-$$"
file="$backup_dir/mapnifique-scraper-$stamp.sql"
tmp_file="$file.tmp.$$"
version_file="$backup_dir/mapnifique-scraper-$stamp.version"
version_tmp="$version_file.tmp.$$"
trap 'rm -f "$tmp_file" "$version_tmp"' EXIT

# L'absence de schema_state dans un ancien schéma ne doit pas empêcher le dump.
version="$(pg_exec psql -At -U "$user" -d "$database" \
  -c "SELECT version FROM schema_state WHERE singleton" 2>/dev/null | tr -d '\r')" || version="legacy/unknown"
[[ -n "$version" ]] || version="legacy/unknown"
printf '%s\n' "$version" > "$version_tmp"
chmod 600 "$version_tmp"

rm -f "$tmp_file"
if ! pg_exec pg_dump -U "$user" "$database" > "$tmp_file"; then
  rm -f "$tmp_file" "$version_tmp" "$version_file"
  echo "ÉCHEC : pg_dump n'a pas produit de sauvegarde valide." >&2
  exit 1
fi
if [[ ! -s "$tmp_file" ]]; then
  rm -f "$tmp_file" "$version_tmp" "$version_file"
  echo "ÉCHEC : pg_dump a produit un fichier vide." >&2
  exit 1
fi
chmod 600 "$tmp_file" "$version_tmp"
mv "$tmp_file" "$file"
mv "$version_tmp" "$version_file"
chmod 600 "$file" "$version_file"
echo "Sauvegarde créée : $file (version de schéma $version)"
echo "Restauration : scripts/restore.sh $file"
