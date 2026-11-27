#!/usr/bin/env bash
# Exécuté à l'intérieur du conteneur postgres:17-alpine lors du premier déploiement Neon.
# Applique les migrations 000 à 003 dans l'ordre.
set -euo pipefail
for file in \
  /migrations/20261120_000_baseline_schema.sql \
  /migrations/20261120_001_product_identity.sql \
  /migrations/20261120_002_places_offers.sql \
  /migrations/20261120_003_identity_reconcile_preflight.sql; do
  echo "--- $file ---"
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f "$file"
done
