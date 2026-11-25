#!/usr/bin/env bash
# Prompt 26: PostgreSQL disposable integration test. No project compose, no volumes.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_DIR="${PROMPT26_LOG_DIR:-backups/prompt26-postgres-validation-$STAMP}"
mkdir -p "$LOG_DIR"
exec > >(tee -a "$LOG_DIR/run.log") 2>&1

IMAGE="${PROMPT26_POSTGRES_IMAGE:-docker.io/library/postgres:17-alpine}"
NAME="mapnifique-pg-prompt26-test-${STAMP}-$$"
DB_USER="mapnifique_prompt26"
DB_PASSWORD="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
CONTAINER_STARTED=0
NODE_RECONCILE="BLOCKED"
SQL_STATUS="NOT_RUN"

fail() { echo "ERROR: $*" >&2; exit 1; }

cleanup() {
  local rc=$?
  if [[ "$CONTAINER_STARTED" == 1 ]] && docker inspect "$NAME" >/dev/null 2>&1; then
    docker logs "$NAME" > "$LOG_DIR/postgres-container.log" 2>&1 || echo "WARN: récupération des logs Docker impossible." >&2
    docker rm -f "$NAME" >/dev/null 2>&1 || echo "WARN: impossible d'arrêter le conteneur dédié $NAME." >&2
  fi
  if docker inspect "$NAME" >/dev/null 2>&1; then
    echo "ERROR: le conteneur Prompt26 existe encore : $NAME" >&2
    rc=1
  else
    echo "CONTAINER_REMOVED=$NAME"
  fi
  echo "LOG_DIR=$LOG_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ "$IMAGE" == docker.io/library/postgres:* ]] || fail "Image refusée : seule docker.io/library/postgres:<tag> est autorisée."
command -v docker >/dev/null 2>&1 || fail "docker CLI absent dans cet environnement."
docker info >/dev/null 2>&1 || fail "Docker Engine inaccessible."
NODE_AVAILABLE=0
if command -v node >/dev/null 2>&1; then NODE_AVAILABLE=1; fi

for file in \
  migrations/20261120_000_baseline_schema.sql \
  migrations/20261120_001_product_identity.sql \
  migrations/20261120_002_places_offers.sql \
  migrations/20261120_003_identity_reconcile_preflight.sql \
  migrations/validate-product-identity.psql \
  migrations/validate-places-offers.psql \
  migrations/validate-identity-reconcile-preflight.psql \
  migrations/fixtures/legacy_places_offers_prompt26.sql \
  scripts/backup.sh \
  scripts/restore.sh; do
  [[ -f "$file" ]] || fail "Fichier requis absent : $file"
done

# N'effectue aucune installation de dépendance et n'utilise aucun .env.
PG_IMPORT=0
if [[ "$NODE_AVAILABLE" == 1 ]] && node --input-type=module -e "await import('pg')" >/dev/null 2>&1; then PG_IMPORT=1; fi

printf 'IMAGE=%s\n' "$IMAGE"
printf 'CONTAINER=%s\n' "$NAME"
if [[ "$NODE_AVAILABLE" == 1 ]]; then
  printf 'NODE_VERSION=%s\n' "$(node --version)"
else
  echo 'NODE_VERSION=not-installed-in-this-shell'
fi
printf 'PG_NODE_DRIVER=%s\n' "$([[ "$PG_IMPORT" == 1 ]] && echo available || echo missing)"
printf 'DATABASES=mapnifique_prompt26_fresh,mapnifique_prompt26_legacy_upgrade,mapnifique_prompt26_identity_clean,mapnifique_prompt26_identity_conflict,mapnifique_prompt26_backup_legacy,mapnifique_prompt26_restore_legacy,mapnifique_prompt26_restore_versioned\n'

# No volume, no bind mount, loopback-only dynamically assigned host port.
docker run --rm -d --name "$NAME" \
  --tmpfs /var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=512m \
  -e POSTGRES_USER="$DB_USER" \
  -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null
CONTAINER_STARTED=1

# Docker Engine versions expose tmpfs differently in `docker inspect`.
# In this environment `.Mounts` is a typed MountPoint array and can be empty
# even though `HostConfig.Tmpfs` contains the requested tmpfs. Therefore we
# validate BOTH the requested config and the live mount namespace. A real
# bind/volume mount is rejected; an empty .Mounts array is accepted only when
# /proc/self/mountinfo proves PGDATA is actually tmpfs with hardened options.
MOUNTS_KIND="$(docker inspect --format '{{printf "%T" .Mounts}}' "$NAME")"
MOUNT_COUNT="$(docker inspect --format '{{len .Mounts}}' "$NAME")"
MOUNT_SPEC="$(docker inspect --format '{{range .Mounts}}{{printf "%s|%s|%s\n" .Type .Destination .Name}}{{end}}' "$NAME")"
TMPFS_COUNT="$(docker inspect --format '{{len .HostConfig.Tmpfs}}' "$NAME")"
TMPFS_DESTS="$(docker inspect --format '{{range $destination, $options := .HostConfig.Tmpfs}}{{printf "%s\n" $destination}}{{end}}' "$NAME")"
TMPFS_OPTIONS="$(docker inspect --format '{{index .HostConfig.Tmpfs "/var/lib/postgresql/data"}}' "$NAME")"
HOST_BIND_COUNT="$(docker inspect --format '{{len .HostConfig.Binds}}' "$NAME")"
HOST_MOUNTS_COUNT="$(docker inspect --format '{{len .HostConfig.Mounts}}' "$NAME")"
VOLUMES_FROM_COUNT="$(docker inspect --format '{{len .HostConfig.VolumesFrom}}' "$NAME")"

[[ "$TMPFS_COUNT" == "1" && "$TMPFS_DESTS" == "/var/lib/postgresql/data" ]] || fail \
  "HostConfig.Tmpfs doit contenir uniquement PGDATA (tmpfs=$(docker inspect --format '{{json .HostConfig.Tmpfs}}' "$NAME"))."
[[ "$HOST_BIND_COUNT" == "0" && "$HOST_MOUNTS_COUNT" == "0" && "$VOLUMES_FROM_COUNT" == "0" ]] || fail \
  "Configuration de montage persistante interdite (Binds=$HOST_BIND_COUNT, Mounts=$HOST_MOUNTS_COUNT, VolumesFrom=$VOLUMES_FROM_COUNT)."

# If Docker reports effective mounts, the only one allowed is this tmpfs.
# Some Engine/API combinations report --tmpfs in HostConfig.Tmpfs + the live
# mount namespace but leave .Mounts empty; handle that documented variation.
if [[ "$MOUNT_COUNT" == "0" ]]; then
  echo "DOCKER_MOUNTS=empty-array; effective tmpfs will be verified in mountinfo"
elif [[ "$MOUNT_COUNT" == "1" && "$MOUNT_SPEC" == "tmpfs|/var/lib/postgresql/data|" ]]; then
  echo "DOCKER_MOUNTS=single-tmpfs-record"
else
  fail "Mounts effectifs inattendus (type=$MOUNTS_KIND, count=$MOUNT_COUNT, entries=${MOUNT_SPEC:-<empty>})."
fi

# Verify the effective mount from inside the running container. This catches
# the dangerous case where HostConfig records --tmpfs but PGDATA is not mounted.
MOUNTINFO_AWK="$(cat <<'AWK'
awk -v target="/var/lib/postgresql/data" '
$5 == target {
  for (i = 1; i <= NF; i++) {
    if ($i == "-" && $(i + 1) == "tmpfs") { found = 1; options = $6 }
  }
}
END {
  if (!found) exit 1
  split(options, parts, ",")
  for (i in parts) seen[parts[i]] = 1
  if (!seen["rw"] || !seen["nosuid"] || !seen["nodev"] || !seen["noexec"]) exit 2
}' /proc/self/mountinfo
AWK
)"
if ! docker exec "$NAME" sh -ec "$MOUNTINFO_AWK"; then
  fail "PGDATA n'est pas confirmé comme tmpfs actif avec rw,nosuid,nodev,noexec dans /proc/self/mountinfo."
fi

# Ensure the requested size and hardening flags are recorded by Docker.
for required_option in rw nosuid nodev noexec size=512m; do
  case ",${TMPFS_OPTIONS}," in
    *",${required_option},"*) ;;
    *) fail "Option tmpfs requise absente (${required_option}); options observées: ${TMPFS_OPTIONS}" ;;
  esac
done
printf 'STORAGE_ISOLATION=verified\n'
printf 'DOCKER_MOUNTS_KIND=%s\nDOCKER_MOUNTS_COUNT=%s\n' "$MOUNTS_KIND" "$MOUNT_COUNT"
printf 'HOSTCONFIG_TMPFS=%s\n' "$TMPFS_OPTIONS"
IMAGE_ID="$(docker inspect --format '{{.Image}}' "$NAME")"
IMAGE_DIGEST="$(docker image inspect --format '{{join .RepoDigests ","}}' "$IMAGE" 2>/dev/null || true)"
PORT="$(docker port "$NAME" 5432/tcp | awk -F: 'NR==1 {print $NF}')"
[[ "$PORT" =~ ^[0-9]+$ ]] || fail "Port dynamique PostgreSQL introuvable."
printf 'IMAGE_ID=%s\nIMAGE_DIGEST=%s\nHOST_BIND=127.0.0.1:%s\nMOUNTS=%s\n' \
  "$IMAGE_ID" "${IMAGE_DIGEST:-not-reported-by-local-image-metadata}" "$PORT" "tmpfs-only"

ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U "$DB_USER" -d postgres >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[[ "$ready" == 1 ]] || fail "PostgreSQL temporaire non prêt après 60 secondes."

psql_db() {
  local db="$1"; shift
  docker exec -i -e PGPASSWORD="$DB_PASSWORD" "$NAME" \
    psql -X -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$db" "$@"
}
psql_file() {
  local db="$1" file="$2" label="$3"
  local safe_label
  safe_label="$(printf '%s' "$label" | tr -cs '[:alnum:]_-' '_')"
  echo "--- $label ($db) ---"
  psql_db "$db" < "$file" | tee "$LOG_DIR/${db}-${safe_label}.log"
}
create_db() {
  local db="$1"
  psql_db postgres -c "CREATE DATABASE \"$db\"" >/dev/null
  echo "DATABASE_CREATED=$db"
}
assert_schema_version() {
  local db="$1" expected="$2" label="$3" actual
  actual="$(psql_db "$db" -Atc 'SELECT version FROM schema_state WHERE singleton')"
  [[ "$actual" == "$expected" ]] || fail "$db après $label : version attendue $expected, reçue $actual"
  echo "SCHEMA_VERSION_$label=$db:$actual"
}
apply_base_identity() {
  local db="$1"
  psql_file "$db" migrations/20261120_000_baseline_schema.sql "migration 000"
  assert_schema_version "$db" 0 "AFTER_000"
  psql_file "$db" migrations/20261120_001_product_identity.sql "migration 001"
  assert_schema_version "$db" 1 "AFTER_001"
  psql_file "$db" migrations/20261120_002_places_offers.sql "migration 002"
  assert_schema_version "$db" 1 "AFTER_002"
  psql_file "$db" migrations/20261120_003_identity_reconcile_preflight.sql "migration 003"
  assert_schema_version "$db" 1 "AFTER_003"
}

for db in \
  mapnifique_prompt26_fresh \
  mapnifique_prompt26_legacy_upgrade \
  mapnifique_prompt26_identity_clean \
  mapnifique_prompt26_identity_conflict \
  mapnifique_prompt26_backup_legacy \
  mapnifique_prompt26_restore_legacy \
  mapnifique_prompt26_restore_versioned; do
  create_db "$db"
done

# Legacy dump fixture deliberately has no schema_state.
psql_db mapnifique_prompt26_backup_legacy <<'SQL'
CREATE TABLE prompt26_legacy_backup_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO prompt26_legacy_backup_probe VALUES (1,'legacy-backup-restored');
SQL

# A. Fresh installation.
apply_base_identity mapnifique_prompt26_fresh
psql_file mapnifique_prompt26_fresh migrations/validate-product-identity.psql "validation identité"
psql_file mapnifique_prompt26_fresh migrations/validate-places-offers.psql "validation lieux/offres"
psql_file mapnifique_prompt26_fresh migrations/validate-identity-reconcile-preflight.psql "préflight réconciliation v1/v2"

# Re-run 002 only: it is designed to normalize the legacy FK/checks idempotently.
psql_file mapnifique_prompt26_fresh migrations/20261120_002_places_offers.sql "réexécution migration 002"
assert_schema_version mapnifique_prompt26_fresh 1 "AFTER_002_RERUN"
psql_file mapnifique_prompt26_fresh migrations/validate-places-offers.psql "validation après réexécution 002"

# SQL transaction atomicity smoke test on the real disposable PostgreSQL server.
psql_db mapnifique_prompt26_fresh <<'SQL'
CREATE TABLE prompt26_tx_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO prompt26_tx_probe VALUES (1,'before');
BEGIN;
INSERT INTO prompt26_tx_probe VALUES (2,'must-rollback');
UPDATE prompt26_tx_probe SET value='must-rollback' WHERE id=1;
ROLLBACK;
DO $$
BEGIN
  IF (SELECT COUNT(*) FROM prompt26_tx_probe) <> 1
     OR (SELECT value FROM prompt26_tx_probe WHERE id=1) <> 'before'
     OR EXISTS (SELECT 1 FROM prompt26_tx_probe WHERE id=2) THEN
    RAISE EXCEPTION 'Rollback PostgreSQL non atomique : données antérieures modifiées ou nouvelle ligne conservée.';
  END IF;
END $$;
CREATE TABLE prompt26_lock_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO prompt26_lock_probe VALUES (1,'initial');
INSERT INTO sources(id,name,base_url) VALUES ('prompt26-concurrency-source','Prompt26 concurrency','https://concurrency.example.test');
SQL

echo "--- concurrency: two real PostgreSQL sessions on the same row ---"
(
  psql_db mapnifique_prompt26_fresh -q -A -t <<'SQL'
BEGIN;
SELECT 'SESSION_A_PID=' || pg_backend_pid();
-- Acquérir d'abord le verrou de ligne métier, puis le verrou consultatif de
-- synchronisation. Le polling externe attend le verrou consultatif, ce qui
-- prouve que le verrou de ligne est déjà détenu avant le démarrage de B.
SELECT id FROM prompt26_lock_probe WHERE id=1 FOR UPDATE;
SELECT pg_advisory_xact_lock(26026, 1);
SELECT pg_sleep(2);
UPDATE prompt26_lock_probe SET value='worker-a' WHERE id=1;
COMMIT;
SQL
) > "$LOG_DIR/concurrency-session-a.log" 2>&1 &
SESSION_A_JOB=$!
lock_ready=0
for _ in $(seq 1 50); do
  lock_probe="$(psql_db mapnifique_prompt26_fresh -Atc \
    "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=26026::oid AND objid=1::oid AND objsubid=2 AND granted LIMIT 1")"
  if [[ "$lock_probe" == 1 ]]; then
    lock_ready=1
    break
  fi
  sleep 0.1
done
[[ "$lock_ready" == 1 ]] || fail "La session A n'a pas acquis le verrou de synchronisation PostgreSQL."
set +e
psql_db mapnifique_prompt26_fresh -q -A -t > "$LOG_DIR/concurrency-session-b.log" 2>&1 <<'SQL'
BEGIN;
SELECT 'SESSION_B_PID=' || pg_backend_pid();
SET LOCAL lock_timeout='250ms';
UPDATE prompt26_lock_probe SET value='worker-b' WHERE id=1;
COMMIT;
SQL
SESSION_B_RC=$?
set -e
wait "$SESSION_A_JOB" || fail "La session A de concurrence a échoué."
[[ "$SESSION_B_RC" -ne 0 ]] || fail "La session B aurait dû être bloquée par lock_timeout pendant le verrou de A."
SESSION_A_PID="$(grep -o 'SESSION_A_PID=[0-9]*' "$LOG_DIR/concurrency-session-a.log" | head -1 | cut -d= -f2)"
SESSION_B_PID="$(grep -o 'SESSION_B_PID=[0-9]*' "$LOG_DIR/concurrency-session-b.log" | head -1 | cut -d= -f2)"
[[ -n "$SESSION_A_PID" && -n "$SESSION_B_PID" && "$SESSION_A_PID" != "$SESSION_B_PID" ]] || fail "Les tests de concurrence n'ont pas prouvé deux backend PostgreSQL distincts."
psql_db mapnifique_prompt26_fresh -Atc "SELECT value FROM prompt26_lock_probe WHERE id=1" | grep -qx 'worker-a' || fail "Le résultat de la session A n'a pas été conservé."
printf 'CONCURRENCY_BACKEND_PIDS=%s,%s\n' "$SESSION_A_PID" "$SESSION_B_PID"
echo "--- concurrency: simultaneous idempotent offer inserts ---"
insert_same_offer() {
  psql_db mapnifique_prompt26_fresh -c "INSERT INTO offers(source_id,external_id,brand_key,title,offer_type,scope,source_url,status) VALUES ('prompt26-concurrency-source','same-offer','concurrency-brand','Offre concurrente','promotion','brand','https://concurrency.example.test/offer','draft') ON CONFLICT(source_id,external_id) DO NOTHING" >/dev/null
}
insert_same_offer & OFFER_A=$!
insert_same_offer & OFFER_B=$!
wait "$OFFER_A" || fail "Premier upsert concurrent d'offre échoué."
wait "$OFFER_B" || fail "Second upsert concurrent d'offre échoué."
psql_db mapnifique_prompt26_fresh -Atc "SELECT COUNT(*) FROM offers WHERE source_id='prompt26-concurrency-source' AND external_id='same-offer'" | grep -qx '1' || fail "Deux upserts concurrents ont créé des doublons d'offre."
echo 'POSTGRES_TRANSACTION_ROLLBACK=PASS'
echo 'POSTGRES_TWO_SESSION_LOCKING=PASS'
echo 'POSTGRES_CONCURRENT_OFFER_UPSERT=PASS'

# B. Upgrade from the actual historical places/offers DDL, including SET NULL FK.
psql_file mapnifique_prompt26_legacy_upgrade migrations/20261120_000_baseline_schema.sql "legacy baseline 000"
assert_schema_version mapnifique_prompt26_legacy_upgrade 0 "LEGACY_AFTER_000"
psql_file mapnifique_prompt26_legacy_upgrade migrations/fixtures/legacy_places_offers_prompt26.sql "DDL historique synthétique places/offers"
psql_db mapnifique_prompt26_legacy_upgrade -Atc \
  "SELECT COUNT(*) FROM places WHERE source_id='prompt26-legacy-source';" | grep -qx '1' || fail "Legacy : place synthétique absente avant upgrade."
psql_file mapnifique_prompt26_legacy_upgrade migrations/20261120_001_product_identity.sql "legacy migration 001"
assert_schema_version mapnifique_prompt26_legacy_upgrade 1 "LEGACY_AFTER_001"
psql_file mapnifique_prompt26_legacy_upgrade migrations/20261120_002_places_offers.sql "legacy migration 002"
assert_schema_version mapnifique_prompt26_legacy_upgrade 1 "LEGACY_AFTER_002"
psql_file mapnifique_prompt26_legacy_upgrade migrations/20261120_003_identity_reconcile_preflight.sql "legacy migration 003"
assert_schema_version mapnifique_prompt26_legacy_upgrade 1 "LEGACY_AFTER_003"
psql_file mapnifique_prompt26_legacy_upgrade migrations/validate-places-offers.psql "legacy validation lieux/offres"
psql_db mapnifique_prompt26_legacy_upgrade -Atc \
  "SELECT CASE WHEN COUNT(*)=1 THEN 'PRESERVED' ELSE 'LOST' END FROM offers o JOIN places p ON p.id=o.place_id WHERE o.source_id='prompt26-legacy-source' AND o.external_id='legacy-store-offer' AND o.scope='store' AND p.external_id='legacy-place-1';" | grep -qx PRESERVED || fail "Legacy : le lien offre magasin/place n'a pas été préservé."
psql_db mapnifique_prompt26_legacy_upgrade -Atc \
  "SELECT CASE WHEN confdeltype='r' THEN 'RESTRICT' ELSE confdeltype::text END FROM pg_constraint WHERE conrelid='public.offers'::regclass AND conname='offers_place_id_fkey';" | grep -qx RESTRICT || fail "Legacy : la FK offers.place_id n'utilise pas RESTRICT."

# C. A clean v1 dataset: valid GTIN, canonical URL, and one historical observation.
apply_base_identity mapnifique_prompt26_identity_clean
psql_db mapnifique_prompt26_identity_clean <<'SQL'
INSERT INTO sources(id,name,base_url) VALUES ('prompt26-clean-source','Prompt26 clean','https://clean.example.test');
WITH p AS (
  INSERT INTO products(source_id,product_url,gtin,name)
  VALUES ('prompt26-clean-source','https://clean.example.test/p/1','4006381333931','Produit clean')
  RETURNING id
)
INSERT INTO price_observations(product_id,price,currency,source_url,fingerprint)
SELECT id,12.50,'EUR','https://clean.example.test/p/1','prompt26-observation-1' FROM p;
SQL

# D. A deliberately conflicting v1 dataset: duplicate same-source GTIN.
apply_base_identity mapnifique_prompt26_identity_conflict
psql_db mapnifique_prompt26_identity_conflict <<'SQL'
INSERT INTO sources(id,name,base_url) VALUES ('prompt26-conflict-source','Prompt26 conflict','https://conflict.example.test');
INSERT INTO products(source_id,product_url,gtin,name) VALUES
 ('prompt26-conflict-source','https://conflict.example.test/p/1','4006381333931','Produit conflit A'),
 ('prompt26-conflict-source','https://conflict.example.test/p/2','4006381333931','Produit conflit B'),
 ('prompt26-conflict-source','https://conflict.example.test/p/3','1234567890123','Produit GTIN invalide');
SQL

# E. Exercise the actual backup.sh and restore.sh scripts against this
# disposable container only. Test mode never loads .env or docker compose.
run_backup() {
  local source_db="$1" backup_dir="$2" label="$3"
  MAPNIFIQUE_TEST_CONTAINER="$NAME" \
  MAPNIFIQUE_TEST_USER="$DB_USER" \
  MAPNIFIQUE_TEST_PASSWORD="$DB_PASSWORD" \
  MAPNIFIQUE_TEST_DB="$source_db" \
  MAPNIFIQUE_BACKUP_DIR="$backup_dir" \
    bash scripts/backup.sh > "$LOG_DIR/${label}-backup.log" 2>&1
  cat "$LOG_DIR/${label}-backup.log" >&2
  local dump
  dump="$(find "$backup_dir" -maxdepth 1 -type f -name '*.sql' -print -quit)"
  [[ -s "$dump" ]] || fail "$label : dump SQL absent ou vide."
  local version_file="${dump%.sql}.version"
  [[ -f "$version_file" ]] || fail "$label : sidecar de version absent."
  local dump_mode version_mode
  dump_mode="$(stat -c '%a' "$dump")"
  version_mode="$(stat -c '%a' "$version_file")"
  [[ "$dump_mode" == '600' && "$version_mode" == '600' ]] || fail "$label : dump/sidecar non privés (modes $dump_mode/$version_mode)."
  printf '%s\n' "$dump"
}
run_restore() {
  local target_db="$1" dump="$2" label="$3"
  MAPNIFIQUE_TEST_CONTAINER="$NAME" \
  MAPNIFIQUE_TEST_USER="$DB_USER" \
  MAPNIFIQUE_TEST_PASSWORD="$DB_PASSWORD" \
  MAPNIFIQUE_TEST_DB="$target_db" \
  MAPNIFIQUE_RESTORE_CONFIRM=RESTORER \
    bash scripts/restore.sh "$dump" > "$LOG_DIR/${label}-restore.log" 2>&1
  cat "$LOG_DIR/${label}-restore.log"
}

legacy_backup_dir="$LOG_DIR/backup-legacy"
legacy_dump="$(run_backup mapnifique_prompt26_backup_legacy "$legacy_backup_dir" legacy)"
legacy_version_file="${legacy_dump%.sql}.version"
[[ "$(cat "$legacy_version_file")" == 'legacy/unknown' ]] || fail 'Backup legacy : la version devrait être legacy/unknown.'
run_restore mapnifique_prompt26_restore_legacy "$legacy_dump" legacy
psql_db mapnifique_prompt26_restore_legacy -Atc \
  "SELECT value FROM prompt26_legacy_backup_probe WHERE id=1" | grep -qx 'legacy-backup-restored' \
  || fail 'Restore legacy : données non restaurées.'

versioned_backup_dir="$LOG_DIR/backup-versioned"
versioned_dump="$(run_backup mapnifique_prompt26_fresh "$versioned_backup_dir" versioned)"
versioned_version_file="${versioned_dump%.sql}.version"
[[ "$(cat "$versioned_version_file")" == '1' ]] || fail 'Backup versionné : la version attendue est 1.'
run_restore mapnifique_prompt26_restore_versioned "$versioned_dump" versioned
psql_db mapnifique_prompt26_restore_versioned -Atc \
  "SELECT version FROM schema_state WHERE singleton" | grep -qx '1' \
  || fail 'Restore versionné : schema_state.version non préservé.'
psql_db mapnifique_prompt26_restore_versioned -Atc \
  "SELECT COUNT(*) FROM sources WHERE id='prompt26-concurrency-source'" | grep -qx '1' \
  || fail 'Restore versionné : données sources absentes.'
# A missing disposable DB forces pg_dump to fail. A partial or empty dump
# must not be reported as a valid backup and its temporary files are removed.
backup_failure_dir="$LOG_DIR/backup-failure"
set +e
MAPNIFIQUE_TEST_CONTAINER="$NAME" \
MAPNIFIQUE_TEST_USER="$DB_USER" \
MAPNIFIQUE_TEST_PASSWORD="$DB_PASSWORD" \
MAPNIFIQUE_TEST_DB="mapnifique_prompt26_database_that_does_not_exist" \
MAPNIFIQUE_BACKUP_DIR="$backup_failure_dir" \
  bash scripts/backup.sh > "$LOG_DIR/backup-failure.log" 2>&1
backup_failure_rc=$?
set -e
[[ "$backup_failure_rc" -ne 0 ]] || fail 'Backup failure : pg_dump aurait dû retourner un code non nul.'
if find "$backup_failure_dir" -maxdepth 1 -type f \
  \( -name '*.sql' -o -name '*.version' -o -name '*.tmp.*' \) | grep -q .; then
  fail 'Backup failure : un fichier partiel est resté présenté comme une sauvegarde valide.'
fi
cat "$LOG_DIR/backup-failure.log" >&2
echo 'BACKUP_LEGACY_UNKNOWN=PASS'
echo 'BACKUP_SCHEMA_VERSIONED=PASS'
echo 'BACKUP_FILE_PERMISSIONS=PASS'
echo 'BACKUP_FAILURE_FAILSAFE=PASS'
echo 'RESTORE_LEGACY=PASS'
echo 'RESTORE_VERSIONED=PASS'

# Node reconciliation requires the already-installed pg module. No npm install is attempted.
if [[ "$PG_IMPORT" == 1 ]]; then
  NODE_RECONCILE="PASS"
  DB_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/mapnifique_prompt26_identity_clean"
  echo "--- reconciliation audit clean ---"
  DATABASE_URL="$DB_URL" DOTENV_CONFIG_PATH=/dev/null node scripts/reconcile-product-identity.js --audit \
    > "$LOG_DIR/reconcile-clean-audit.log" 2>&1
  cat "$LOG_DIR/reconcile-clean-audit.log"
  echo "--- reconciliation execute clean ---"
  DATABASE_URL="$DB_URL" DOTENV_CONFIG_PATH=/dev/null node scripts/reconcile-product-identity.js --execute \
    > "$LOG_DIR/reconcile-clean-execute.log" 2>&1
  cat "$LOG_DIR/reconcile-clean-execute.log"
  psql_db mapnifique_prompt26_identity_clean -Atc "SELECT version FROM schema_state WHERE singleton" | grep -qx '2' \
    || fail "Réconciliation clean : la version 2 n'a pas été atteinte."
  psql_db mapnifique_prompt26_identity_clean -Atc "SELECT COUNT(*) FROM products WHERE identity_key IS NOT NULL" | grep -qx '1' \
    || fail "Réconciliation clean : identity_key manquante après exécution."
  psql_db mapnifique_prompt26_identity_clean -Atc "SELECT COUNT(*) FROM price_observations" | grep -qx '1' \
    || fail "Réconciliation clean : observation de prix perdue."

  CONFLICT_URL="postgresql://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${PORT}/mapnifique_prompt26_identity_conflict"
  echo "--- reconciliation audit conflict (exit 2 attendu) ---"
  set +e
  DATABASE_URL="$CONFLICT_URL" DOTENV_CONFIG_PATH=/dev/null node scripts/reconcile-product-identity.js --audit \
    > "$LOG_DIR/reconcile-conflict-audit.log" 2>&1
  conflict_audit_rc=$?
  set -e
  cat "$LOG_DIR/reconcile-conflict-audit.log"
  [[ "$conflict_audit_rc" -eq 2 ]] || fail "Audit conflict : code attendu 2, obtenu $conflict_audit_rc."

  echo "--- reconciliation execute conflict (exit 3 attendu) ---"
  set +e
  DATABASE_URL="$CONFLICT_URL" DOTENV_CONFIG_PATH=/dev/null node scripts/reconcile-product-identity.js --execute \
    > "$LOG_DIR/reconcile-conflict-execute.log" 2>&1
  conflict_execute_rc=$?
  set -e
  cat "$LOG_DIR/reconcile-conflict-execute.log"
  [[ "$conflict_execute_rc" -eq 3 ]] || fail "Execute conflict : code attendu 3, obtenu $conflict_execute_rc."
  psql_db mapnifique_prompt26_identity_conflict -Atc "SELECT version FROM schema_state WHERE singleton" | grep -qx '1' \
    || fail "Réconciliation conflict : le rollback n'a pas conservé la version 1."
  psql_db mapnifique_prompt26_identity_conflict -Atc "SELECT COUNT(*) FROM products WHERE identity_key IS NULL" | grep -qx '3' \
    || fail "Réconciliation conflict : les produits ont été modifiés malgré le rollback."
  psql_db mapnifique_prompt26_identity_conflict -Atc "SELECT COUNT(*) FROM product_identifiers" | grep -qx '0' \
    || fail "Réconciliation conflict : des alias ont persisté malgré le rollback."
else
  if [[ "$NODE_AVAILABLE" == 1 ]]; then
    NODE_RECONCILE="BLOCKED_PG_MODULE_MISSING"
    echo "NODE_RECONCILIATION=BLOCKED : module pg absent ; aucune installation npm automatique." >&2
  else
    NODE_RECONCILE="BLOCKED_NODE_RUNTIME_MISSING"
    echo "NODE_RECONCILIATION=BLOCKED : Node.js absent dans ce shell ; les tests SQL et backup/restore ont été exécutés indépendamment." >&2
  fi
fi

SQL_STATUS="PASS"
echo "SQL_MIGRATIONS_AND_VALIDATORS=PASS"
echo "NODE_RECONCILIATION=$NODE_RECONCILE"
echo "SCHEMA_VERSION_FRESH=$(psql_db mapnifique_prompt26_fresh -Atc 'SELECT version FROM schema_state WHERE singleton')"
echo "SCHEMA_VERSION_LEGACY=$(psql_db mapnifique_prompt26_legacy_upgrade -Atc 'SELECT version FROM schema_state WHERE singleton')"
echo "BACKUP_RESTORE_STATUS=PASS"
echo "SQL_STATUS=$SQL_STATUS"
if [[ "$NODE_RECONCILE" != PASS ]]; then
  echo "OVERALL=PARTIAL"
  exit 2
fi
echo "OVERALL=PASS"
