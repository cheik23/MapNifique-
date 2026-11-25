#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")/.."

fail() {
  echo "[MapNifique] ERREUR : $*" >&2
  exit 1
}

if ! command -v docker >/dev/null 2>&1; then
  fail "Docker n'est pas installé ou n'est pas accessible depuis WSL. Active l'intégration WSL2 dans Docker Desktop."
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "Le plugin Docker Compose v2 est absent."
fi

if [[ ! -f .env ]]; then
  command -v openssl >/dev/null 2>&1 || fail "openssl est requis pour générer les secrets locaux."
  database_secret="$(openssl rand -hex 24)"
  admin_secret="$(openssl rand -hex 32)"
  sed \
    -e "s/replace-with-a-long-random-password/${database_secret}/g" \
    -e "s/replace-with-a-long-random-admin-token/${admin_secret}/g" \
    .env.example > .env
  chmod 600 .env
  echo "[MapNifique] .env créé avec des secrets aléatoires. Conserve ce fichier privé."
fi

# Validate the Compose model before starting anything.
docker compose config --services >/dev/null

echo "[MapNifique] Démarrage de PostgreSQL uniquement. Aucune migration automatique ne sera exécutée."
docker compose up -d db

container_id="$(docker compose ps -q db)"
[[ -n "$container_id" ]] || fail "Le conteneur du service db n'a pas été créé."

healthy=false
for attempt in $(seq 1 30); do
  container_state="$(docker inspect --format '{{.State.Status}}' "$container_id" 2>/dev/null || true)"
  health_state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}no-healthcheck{{end}}' "$container_id" 2>/dev/null || true)"
  if [[ "$container_state" == "exited" || "$container_state" == "dead" ]]; then
    docker compose logs --tail=80 db >&2 || true
    fail "PostgreSQL s'est arrêté pendant son démarrage."
  fi
  if [[ "$container_state" == "running" && "$health_state" == "healthy" ]]; then
    healthy=true
    break
  fi
  sleep 2
done

if [[ "$healthy" != true ]]; then
  docker compose logs --tail=80 db >&2 || true
  fail "PostgreSQL n'est pas devenu healthy dans le délai prévu."
fi

# Check readiness via psql inside the already identified Compose db container.
# No host psql dependency and no application container starts before this check.
if ! readiness="$(docker compose exec -T db sh -c 'psql -XAtq -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
SELECT CASE
  WHEN to_regclass('public.schema_state') IS NULL THEN 'missing_schema_state'
  WHEN (SELECT version FROM public.schema_state WHERE singleton) IS DISTINCT FROM 2 THEN 'schema_version_not_2'
  WHEN to_regprocedure('public.identity_schema_problems()') IS NULL THEN 'identity_schema_check_missing'
  WHEN EXISTS (SELECT 1 FROM public.identity_schema_problems()) THEN 'identity_schema_problems'
  WHEN to_regprocedure('public.places_schema_problems()') IS NULL THEN 'places_schema_check_missing'
  WHEN EXISTS (SELECT 1 FROM public.places_schema_problems()) THEN 'places_schema_problems'
  ELSE 'ready'
END;
SQL
)"; then
  readiness="schema_check_failed"
fi
readiness="$(printf '%s' "$readiness" | tr -d '\r\n[:space:]')"

if [[ "$readiness" != "ready" ]]; then
  cat >&2 <<EOF_MSG
[MapNifique] Les services applicatifs ne seront PAS démarrés.
État du schéma : ${readiness:-résultat vide}

Préparation requise (sur une base locale dédiée, après sauvegarde vérifiée) :
  1. appliquer migrations/20261120_000_baseline_schema.sql si la base est neuve ;
  2. appliquer migrations/20261120_001_product_identity.sql ;
  3. appliquer migrations/20261120_002_places_offers.sql ;
  4. appliquer migrations/20261120_003_identity_reconcile_preflight.sql ;
  5. exécuter le mode reconcile:audit et examiner les anomalies ;
  6. après validation explicite, exécuter la réconciliation contrôlée vers la version 2.

Ce script n'exécute aucune migration ni réconciliation automatiquement.
Relance ensuite scripts/start.sh.
EOF_MSG
  exit 2
fi

echo "[MapNifique] Schéma version 2 et tables lieux/offres validés. Démarrage des services applicatifs."
docker compose up -d --build api worker offers-worker

echo
echo "[MapNifique] État des services :"
docker compose ps

echo
echo "[MapNifique] Vérification de l'API :"
if ! curl --retry 12 --retry-delay 2 --retry-connrefused -fsS http://127.0.0.1:8787/health; then
  docker compose logs --tail=100 api >&2 || true
  fail "L'API n'a pas répondu correctement après le démarrage."
fi
echo
echo "API locale : http://127.0.0.1:8787"
