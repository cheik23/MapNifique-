#!/usr/bin/env bash
set -uo pipefail
umask 077
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="${MAPNIFIQUE_SECURITY_AUDIT_DIR:-$ROOT_DIR/backups/security-audit-$STAMP}"
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

run_audit() {
  local project="$1"
  local output="$OUT_DIR/${project//\//-}.json"
  local errors="$OUT_DIR/${project//\//-}.stderr.log"
  local status=0
  (
    cd "$ROOT_DIR/$project" || exit 127
    npm audit --json > "$output" 2> "$errors"
  ) || status=$?
  chmod 600 "$output" "$errors" 2>/dev/null || true
  printf '%s=%s\n' "$project" "$status"
}

run_audit backend/scraper
run_audit frontend
printf 'AUDIT_DIRECTORY=%s\n' "$OUT_DIR"
printf '%s\n' 'Les codes npm non nuls signalent des advisories ou une erreur réseau ; consulter les JSON et fichiers stderr.'
