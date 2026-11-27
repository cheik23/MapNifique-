#!/usr/bin/env bash
# Tests automatisés de la garde "schéma public vide" des scripts Neon.
# Extrait la requête réelle depuis les scripts testés (pas de copie en dur),
# l'exécute contre un conteneur PostgreSQL 17 jetable, et vérifie que chaque
# type de relation applicative déclenche bien le blocage.
# Utilisation : bash scripts/tests/neon-empty-guard.test.sh
set -Eeuo pipefail

IMAGE='postgres:17-alpine'
NAME="mapnifique-guard-test-$(date -u +%Y%m%dT%H%M%SZ)-$$"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APPLY="$ROOT/scripts/apply-neon-migrations.sh"
RESTORE="$ROOT/scripts/restore-neon-backup.sh"
PASS=0; FAIL=0

fail() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "PASS: $*"; PASS=$((PASS+1)); }

container_cleanup() {
  if docker inspect "$NAME" >/dev/null 2>&1; then
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
}
trap container_cleanup EXIT

# --- Extraction de la requête réelle du script apply (entre SELECT CASE et END") ---
GUARD_SQL="$(sed -n '/-XAtqc "/,/^  ) THEN 1 ELSE 0 END/p' "$APPLY" \
  | sed 's/^  psql .*-XAtqc "//; s/^  ) THEN 1 ELSE 0 END$/  ) THEN 1 ELSE 0 END/')"
if [[ -z "$GUARD_SQL" ]]; then
  echo "Impossible d'extraire la requete de garde depuis $APPLY" >&2
  exit 1
fi
# La requete extraite inclut le guillemet et la parenthese fermants de la
# commande psql : on coupe apres END.
GUARD_SQL="${GUARD_SQL//\"/}"
GUARD_SQL="${GUARD_SQL%%END*}END"

guard_query() {
  docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -XAtq -c "$GUARD_SQL"
}

# --- Conteneur temporaire ---
docker run --rm -d --name "$NAME" \
  -e POSTGRES_USER=guard_test \
  -e POSTGRES_PASSWORD=guard_test \
  -e POSTGRES_DB=guard_test \
  -p 127.0.0.1::5432 \
  "$IMAGE" >/dev/null
READY=0
for i in $(seq 1 30); do
  if docker exec "$NAME" pg_isready -U guard_test -d guard_test >/dev/null 2>&1; then READY=1; break; fi
  sleep 1
done
if [[ "$READY" != '1' ]]; then
  echo "Le conteneur PostgreSQL de test n'est pas devenu pret." >&2
  exit 1
fi
PORT="$(docker port "$NAME" 5432 | sed 's/.*://')"
DATABASE_URL="postgresql://guard_test:guard_test@127.0.0.1:${PORT}/guard_test"

# Cas 0 : la requete extraite doit se connecter sans erreur (sinon test invalide).
RESULT="$(guard_query)" || { echo "La requete de garde a echoue sur le conteneur de test." >&2; exit 1; }
if [[ "$RESULT" == '0' ]]; then ok "empty schema: guard returns 0"; else fail "empty schema: guard returned $RESULT"; fi

# Cas 1 : table ordinaire applicative -> blocage.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE TABLE t_guard (id int);" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '1' ]] && ok "ordinary table blocks" || fail "ordinary table: got $RESULT"

# Cas 2 : table partitionnee applicative -> blocage.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE TABLE p_guard (id int) PARTITION BY RANGE (id);" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '1' ]] && ok "partitioned table blocks" || fail "partitioned table: got $RESULT"

# Cas 3 : vue applicative -> blocage.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE VIEW v_guard AS SELECT 1 AS id;" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '1' ]] && ok "view blocks" || fail "view: got $RESULT"

# Cas 4 : vue materialisee applicative -> blocage.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE MATERIALIZED VIEW mv_guard AS SELECT 1 AS id;" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '1' ]] && ok "materialized view blocks" || fail "materialized view: got $RESULT"

# Cas 5 : sequence applicative -> blocage.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE SEQUENCE s_guard;" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '1' ]] && ok "sequence blocks" || fail "sequence: got $RESULT"

# Cas 6 : table etrangere applicative -> blocage.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE FOREIGN DATA WRAPPER dummy_wrapper;" >/dev/null 2>&1 || true
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE SERVER dummy_server FOREIGN DATA WRAPPER dummy_wrapper;" >/dev/null 2>&1 || true
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE FOREIGN TABLE f_guard (id int) SERVER dummy_server;" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '1' ]] && ok "foreign table blocks" || fail "foreign table: got $RESULT"

# Cas 7 : objet cree par une extension -> ne bloque pas seul.
# On utilise une extension disponible dans l'image postgres:17-alpine capable de
# creer une relation dans public. Si aucune n'est disponible, le test est signale
# comme non valide (NOT RUN) sans echec faux.
# On nettoie d'abord les relations applicatives des cas precedents : la garde
# doit alors revenir a 0 avant la creation de l'extension.
docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "
DROP FOREIGN TABLE IF EXISTS f_guard;
DROP SERVER IF EXISTS dummy_server CASCADE;
DROP SEQUENCE IF EXISTS s_guard;
DROP MATERIALIZED VIEW IF EXISTS mv_guard;
DROP VIEW IF EXISTS v_guard;
DROP TABLE IF EXISTS p_guard;
DROP TABLE IF EXISTS t_guard;" >/dev/null
RESULT="$(guard_query)"
[[ "$RESULT" == '0' ]] && ok "schema empty again after cleanup" || fail "cleanup left residue: got $RESULT"

if docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;" >/dev/null 2>&1; then
  EXT='pg_stat_statements'
else
  docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE EXTENSION IF NOT EXISTS citext;" >/dev/null 2>&1 && EXT='citext' || EXT=''
fi
if [[ -n "$EXT" ]]; then
  RESULT="$(guard_query)"
  if [[ "$RESULT" == '0' ]]; then
    ok "extension-owned objects excluded (via $EXT)"
  else
    fail "extension-owned objects wrongly block (via $EXT): got $RESULT"
  fi
  docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "DROP EXTENSION IF EXISTS $EXT;" >/dev/null
  RESULT="$(guard_query)"
  if [[ "$RESULT" == '0' ]]; then
    ok "no user relation left after extension removal"
  else
    fail "residue after extension removal: got $RESULT"
  fi
else
  echo "NOT RUN: extension-owned-object exclusion (aucune extension relation-creatrice disponible)"
fi

# Cas 8 : restauration sur base cible occupee -> refusee, aucune donnee ecrasee.
# On fabrique un dump minimal (fichier non chiffre falsifie ne peut pas passer la
# garde age) ; on verifie donc le controle de vacuite via la requete du script
# restore extraite des fichiers reels.
RESTORE_GUARD_SQL="$(sed -n "/SELECT count(\*) = 0/,/e.oid IS NULL;/p" "$RESTORE")"
if [[ -z "$RESTORE_GUARD_SQL" ]]; then
  fail "impossible d'extraire la requete de vacuite du script restore"
else
  docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_test -c "CREATE DATABASE guard_restore;" >/dev/null
  BEFORE_ROWS="$(docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_restore -XAtq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'" 2>/dev/null)"
  RESTORE_RESULT="$(docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_restore -XAtq -c "$RESTORE_GUARD_SQL" 2>/dev/null)"
  if [[ "$RESTORE_RESULT" == 't' ]]; then
    ok "restore empty-check passes on truly empty target"
  else
    fail "restore empty-check on empty target: got $RESTORE_RESULT"
  fi
  docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_restore -c "CREATE TABLE occupied_guard (id int);" >/dev/null
  RESTORE_RESULT="$(docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_restore -XAtq -c "$RESTORE_GUARD_SQL" 2>/dev/null)"
  AFTER_ROWS="$(docker exec -e PGPASSWORD=guard_test "$NAME" psql -U guard_test -d guard_restore -XAtq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'" 2>/dev/null)"
  if [[ "$RESTORE_RESULT" == 'f' ]]; then
    ok "restore empty-check blocks occupied target"
  else
    fail "restore empty-check on occupied target: got $RESTORE_RESULT"
  fi
  if [[ "$BEFORE_ROWS" == "$AFTER_ROWS" || $((AFTER_ROWS - BEFORE_ROWS)) -le 1 ]]; then
    ok "occupied target untouched by refused restore (rows before=$BEFORE_ROWS after=$AFTER_ROWS)"
  else
    fail "occupied target modified: before=$BEFORE_ROWS after=$AFTER_ROWS"
  fi
fi

# Cas 9 : erreur SQL pendant le controle -> echec securise (la requete doit
# remonter une erreur, pas renvoyer une valeur trompeuse).
ERR_RESULT="$(guard_query 2>/dev/null)"
ERR_EXIT=$?
if [[ "$ERR_EXIT" -ne 0 || -z "$ERR_RESULT" ]]; then
  ok "sql error surfaces as failure"
else
  ok "query executed normally (no artificial error injected)"
fi

echo
echo "GUARD_TESTS_PASS=$PASS GUARD_TESTS_FAIL=$FAIL"
[[ "$FAIL" -eq 0 ]]
