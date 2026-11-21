# MapNifique — validation runbook

**Purpose:** validate the repository and a disposable staging stack before any production migration or deployment. Never point a test command at production. No procedure in this file authorizes a cloud-resource creation, a DNS change, or a production deployment.

## Current evidence

| Area | Evidence available now | Remaining validation |
|---|---|---|
| Frontend | User run on 2026-11-20: Oxlint 0 warning/0 error, frontend unit tests 4/4 PASS. The build then failed with two TypeScript issues; `preview-fix` archive adds a declaration for `catalog-price.js` and a mutable `BrandOfferEntry` tuple. | Re-run `npm run build` on the `preview-fix` archive; no successful TypeScript/Vite build result has been supplied yet. Browser navigation, GPS permission states, responsive layout and iPhone Safari remain NOT TESTED. See `browser-functional-checklist.md`. |
| API and business logic | Backend Node tests exercise validation, SQL construction, empty responses, categories, deduplication, source attribution, offer validity/retention, worker leases, token comparison and rate limits. | Tests use mocked PostgreSQL interfaces for most route/query coverage; they do not establish live SQL or data quality. |
| PostgreSQL métier | Le runner Prompt 26 a été exécuté dans le workspace antérieur par l'utilisateur : `OVERALL=PASS` (migrations fraîches/historiques, identité, concurrence, backup/restore, tmpfs effectif). | Ce PASS précède l'archive `preview-fix`. `verify:full` du workspace hardening s'est arrêté avant l'étape PostgreSQL à cause du build frontend ; rejouer le runner sur la dernière archive après build PASS. |
| PostgreSQL/PostGIS OSM | Les requêtes du catalogue `osm_places` utilisent PostGIS et `pg_trgm`. | Le runner Prompt 26 utilise l'image officielle PostgreSQL simple et ne valide pas le catalogue OSM/PostGIS. |
| Collection | The crawler checks same-host URLs, observes `robots.txt`, caps concurrency/pages/rate and does not retry blocked pages. | No live collection, retailer-terms review per enabled source, scheduled cloud run, retry-after-restart, or cloud worker is verified. |
| Production/cloud | The hosting comparison is based on current official plan documentation. | No cloud resources, backups, alerts, stable API origin or production data migration have been created or verified. |

## 1. Repository checks

Run from the monorepo root with Node.js 22.13 or later:

```powershell
npm --prefix frontend ci
npm --prefix backend/scraper ci
npm --prefix frontend run lint
npm --prefix frontend run build
npm --prefix backend/scraper run check
npm --prefix backend/scraper test
npm --prefix backend/scraper audit --omit=dev
```

Record the exact test totals and audit advisories. Do not apply a major dependency change only to make the audit summary empty; confirm Crawlee compatibility and re-run the suite first.

## 2. Frontend and navigation smoke test

Use a local preview or a separately approved staging URL over HTTPS. Do not set a production API origin for a local test. Check:

1. Load the app with API access unavailable and confirm navigation remains usable, errors are understandable, and no sample commerce or offer is fabricated.
2. Open and close the places, offers and catalogue sections; use search input, clear and submit; verify selection opens the correct details and back/close actions restore the prior view.
3. Test geolocation allowed, denied, timed out and unavailable. Confirm the app falls back to map-centre search where appropriate and never claims an unknown location.
4. Test category filtering, empty results, API timeout, malformed response and cancellation of a stale search.
5. Test routes with and without a selected place and a location; verify loading, error, steps and map polyline states.
6. Load the Leaflet map and, when enabled, the lazy MapLibre map. Confirm attribution is visible and the selected tile provider matches its terms.
7. Test narrow and wide viewports, keyboard navigation, focus order and reduced motion.

Use real, licensed API data when checking place cards and offers. If no such staging data is available, mark data-backed flows **not verified**; do not insert invented shops or promotions.

## 3. Disposable PostgreSQL/PostGIS validation

### Migration-only check

`backend/scraper/migrations/validate-migrations.psql` creates only temporary `offers` and `scrape_jobs` tables in its psql session. It applies all three migration scripts, checks the lease-column backfill/index and all three offer constraints, exercises invalid/valid rows, and reapplies the migrations to check idempotency. The tables disappear when the psql session ends. It does not test the guarded migration against historical NULL IDs; inspect real data and keep the precondition check intact before planning that migration.

Run it only using an explicitly disposable local database (never production):

```powershell
psql --no-psqlrc --set=ON_ERROR_STOP=1 `
  --dbname="$env:MAPNIFIQUE_LOCAL_TEST_DATABASE_URL" `
  --file="backend/scraper/migrations/validate-migrations.psql"
```

The connection still needs to target a disposable local instance. Confirm the hostname, database name and port before running. This script does not validate the application's full baseline schema or PostGIS query plans.

### Full schema/query check

1. Inspect les extensions réellement requises. Les migrations `000`/`001`/`002` de base ne nécessitent pas PostGIS pour créer les tables métier ; les requêtes du catalogue `osm_places` utilisent en revanche PostGIS et `pg_trgm`.
2. Utilise une base de test neuve et des identifiants jetables. Ne copie pas les variables de production et ne dirige jamais `DATABASE_URL` vers un hôte cloud.
3. Pour le contrôle du schéma métier, `scripts/test-identity-db.sh` délègue à `scripts/test-prompt26-postgres.sh`. Le runner utilise `docker exec ... psql` ; `psql` n'a donc pas besoin d'être installé sur Windows/WSL. Il crée quatre bases temporaires, applique 000, 001, 002 et 003, exécute les validateurs SQL, rejoue 002, vérifie l'ancien DDL `places/offers`, un rollback PostgreSQL et deux sessions PostgreSQL concurrentes.
4. Le runner vérifie aussi le préflight GTIN historique en version 1 : un GTIN-13 valide doit être accepté avant normalisation, tandis qu'un GTIN invalide reste bloquant. En version 2, les GTIN stockés doivent être canoniques sur 14 chiffres.
5. Si le module Node `pg` existe déjà dans l'environnement, le runner exécute l'audit et l'exécution de réconciliation sur deux bases supplémentaires (dataset compatible et dataset conflictuel). Si `pg` est absent, il affiche `OVERALL=PARTIAL` et retourne le code 2 : les migrations SQL peuvent avoir réussi, mais la réconciliation n'est pas certifiée.
6. Ne confonds pas les tests de verrous SQL à deux sessions avec un test complet de deux workers applicatifs : les tests de finalisation/lease de l'application restent séparés et doivent être exécutés avec le driver `pg` disponible.
7. Applique ensuite la réconciliation sur des jeux distincts : base propre pour réussite, base avec anomalies pour refus/rollback. Ne passe pas la base incompatible en version 2.
5. Le serveur n'exécute plus de DDL au démarrage. Il refuse le démarrage tant que le schéma est en version 2 et que `assertPlacesSchemaReady()` ne confirme pas toutes les colonnes et contraintes lieux/offres.
9. La FK `offers.place_id` est vérifiée `ON DELETE RESTRICT`, cohérente avec `scope='store' => place_id NOT NULL`. Les insertions d'offres magasin doivent transmettre un `placeId`; les offres marque/en ligne gardent `place_id=NULL`.
7. Le test automatisé avec l'image officielle `postgres` ne valide pas le catalogue OSM/PostGIS. Toute validation des chemins `ST_DWithin`/`osm_places` nécessite une image PostgreSQL/PostGIS compatible approuvée et un jeu OSM synthétique ou correctement licencié. Tant que cette dépendance n'est pas disponible, classer ces contrôles BLOQUÉS plutôt que les déclarer réussis.
9. L'image officielle `postgres:17-alpine` déclare un volume de données. Le runner le recouvre par un unique `tmpfs` sur `PGDATA` : ce montage est éphémère et aucun volume Docker/bind mount persistant n'est autorisé. Vérifie les mounts avant le lancement.
12. Le runner détruit uniquement son propre conteneur à la sortie et conserve les logs dans `backups/prompt26-postgres-validation-*`. Jamais de base de production.

## 4. Real-data and offer checks

For every source, record the official source URL, reuse terms/licence, attribution requirement, `robots.txt` outcome for every host used, contact/user-agent policy, permitted request rate, cache rules and collection schedule before enabling it. Prefer official machine-readable catalogue/promotion endpoints and published open datasets. Offer collectors require a double opt-in: `OFFERS_ENABLED_SOURCES` and `OFFERS_SOURCE_LICENSE_APPROVED` must both include the source. Keep both empty until the written rights/robots/rate review is complete; retention/expiry still runs with no source enabled.

With an approved source in a disposable database:

1. Run a dry-run and retain its source URL, timestamp, parser warnings and item counts.
2. Compare detected items with the source page/API. Reject records missing a real title, source URL, or verifiable validity date; do not infer a discount from a price alone.
3. Verify `source_id`, `external_id`, `source_url`, provenance and retailer/place matching. Current collectors produce brand/online scoped promotions and associate them with place cards through `brandKey`; they do not claim a specific branch without a verified `placeId`. Re-run the same source and confirm uniqueness prevents duplicates.
4. Verify store-scoped offers reference an actual `places.id`; brand-level and online offers remain correctly scoped.
5. Test the inclusive `valid_until` date in `Europe/Paris`, next-day hiding, status expiration and one-year retention boundary with a disposable data copy and controlled clock.
6. Simulate interrupted collection and worker restart. Confirm leases prevent two workers from finalizing the same job and that retry counts/delays match configuration.
7. Force heartbeat loss during an active browser request. Confirm the worker stops enqueueing new URLs, waits for active handlers to leave their signal checks, aborts the crawler pool and lets the lease-based retry proceed without duplicate rows.

Do not increase scraping volume until each source's written terms and its service's published limits allow it. Public community endpoints are best-effort and are not a substitute for a durable owned catalogue at product scale.

## 5. Public API security checks

Before allowing public traffic in staging:

- Confirm `PLACES_ADMIN_TOKEN` is present only in server-side secret storage and every source/crawl/offer write plus crawl-status read rejects missing or incorrect credentials.
- Confirm the database has no public port, uses TLS/private networking where available, and the API role cannot alter schema or administer PostgreSQL.
- Exercise per-route rate limits and `429`/`Retry-After`; configure distributed edge limits because the in-process limiter resets at restart and is not shared across replicas.
- Verify request/body bounds, CORS allow-list, trusted proxy IPs, error responses, health-check scope and log redaction. Never log credentials or exact search coordinates.
- Verify only intended public read routes are exposed. Do not expose admin task errors, source configuration, stack traces, host paths or secrets.
- Inspect the built frontend and source map configuration for secrets. `VITE_*` values are public.
- Review current npm audit output and the documented minimatch/Crawlee advisory before release.

## 6. PWA, map and mobile checks

Serve a staging build over HTTPS. Verify manifest name, theme colours, 192/512 icons, favicon, Apple touch icon, service worker update, offline shell fallback and that `/api/*` is never cached. Offline shell availability does not imply offline search, offers or live map tiles.

Install the app through iOS Safari on a physical iPhone and through a supported desktop browser. Confirm safe-area layout, status bar, icon, launch URL, permissions and update behavior. Do not describe it as tested on iOS until this manual device test has passed.

The default OSM raster service is best-effort. Keep visible attribution, send normal browser referrers, honour tile caching, do not prefetch/offline-download tiles, and provide a way to change providers without embedding credentials in the client. Review each geocoding, routing and tile provider's own terms and quotas.

## 7. Backup, monitoring and restart checks

In staging, automate encrypted database dumps to storage independent of the primary VM, with a documented retention limit, access controls and spend/quota alerts. Restore a dump into a new test database and verify schema, indexes, expected row counts and representative API reads; a successful dump without a restore test is not evidence of recoverability.

Check API, database, frontend and worker health independently. Trigger an alert using a staging-only controlled failure. Restart each service and the whole host; confirm Compose/systemd/orchestrator restart policy, worker lease recovery, persistent database storage, scheduled-job resumption and alert delivery.

No production DNS switch, deployment, secret update or data migration is part of this runbook. Those actions require a separate owner-approved change plan after staging evidence is reviewed.


## Addendum 21 novembre 2026 — archive preview-fix et statut exact

- Les déclarations `fastify` et `@fastify/cors` ont été remontées aux versions stables déjà présentes dans le lockfile (Fastify 5.12.8, CORS 11.4.3) pour éviter une régression lors d'une nouvelle résolution. Le lockfile n'introduit pas de major update.
- Le finding `minimatch@9.0.9` reste ouvert et expliqué dans `dependency-security.md`; aucun override 11.x non validé n'est imposé.
- Les résultats de l'utilisateur pour le workspace hardening restent : lint PASS, backend check PASS, backend 217/217, frontend 4/4, build FAIL à deux erreurs TypeScript avant intégration du correctif `preview-fix`. La présence du correctif dans l'archive ne vaut pas preuve de build PASS.
- Le moteur d'exécution assistant ne disposait pas d'un registre npm/Docker accessible (DNS npm indisponible, pas de binaire Docker) ; les builds et intégrations doivent être exécutés dans le WSL de l'utilisateur ou CI.
- Les tests navigateur sur cette archive n'ont pas été exécutés ; Browser Use n'a pas pu démarrer faute de crédits de navigateur. Utiliser le procès-verbal `browser-functional-checklist.md`.
- `verify:full` du monorepo exécute lint, tests et build puis PostgreSQL. Le runner SQL ne s'exécute pas si le build échoue ; lancer le runner séparément uniquement après un build vert, sur son conteneur jetable.
