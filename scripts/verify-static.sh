#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

printf '\n== JavaScript syntax ==\n'
find backend/scraper/src backend/scraper/functions backend/scraper/scripts scripts \
  -type f \( -name '*.js' -o -name '*.mjs' \) -print0 \
  | while IFS= read -r -d '' file; do node --check "$file"; done

printf '\n== Shell syntax ==\n'
find . -type f -name '*.sh' -not -path '*/node_modules/*' -print0 \
  | while IFS= read -r -d '' file; do bash -n "$file"; done

printf '\n== JSON syntax ==\n'
node --input-type=module <<'NODE'
import fs from 'node:fs';
const files = [
  'package.json',
  'backend/scraper/package.json',
  'backend/scraper/package-lock.json',
  'frontend/package.json',
  'frontend/package-lock.json',
  'frontend/.oxlintrc.json',
  'frontend/public/manifest.webmanifest',
];
for (const file of files) JSON.parse(fs.readFileSync(file, 'utf8'));
console.log(`JSON=PASS (${files.length} files)`);
NODE

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git diff --check
fi

echo 'MAPNIFIQUE_STATIC_VALIDATION=PASS'
