#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if ! command -v neon >/dev/null 2>&1; then
  echo "Neon CLI absent. Installe-le avec : npm i -g neon@latest" >&2
  exit 2
fi
if [[ -z "${NEON_PROJECT_ID:-}" ]]; then
  echo "Définis NEON_PROJECT_ID avec l'identifiant du projet Neon Free." >&2
  exit 2
fi
NEON_BRANCH="${NEON_BRANCH:-main}"
NEON_CORS_ORIGINS="${NEON_CORS_ORIGINS:-https://mapnifique.pages.dev}"

echo "Déploiement de la fonction api sur Neon Free (projet=${NEON_PROJECT_ID}, branche=${NEON_BRANCH})."
neon functions deploy api \
  --src backend/scraper/functions/api.js \
  --runtime nodejs24 \
  --project-id "$NEON_PROJECT_ID" \
  --branch "$NEON_BRANCH" \
  --env "CORS_ORIGINS=$NEON_CORS_ORIGINS" \
  --env "DATABASE_POOL_MAX=2"
