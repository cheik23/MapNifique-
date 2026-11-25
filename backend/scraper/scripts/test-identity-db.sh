#!/usr/bin/env bash
# Compatibilité : le test d'identité appelle le runner Prompt 26 complet.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bash "$SCRIPT_DIR/test-prompt26-postgres.sh" "$@"
