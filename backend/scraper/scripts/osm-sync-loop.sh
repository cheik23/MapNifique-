#!/bin/sh

set -u

DB_NAME="${OSM_SYNC_DATABASE:-mapnifique_scraper}"
DB_USER="${OSM_SYNC_USER:-mapnifique}"
DB_HOST="${OSM_SYNC_HOST:-db}"
DB_PORT="${OSM_SYNC_PORT:-5432}"
INTERVAL="${OSM_SYNC_INTERVAL_SECONDS:-86400}"
RETRY="${OSM_SYNC_RETRY_SECONDS:-1800}"

echo "[MapNifique OSM] Worker démarré."

while true; do
  echo "[MapNifique OSM] Début synchronisation : $(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  if osm2pgsql-replication update \
    --database="$DB_NAME" \
    --username="$DB_USER" \
    --host="$DB_HOST" \
    --port="$DB_PORT" \
    --prefix=osm_pilot \
    --schema=osm_stage \
    --middle-schema=osm_stage \
    --max-diff-size=250
  then
    echo "[MapNifique OSM] Synchronisation réussie."
    echo "[MapNifique OSM] Prochaine vérification dans ${INTERVAL}s."
    sleep "$INTERVAL"
  else
    RESULT=$?
    echo "[MapNifique OSM] ERREUR code=${RESULT}. Nouvelle tentative dans ${RETRY}s."
    sleep "$RETRY"
  fi
done
