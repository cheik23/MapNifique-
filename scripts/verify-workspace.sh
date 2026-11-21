#!/usr/bin/env bash
# Full local verification for the disposable MapNifique workspace.
# Installs only lockfile-pinned dependencies; no production DB or deployment is touched.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

printf '\n== 1/4 Backend dependencies ==\n'
npm ci --prefix backend/scraper

printf '\n== 2/4 Frontend dependencies ==\n'
npm ci --prefix frontend

printf '\n== 3/4 Unit, syntax, lint and build checks ==\n'
npm run verify

printf '\n== 4/4 Disposable PostgreSQL integration ==\n'
npm --prefix backend/scraper run test:postgres:prompt26

printf '\nMAPNIFIQUE_FULL_VALIDATION=PASS\n'
printf 'Aucune base de production ni aucun déploiement ne sont ciblés par ce script.\n'
