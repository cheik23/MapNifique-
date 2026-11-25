#!/usr/bin/env bash
set -Eeuo pipefail

# Publie le workspace sur une branche de revue, jamais directement sur main.
SOURCE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
REMOTE_INPUT="${MAPNIFIQUE_REMOTE:-https://github.com/cheik23/MapNifique-.git}"
BRANCH="${MAPNIFIQUE_BRANCH:-work/mapnifique-finalisation-20261121}"
DEST="${MAPNIFIQUE_PUBLISH_DIR:-$HOME/MapNifique-GitHub-Publish-20261121}"

fail() { printf 'ERREUR: %s\n' "$*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || fail "git est requis."
command -v python3 >/dev/null 2>&1 || fail "python3 est requis."
[[ -f "$SOURCE_ROOT/package.json" && -d "$SOURCE_ROOT/frontend" && -d "$SOURCE_ROOT/backend/scraper" ]] || fail "Lance ce script depuis la racine du workspace MapNifique-Workspace."
[[ "$BRANCH" != "main" && "$BRANCH" != "master" ]] || fail "Publication directe sur main/master interdite."
[[ "$BRANCH" =~ ^[A-Za-z0-9._/-]+$ ]] || fail "Nom de branche invalide."

# Aucun prompt de mot de passe GitHub. Utilise d'abord GitHub CLI déjà authentifié,
# puis une clé SSH GitHub; conserve HTTPS si le credential helper fonctionne déjà.
REMOTE="$REMOTE_INPUT"
case "$REMOTE_INPUT" in
  https://github.com/*)
    # IMPORTANT: this repository is public, so git ls-remote succeeds anonymously.
    # Do not treat read-only visibility as proof that a push is authenticated.
    HTTPS_AUTH=0
    if command -v gh >/dev/null 2>&1 && gh auth status --hostname github.com >/dev/null 2>&1; then
      GH_PUSH_ALLOWED="$(gh api repos/cheik23/MapNifique- --jq '.permissions.push' 2>/dev/null || true)"
      if [[ "$GH_PUSH_ALLOWED" == "true" ]]; then
        gh auth setup-git --hostname github.com >/dev/null
        if GIT_TERMINAL_PROMPT=0 git ls-remote "$REMOTE_INPUT" refs/heads/main >/dev/null 2>&1; then
          HTTPS_AUTH=1
        fi
      fi
    fi
    if [[ "$HTTPS_AUTH" -eq 0 ]] && command -v ssh >/dev/null 2>&1; then
      SSH_PROBE="$(ssh -T -o BatchMode=yes -o ConnectTimeout=7 -o StrictHostKeyChecking=accept-new git@github.com 2>&1 || true)"
      if grep -qiE 'successfully authenticated|authenticated to GitHub' <<<"$SSH_PROBE"; then
        REMOTE="git@github.com:${REMOTE_INPUT#https://github.com/}"
        REMOTE="${REMOTE%.git}.git"
      fi
    fi
    [[ "$HTTPS_AUTH" -eq 1 || "$REMOTE" != "$REMOTE_INPUT" ]] || {
      cat >&2 <<'MSG'
Aucune authentification GitHub en écriture n'a été détectée. Le dépôt est public : une lecture anonyme de main ne prouve PAS les droits de push. Aucun clone, commit ni push n'a été lancé.

Dans WSL, exécute exactement ces commandes, séparément :
  command -v gh || echo 'GitHub CLI absent'
  gh --version
  gh auth login --hostname github.com --git-protocol https --web
  gh auth status --hostname github.com

Autorise MapNifique dans le navigateur, puis relance :
  npm run publish:github

Alternative : configurer une clé SSH GitHub puis relancer le script.
Le clone de staging et les commits locaux déjà créés sont conservés.
MSG
      exit 2
    }
    ;;
  git@github.com:*|ssh://git@github.com/*)
    SSH_PROBE="$(ssh -T -o BatchMode=yes -o ConnectTimeout=7 -o StrictHostKeyChecking=accept-new git@github.com 2>&1 || true)"
    grep -qiE 'successfully authenticated|authenticated to GitHub' <<<"$SSH_PROBE" || fail "La clé SSH n'est pas authentifiée auprès de GitHub. Aucun push n'a été tenté."
    ;;
  *)
    # Permet les tests locaux avec un dépôt bare ou un serveur Git privé.
    GIT_TERMINAL_PROMPT=0 git ls-remote "$REMOTE" HEAD >/dev/null 2>&1 || fail "Le dépôt distant est inaccessible sans prompt interactif : $REMOTE"
    ;;
esac

# The publish command is the user's single safe entry point: authenticate first,
# then rerun the complete validation and dependency audit before creating a commit.
printf '\nPrépublication — validations complètes, audit et résumé des dépendances...\n'
(cd "$SOURCE_ROOT" && npm run verify:full)
(cd "$SOURCE_ROOT" && npm run audit:deps)
(cd "$SOURCE_ROOT" && npm run audit:deps:summary)

printf 'Source : %s\nDépôt : %s\nBranche : %s\nClone local : %s\n' "$SOURCE_ROOT" "$REMOTE" "$BRANCH" "$DEST"

copy_workspace() {
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
ignored_files = {'.DS_Store', 'Thumbs.db'}
ignored_suffixes = {
    '.pem', '.key', '.sqlite', '.sqlite3', '.db', '.dump', '.bak',
    '.backup', '.pid', '.log',
}
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
        if any(part in {'backups', 'node_modules', 'dist', 'secrets', 'pgdata', 'postgres_data'} for part in parts):
            continue
        if 'credentials' in filename.lower():
            continue
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target)
        copied += 1
print(f'Fichiers copiés : {copied}')
PY
}

printf '\n1/5 — Vérification de la branche distante...\n'
if git ls-remote --exit-code --heads "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  fail "La branche distante $BRANCH existe déjà. Le script refuse de la remplacer. Vérifie la PR existante."
fi

if [[ -e "$DEST" ]]; then
  printf '\n2/5 — Reprise du clone local existant (après push interrompu)...\n'
  git -C "$DEST" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "$DEST existe mais n'est pas un dépôt Git. Déplace-le avant de relancer."
  CURRENT_BRANCH="$(git -C "$DEST" branch --show-current)"
  [[ "$CURRENT_BRANCH" == "$BRANCH" ]] || fail "Le clone existant est sur '$CURRENT_BRANCH', attendu '$BRANCH'. Aucun fichier n'a été modifié."
  [[ -z "$(git -C "$DEST" status --porcelain)" ]] || fail "Le clone de staging contient des modifications locales non validées. Inspecte-les avant de continuer."
  git -C "$DEST" remote set-url origin "$REMOTE"
  GIT_TERMINAL_PROMPT=0 git -C "$DEST" fetch origin main --no-tags
  git -C "$DEST" merge-base --is-ancestor origin/main HEAD || fail "La branche de staging n'est plus basée sur l'historique courant de main. Revue manuelle nécessaire."
else
  printf '\n2/5 — Clone de main dans un dossier isolé...\n'
  git clone --branch main --single-branch "$REMOTE" "$DEST"
  git -C "$DEST" switch --create "$BRANCH" origin/main
fi

printf '\n3/5 — Synchronisation du workspace validé dans la branche de revue...\n'
copy_workspace

git -C "$DEST" add --all
printf '\n4/5 — Contrôles de sécurité et contenu indexé...\n'
git -C "$DEST" -c core.whitespace=cr-at-eol diff --cached --check -- . \
  ':(exclude)archive/legacy-mapnifique/**' \
  ':(exclude)docs/finalization-report-2026-11-21.md'
if git -C "$DEST" diff --cached --name-only | grep -E '(^|/)\.env($|\.)' | grep -Ev '\.env\.example$' >/dev/null; then
  fail "Un fichier .env semble indexé. Aucun commit/push n'a été effectué."
fi
if git -C "$DEST" diff --cached --name-only | grep -E '(^|/)(backups|node_modules|dist|secrets|pgdata|postgres_data)/|\.(pem|key|sqlite3?|db|dump|bak|backup|pid|log)$' >/dev/null; then
  fail "Un fichier runtime/sensible semble indexé. Aucun commit/push n'a été effectué."
fi
printf '\nRésumé des changements :\n'
git -C "$DEST" diff --cached --stat

if ! git -C "$DEST" config user.name >/dev/null; then
  git -C "$DEST" config user.name "cheik23"
fi
if ! git -C "$DEST" config user.email >/dev/null; then
  git -C "$DEST" config user.email "cheik23@users.noreply.github.com"
fi

if ! git -C "$DEST" diff --cached --quiet; then
  printf '\n5/5 — Création du commit de synchronisation...\n'
  git -C "$DEST" commit -m "chore: sync MapNifique finalisation workspace"
else
  printf '\n5/5 — Aucun nouveau changement ; reprise du commit local existant.\n'
fi
printf 'Push sécurisé vers la branche de revue (aucun push forcé, main intacte)...\n'
GIT_TERMINAL_PROMPT=0 git -C "$DEST" push --set-upstream origin "$BRANCH"

printf '\nPUBLICATION_TERMINEE\nBranche : %s\nCommit : %s\nDossier local : %s\nPull request : https://github.com/cheik23/MapNifique-/compare/main...%s?expand=1\n' \
  "$BRANCH" "$(git -C "$DEST" rev-parse --short HEAD)" "$DEST" "$BRANCH"
printf 'La branche main n’a pas été modifiée. Examine la PR et attends la CI avant toute fusion ou mise en production.\n'
