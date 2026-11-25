#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose ps
printf '\nSanté API :\n'
curl -fsS http://127.0.0.1:8787/health || true
printf '\n\nSources configurées :\n'
curl -fsS http://127.0.0.1:8787/api/sources || true
printf '\n'
