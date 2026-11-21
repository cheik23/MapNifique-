#!/usr/bin/env bash
set -Eeuo pipefail

# Publishes this exact workspace to a new review branch. Never pushes to main.
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE="${MAPNIFIQUE_REMOTE:-https://github.com/cheik23/MapNifique-.git}"
BRANCH="${MAPNIFIQUE_BRANCH:-work/mapnifique-finalisation-20261121}"
DEST="${MAPNIFIQUE_PUBLISH_DIR:-$HOME/MapNifique-GitHub-Publish-20261121}"

fail() { printf 'ERREUR: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "git est requis."
command -v python3 >/dev/null 2>&1 || fail "python3 est requis."
[[ -f "$SOURCE_ROOT/package.json" && -d "$SOURCE_ROOT/frontend" && -d "$SOURCE_ROOT/backend/scraper" ]] || fail "Lance ce script depuis l'archive complète MapNifique-Workspace."
[[ "$BRANCH" != "main" && "$BRANCH" != "master" ]] || fail "Publication directe sur main/master interdite."
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Nom de branche invalide."
[[ ! -e "$DEST" ]] || fail "Le dossier $DEST existe déjà. Déplace-le ou choisis MAPNIFIQUE_PUBLISH_DIR."

printf 'Source : %s\nDépôt : %s\nBranche : %s\nClone local : %s\n' "$SOURCE_ROOT" "$REMOTE" "$BRANCH" "$DEST"
printf '\n1/5 — Vérification de la branche distante...\n'
if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  fail "La branche distante $BRANCH existe déjà. Choisis MAPNIFIQUE_BRANCH pour ne pas l'écraser."
fi

printf '\n2/5 — Clone de main sans toucher au dépôt source...\n'
git clone --branch main --single-branch "$REMOTE" "$DEST"
git -C "$DEST" switch --create "$BRANCH" origin/main

printf '\n3/5 — Remplacement du contenu du clone par le workspace validé...\n'
python3 - "$SOURCE_ROOT" "$DEST" <<'PY'
from pathlib import Path
import os
import shutil
import sys

source = Path(sys.argv[1]).resolve()
dest = Path(sys.argv[2]).resolve()
ignored_dirs = {
    '.git', 'node_modules', 'dist', 'dist-ssr', '.vite', '.vercel',
    '.next', '.turbo', '.cache', 'coverage', 'backups', '.crawlee',
    'pgdata', 'postgres_data',
}
ignored_files = {
    '.DS_Store', 'Thumbs.db',
}
ignored_suffixes = {
    '.pem', '.key', '.sqlite', '.sqlite3', '.db', '.dump', '.bak',
    '.backup', '.pid', '.log',
}

# Clear all old tracked/untracked project files in the new clone, retaining .git.
for child in dest.iterdir():
    if child.name == '.git':
        continue
    if child.is_dir() and not child.is_symlink():
        shutil.rmtree(child)
    else:
        child.unlink()

copied = 0
for current, dirs, files in os.walk(source, topdown=True, followlinks=False):
    cur = Path(current)
    rel_dir = cur.relative_to(source)
    dirs[:] = [d for d in dirs if d not in ignored_dirs and not (cur / d).is_symlink()]
    for filename in files:
        src = cur / filename
        if src.is_symlink() or filename in ignored_files:
            continue
        rel = src.relative_to(source)
        parts = rel.parts
        if filename == '.env' or (filename.startswith('.env.') and filename != '.env.example'):
            continue
        if filename.endswith(tuple(ignored_suffixes)):
            continue
        if 'backups' in parts or 'node_modules' in parts or 'dist' in parts:
            continue
        if 'secrets' in parts or 'credentials' in filename.lower():
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        copied += 1
print(f'Fichiers copiés : {copied}')
PY

printf '\n4/5 — Contrôles de sécurité et contenu indexé...\n'
git -C "$DEST" add --all
git -C "$DEST" -c core.whitespace=cr-at-eol diff --cached --check -- . ':(exclude)archive/legacy-mapnifique/**' ':(exclude)docs/finalization-report-2026-11-21.md'
if git -C "$DEST" diff --cached --name-only | grep -E '(^|/)\.env($|\.)' | grep -Ev '\.env\.example$' >/dev/null; then
  fail "Un fichier .env semble indexé. Aucun commit/push n'a été effectué."
fi
if git -C "$DEST" diff --cached --name-only | grep -E '(^|/)(backups|node_modules|dist|secrets|pgdata|postgres_data)/|\.(pem|key|sqlite3?|db|dump|bak|backup|pid|log)$' >/dev/null; then
  fail "Un fichier runtime/sensible semble indexé. Aucun commit/push n'a été effectué."
fi
printf '\nRésumé des changements :\n'
git -C "$DEST" diff --cached --stat

# Use the GitHub no-reply identity that already appears in the repository history,
# but only when this fresh staging clone has no identity configured.
if ! git -C "$DEST" config user.name >/dev/null; then
  git -C "$DEST" config user.name "cheik23"
fi
if ! git -C "$DEST" config user.email >/dev/null; then
  git -C "$DEST" config user.email "cheik23@users.noreply.github.com"
fi

printf '\n5/5 — Commit et push sur la branche de revue (jamais sur main)...\n'
if ! git -C "$DEST" diff --cached --quiet; then
  git -C "$DEST" commit -m "feat: migrate MapNifique to React and PostGIS workspace"
else
  fail "Aucun changement à publier."
fi
git -C "$DEST" push --set-upstream origin "$BRANCH"

printf '\nPUBLICATION_TERMINEE\nBranche : %s\nDossier local : %s\nPull request : https://github.com/cheik23/MapNifique-/compare/main...%s?expand=1\n' "$BRANCH" "$DEST" "$BRANCH"
printf 'La branche main n’a pas été modifiée. Examine la PR avant toute fusion ou mise en production.\n'
