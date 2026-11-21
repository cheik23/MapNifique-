# MapNifique

MapNifique is a geolocated discovery app for nearby shops, services and verified promotions. This private repository, `cheik23/MapNifique`, is the project's single source of truth on branch `main`.

## Repository layout

- `frontend/` is the public React, TypeScript and Vite application. It uses MapLibre and PMTiles where configured.
- `backend/scraper/` contains the Fastify API, PostgreSQL/PostGIS schema, crawlers and scheduled offer worker.
- `archive/legacy-mapnifique/` is a read-only reference snapshot; it is excluded from normal build and test commands.

Each runnable package has its own lockfile and dependencies. No production cloud resources are configured or changed by this repository. Docker Compose is for local development only; it must not be used as a production dependency on a personal computer.

## Requirements

- Node.js `>=22.13.0` and npm.
- Docker Engine or Docker Desktop with Compose v2 for local PostgreSQL/PostGIS.

## Install and run locally

From the repository root:

```sh
npm --prefix frontend ci
npm --prefix backend/scraper ci
```

Create `backend/scraper/.env` from `.env.example` and set local-only values. Never commit `.env` files or copy server secrets into a `VITE_*` variable. Start the local database and services from `backend/scraper/`:

```sh
docker compose up -d db api worker offers-worker
```

The API binds to `127.0.0.1:8787`; the database has no host-published port. Run the frontend in another terminal with `npm run dev`. Vite proxies `/api` to the local API. A public frontend build needs `VITE_MAPNIFIQUE_API_URL` set to an HTTPS API origin; every `VITE_*` value is public.

The optional `osm-sync` Compose profile requires local PBF/configuration files under ignored `backend/scraper/data/`. These inputs are intentionally not stored in Git.

## Preview local du frontend

Après l’installation des dépendances frontend (`npm ci --prefix frontend`), depuis la racine du workspace :

```sh
npm run dev
```

Ouvrir ensuite <http://localhost:5173> dans le navigateur Windows ou Linux. Vite écoute sur `0.0.0.0:5173` et utilise le proxy `/api` vers `http://127.0.0.1:8787`. Si l’API locale n’est pas démarrée, l’interface et la carte peuvent s’afficher, mais les recherches de commerces et les promotions qui dépendent de l’API ne seront pas pleinement fonctionnelles.

Le preview Vite est un serveur de développement local, pas une URL publique ni une mise en production. Le backend exige une base locale dont le schéma a été migré et réconcilié en version 2 ; `backend/scraper/scripts/start.sh` ne lance volontairement que PostgreSQL et n’applique aucune migration automatiquement. Ne démarre pas les services API/worker sur une base existante avant d’avoir vérifié une sauvegarde et l’état du schéma.

## Checks

```sh
npm run check:backend
npm run test:backend
npm run build
npm run lint
```

`npm run verify` runs all four commands. The frontend lint command requires its native Oxlint binary to be allowed by the host's Windows Application Control policy.

## Operations and security notes

- `GET /health` checks API-to-database connectivity; it does not prove public DNS, TLS, frontend, worker or backup health.
- The API redacts query strings from request logs to avoid retaining precise search coordinates.
- API rate limits are in-memory and per process. They are a basic abuse guard, not distributed rate limiting or DDoS protection; a cloud edge limit is required for public production.
- Active offers require verification and an end date. The end date is inclusive through that date in the `Europe/Paris` calendar. Public API queries hide an offer after its end date even if the background worker is delayed.
- Offer cleanup runs as part of `offers-worker` on its configured schedule. The worker must be running for status updates and retention deletion to happen.
- Existing databases need the manual migration at `backend/scraper/migrations/20261114_offer_validity_constraints.sql`. It was not run. It stops if existing rows violate the new constraints; inspect those rows and take a verified backup before applying it.
- Admin writes require `x-admin-token` matching `PLACES_ADMIN_TOKEN`. Keep the service private until HTTPS, secret storage, edge protection, backups and monitoring are configured.
- OpenStreetMap, Photon and third-party catalogue sources have their own attribution, usage and retention conditions. Review those before increasing collection volume.

## Cloud readiness status

The repository contains local development configuration, not an operational cloud deployment. No production service, database, DNS record, Vercel project, Cloudflare tunnel, scheduled cloud job, monitoring target or restore-tested backup is configured by these files. A zero-cost hosting plan must account for sleep policies, quotas, PostgreSQL/PostGIS compatibility, worker scheduling and backups before any production migration or deployment is approved.

See [the production readiness and hosting review](docs/production-readiness.md) for the read-only Vercel status, confirmed schema/security findings, current free-tier limits, recommended architecture and gated migration sequence.

## Prompt 26 PostgreSQL disposable runner — Docker tmpfs guard v2

The disposable PostgreSQL integration runner validates storage isolation using
both Docker configuration (`HostConfig.Tmpfs`, no binds/volumes/volumes-from)
and the live container mount namespace (`/proc/self/mountinfo`). It tolerates
an empty `docker inspect .Mounts` array only when the live PGDATA mount is
confirmed to be tmpfs with `rw,nosuid,nodev,noexec`; any persistent mount or
missing runtime tmpfs causes a fail-closed abort. The runner does not mount a
host path or a named Docker volume.


## Vérification et préparation release

- Preview local : `docs/preview-local.md`
- Checklist navigateur : `docs/browser-functional-checklist.md`
- Audit dépendances : `npm run audit:deps`, puis `npm run audit:deps:summary`
- Runbook et statut des validations : `docs/validation-runbook.md`
- Dépendances : `docs/dependency-security.md`
- Préparation production : `docs/production-readiness.md`
- Publication GitHub sur une branche dédiée : `docs/git-publication.md` et `scripts/publish-github-branch.sh`
- État réel, validations et travaux restants : `docs/current-status-2026-11-21.md`

Avant release, lancer `npm run verify:release` depuis la racine après `npm ci --prefix backend/scraper` et `npm ci --prefix frontend`. Cette commande effectue le lint, les tests, le build et le runner PostgreSQL jetable. Elle ne déploie pas.
