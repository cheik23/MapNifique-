#!/usr/bin/env bash
set -Eeuo pipefail
: "${BACKUP_FILE:?BACKUP_FILE doit être un fichier .dump.age déjà téléchargé}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE doit pointer vers la clé privée age locale}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL doit viser une base VIDE de test/restauration}"
for cmd in age docker; do command -v "$cmd" >/dev/null 2>&1 || { echo "$cmd requis" >&2; exit 2; }; done
[[ -f "$BACKUP_FILE" && "$BACKUP_FILE" == *.dump.age ]] || { echo 'Fichier de sauvegarde chiffré invalide.' >&2; exit 2; }
TMP_DIR="$(mktemp -d)"; trap 'rm -rf "$TMP_DIR"' EXIT
DUMP="$TMP_DIR/restore.dump"
age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$DUMP" "$BACKUP_FILE"
cat > "$TMP_DIR/check-empty.sql" <<'SQL'
SELECT count(*) = 0
FROM pg_class c
JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S','f');
SQL
EMPTY="$(docker run --rm -e RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" -v "$TMP_DIR:/backup:ro" \
  postgres:17-alpine psql "$RESTORE_DATABASE_URL" -XAtq -f /backup/check-empty.sql)"
[[ "$EMPTY" == 't' ]] || { echo 'Refus : la base cible n’est pas vide. Aucune donnée écrasée.' >&2; exit 3; }
docker run --rm -e RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" -v "$TMP_DIR:/backup:ro" \
  postgres:17-alpine pg_restore --exit-on-error --no-owner --no-acl \
  --dbname="$RESTORE_DATABASE_URL" /backup/restore.dump
VERSION="$(docker run --rm -e RESTORE_DATABASE_URL="$RESTORE_DATABASE_URL" postgres:17-alpine \
  psql "$RESTORE_DATABASE_URL" -XAtqc 'SELECT version FROM schema_state LIMIT 1')"
[[ "$VERSION" == '2' ]] || { echo "Schéma attendu v2, trouvé $VERSION" >&2; exit 4; }
echo 'RESTORE_SCHEMA_VERSION=2'
echo 'RESTORE_NEON_BACKUP=PASS'
