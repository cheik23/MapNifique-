#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
BACKEND="$ROOT/backend/scraper"
TRIAL="$(mktemp -d "${TMPDIR:-/tmp}/mapnifique-minimatch-override.XXXXXX")"
SUCCESS=0

fail() { printf 'ERREUR: %s\n' "$*" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || fail "npm est requis."
command -v node >/dev/null 2>&1 || fail "Node.js est requis."
[[ -f "$BACKEND/package.json" && -f "$BACKEND/package-lock.json" ]] || fail "Workspace backend incomplet."

cleanup() {
  if [[ "$SUCCESS" -eq 1 ]]; then
    rm -rf "$TRIAL"
  else
    printf '\nDossier d’essai conservé pour diagnostic : %s\n' "$TRIAL" >&2
  fi
}
trap cleanup EXIT

printf 'Essai isolé minimatch 11.x\nBackend source : %s\nDossier temporaire : %s\n' "$BACKEND" "$TRIAL"
mkdir -p "$TRIAL/src" "$TRIAL/scripts" "$TRIAL/migrations"
cp "$BACKEND/package.json" "$BACKEND/package-lock.json" "$TRIAL/"
cp -a "$BACKEND/src/." "$TRIAL/src/"
cp -a "$BACKEND/scripts/." "$TRIAL/scripts/"
cp -a "$BACKEND/migrations/." "$TRIAL/migrations/"

node --input-type=commonjs - "$TRIAL/package.json" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.overrides = { ...(pkg.overrides || {}), minimatch: '^11.0.1' };
fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
NODE

printf '\n1/7 — Régénération isolée du lockfile via npm\n'
(cd "$TRIAL" && npm install --package-lock-only --ignore-scripts --no-audit --no-fund)

LOCKED_VERSION="$(node --input-type=commonjs - "$TRIAL/package-lock.json" <<'NODE'
const fs = require('node:fs');
const lock = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const matches = Object.entries(lock.packages || {})
  .filter(([path, value]) => path.endsWith('/node_modules/minimatch') || path === 'node_modules/minimatch')
  .map(([, value]) => value.version);
const unique = [...new Set(matches)];
if (unique.length !== 1 || !/^11\./.test(unique[0] || '')) {
  console.error(`Versions minimatch inattendues dans le lockfile : ${unique.join(', ') || 'aucune'}`);
  process.exit(1);
}
process.stdout.write(unique[0]);
NODE
)" || fail "Le lockfile isolé ne résout pas minimatch en 11.x."
printf 'MINIMATCH_LOCKED_VERSION=%s\n' "$LOCKED_VERSION"

printf '\n2/7 — Installation propre isolée (sans scripts tiers)\n'
(cd "$TRIAL" && npm ci --ignore-scripts --no-audit --no-fund)

printf '\n3/7 — Contrôle de syntaxe backend\n'
(cd "$TRIAL" && npm run check)

printf '\n4/7 — Suite unitaire backend\n'
(cd "$TRIAL" && npm test)

printf '\n5/7 — Smoke test Crawlee réel avec enqueueLinks + Minimatch\n'
(cd "$TRIAL" && node scripts/minimatch-crawlee-smoke.mjs)

printf '\n6/7 — Audit npm backend après override\n'
AUDIT_STATUS=0
(cd "$TRIAL" && npm audit --json > audit-after.json 2> audit-after.stderr) || AUDIT_STATUS=$?
node --input-type=commonjs - "$TRIAL/audit-after.json" "$AUDIT_STATUS" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const status = Number(process.argv[3]);
let report;
try { report = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch (error) {
  console.error(`Rapport npm audit illisible : ${error.message}`);
  process.exit(2);
}
const meta = report?.metadata?.vulnerabilities;
if (!meta) {
  console.error(`Audit incomplet : ${report?.error?.summary || 'metadata absente'}`);
  console.error(report?.error?.detail || '');
  process.exit(2);
}
console.log(`AUDIT_TOTAL=${meta.total}`);
console.log(`AUDIT_MODERATE=${meta.moderate || 0}`);
console.log(`AUDIT_HIGH=${meta.high || 0}`);
console.log(`AUDIT_CRITICAL=${meta.critical || 0}`);
if (meta.total !== 0 || status !== 0) {
  for (const item of Object.values(report.vulnerabilities || {})) {
    console.error(`- ${item.name}: ${item.severity}; range=${item.range}; fix=${JSON.stringify(item.fixAvailable)}`);
  }
  process.exit(1);
}
NODE

printf '\n7/7 — Validation PostgreSQL isolée\n'
command -v docker >/dev/null 2>&1 || fail "Docker est requis pour valider l’override avant intégration."
docker info >/dev/null 2>&1 || fail "Le daemon Docker doit être démarré pour le test PostgreSQL isolé."
(cd "$TRIAL" && npm run test:postgres:prompt26)

printf '\nToutes les validations de l’essai ont réussi. Application des deux fichiers de dépendances au workspace source.\n'
cp "$TRIAL/package.json" "$BACKEND/package.json"
cp "$TRIAL/package-lock.json" "$BACKEND/package-lock.json"
SUCCESS=1
printf '\nMINIMATCH_OVERRIDE_APPLIED=PASS\nVersion : %s\n' "$LOCKED_VERSION"
printf 'Relance ensuite : npm ci --prefix backend/scraper && npm run verify:full && npm run audit:deps && npm run audit:deps:summary\n'
printf 'Puis publie le commit de suivi avec : npm run publish:github\n'
