#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# stop arrête les services sans supprimer le volume PostgreSQL.
docker compose stop
