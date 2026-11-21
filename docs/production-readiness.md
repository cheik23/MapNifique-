# MapNifique — readiness and hosting decision

**Review date:** 2026-11-14
**Repository:** `cheik23/MapNifique`, branch `main`
**Scope:** source/configuration review, local checks, and read-only review of the existing Vercel project. No production service, database, DNS record, secret, or cloud resource was changed.

## Decision

There is no verified zero-euro option that guarantees continuous service, durable PostGIS, and the current Playwright scraper without a home computer. The most compatible free experiment is a Cloudflare Pages frontend plus an Oracle Always Free ARM VM running the existing Docker services, with encrypted PostgreSQL dumps in R2. It is still **best effort**: Oracle can reclaim idle free compute, free capacity may be unavailable, and no service-level guarantee applies.

The first paid baseline worth evaluating is a cloud VM for the Fastify API and workers plus managed PostgreSQL/PostGIS with automatic backups. A single API VM remains a single point of failure. A higher availability target needs at least two application instances, a managed database with an appropriate SLA, independent backup/restore tests, and a budget agreed by the owner. It cannot promise literal 100% uptime.

No resources have been created. MapNifique is not yet operationally independent from the temporary API origin.

## What is operating now

- The Vercel project `mapnifique` is on the Hobby plan. Its latest production deployment is marked `READY`; `https://mapnifique.vercel.app` returned HTTP 200 and the expected HTML shell during the earlier read-only check.
- The Vercel production setting for the frontend API origin points to a `trycloudflare.com` host. Its value is intentionally not recorded here. The API `/health` request failed from this work environment; the cause and the origin machine were not established.
- A `trycloudflare.com` hostname identifies a **Quick Tunnel**, which Cloudflare documents as temporary and for testing/development. The URL works only while the `cloudflared` process and origin server are running; anyone who knows the URL can reach the service unless an additional access gate is configured. It is not a named tunnel and is not a production hosting plan. [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- Read-only Vercel Git context reports that this project is linked to `cheik23/MapNifique-`, not this repository `cheik23/MapNifique`. The latest deployment source is reported as `redeploy`. This repository push should therefore not trigger that Vercel project's Git deployment based on the metadata observed; no Vercel setting was changed.
- Compose currently defines PostgreSQL/PostGIS, Fastify API, scraper worker, offers worker and an optional OSM sync service. It binds the API to loopback and does not publish the database port. It is local development configuration, not a production deployment.
- The app already has a React/Vite frontend, MapLibre, search/category UI, route UI and offer/catalogue UI. Favorites are stored in browser `localStorage`; there is no account service or cross-device favorite sync. A catalogue view can be empty; no real offer feed was verified in this work.
- No cloud worker, hosted PostGIS database, public stable API origin, cloud scheduler, restore-tested backup, or availability alert has been verified for this repository.

## Confirmed implementation findings

**Prompt 25 working-patch update (not yet applied to the Windows workspace):** tables `places`, `offers` and `offer_sync_runs` are moved from runtime DDL to migration `20261120_002_places_offers.sql`; API/worker startup now perform read-only schema checks. The test script invokes the container's `psql` via `docker exec` and no longer requires a host `psql` executable. These code changes still require actual PostgreSQL execution before being considered SQL-validated.

1. The search SQL read `places.location`, but `initPlacesDb()` creates `places` with `lat` and `lon` and no `location` column. This breaks the local SQL search against a fresh schema. The SQL now constructs geography from `lon`/`lat` instead; regression assertions were added. A live PostGIS execution was not available, so SQL execution still needs an integration test.
2. Search SQL also reads `public.osm_places`. The normal Compose start does not run `osm-catalog-init.sql`; the optional `osm-sync` loop only runs replication updates and does not perform the initial PBF import or initialize replication state. A database lacking the OSM catalog therefore cannot satisfy the SQL search. Intelligent search now continues to Photon/Overpass after local SQL failure, with an explicit warning in its response. This is a fallback, not a replacement for a verified and populated database.
3. `osm-catalog-init.sql` now enables `postgis` and `pg_trgm` before defining its catalog schema. This SQL was not executed against any database. Initial extract loading, replication-state creation, and licensing/attribution review remain operational tasks.
4. Scraper recovery has a lease heartbeat, per-attempt lease token, delayed retry (up to three attempts by default) and stale-job reclaim logic. A heartbeat failure or lease loss now signals the crawler; it stops scheduling work, allows active request handlers to observe the signal and finish, then aborts the pool. This is unit-tested but has not been exercised with a live browser or PostgreSQL. The additive migration `backend/scraper/migrations/20261114_scrape_job_leases.sql` is required on an existing database and was not executed. No real PostgreSQL crash/reclaim scenario was run.
5. The offers validity and stable-identifier changes require manual migrations in `backend/scraper/migrations/`. Existing production rows were not inspected, and none of the three migration scripts was run. The new external-ID migration deliberately stops if it finds NULL, blank or oversized IDs; it does not invent identifiers. Public API queries hide an offer from the day after `valid_until` in Europe/Paris; a background worker must still be live for status updates and one-year deletion.
6. **Fixed in the Prompt 25 working patch, pending live PostgreSQL validation:** migration `20261120_002_places_offers.sql` standardizes `offers.place_id` to `ON DELETE RESTRICT`, preserving the `scope='store' => place_id IS NOT NULL` invariant. The startup check verifies the FK action and the store-scope check constraint. No deletion API is added.
7. Offers could previously omit `external_id`; PostgreSQL permits multiple NULLs in the existing `(source_id, external_id)` unique key, so repeat collection could create duplicates. API writes and the worker now require a stable, bounded ID, and newly created schemas enforce it. Existing schemas need the guarded manual migration above. No historical rows were available to test the migration precondition.
8. Admin writes use a shared `PLACES_ADMIN_TOKEN`. During this review, `GET /api/crawls/:id` was confirmed public and returned internal error text. It now requires the same constant-time token check, and its requests use the stricter admin rate-limit bucket. This remains a single shared credential rather than a multi-user admin identity system.
9. The API limiter is bounded but in memory and per process. Restarts reset it and multiple replicas do not share counters. Production needs an edge/WAF rate limit, request/body limits, server-side secrets, private DB networking and least-privilege DB roles.
10. Fastify request logging strips query strings, which reduces location leakage in application logs. Proxies, CDN and hosting access logs may still record full query URLs. Consider moving precise coordinates to request bodies or configuring provider-side log redaction and short retention.
11. The front end's Vite `VITE_*` settings are public by design; none may contain credentials. The admin token and DB credentials must remain in server-side secret storage.
12. Current offer collectors reference Lidl and Franprix endpoints/pages, but a clear reuse licence was not found, and Franprix's `robots.txt` could not be checked from this environment. In the Prompt 25 working patch, activation requires both `OFFERS_ENABLED_SOURCES` and `OFFERS_SOURCE_LICENSE_APPROVED`; both are empty by default. Do not approve or enable a source until its rights, robots rules and request limits are documented.

## Hosting comparison

Values below are the official published plan limits checked on 2026-11-14; providers can change them. Free does not mean an uptime promise.

| Option | Price and limits | Docker / PostGIS | Workers, schedule and browser collection | Sleep, backups and practical fit |
|---|---|---|---|---|
| **Oracle Cloud Always Free** | $0 for eligible resources: up to 2 OCPU + 12 GB RAM ARM A1 compute; 200 GB combined block volume; five block-volume backups. Home-region capacity can be unavailable. Oracle may reclaim an instance idle for 7 days under stated CPU/network/memory thresholds. Free resources have no production SLA/support guarantee. A card/account verification may be required. [Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm), [FAQ](https://www.oracle.com/cloud/free/faq/) | Yes, on an Ubuntu ARM VM. PostgreSQL/PostGIS can be self-managed in Docker. Existing `node:22-bookworm` + Playwright/Chromium image has **not** been built or run on ARM; compatibility and memory use are unverified. | Long-running Fastify, Playwright and workers can run in Docker; use systemd/Compose restart policies and the offers worker schedule. OSM needs an initial import before replication. | Most compatible with the existing stack at $0, but no always-on guarantee, potential capacity/reclamation and the VM remains a single point of failure. Use offsite encrypted R2 backups; Oracle's own five backups are not independent. Best free prototype, not a guaranteed public service.
| **Cloudflare Pages + Workers / Queues / Cron** | Static Pages Free: 500 builds/month, one concurrent build, 20,000 files/site and 25 MiB/file. Workers Free: 100,000 requests/day, 10 ms CPU/invocation, 128 MB memory and 5 Cron triggers/account. Queues Free: 10,000 operations/day, 24-hour retention. R2: 10 GB-month, 1M Class A + 10M Class B operations/month; Internet egress is free. R2 account activation goes through a subscription checkout flow; stay within the free meter and set billing controls before use. [Pages limits](https://developers.cloudflare.com/pages/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Queues](https://developers.cloudflare.com/queues/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) | Static frontend and JavaScript/TypeScript Workers yes; no Free Docker containers for the current Fastify image. A Worker API is a rewrite. No native PostgreSQL/PostGIS database; connect to external managed PostgreSQL. | Cron/Queues consumers have bounded invocations; they are not a persistent Playwright service. Browser Run Free allows 10 minutes/day and 3 concurrent browser sessions, too little for general collection. [Browser Run limits](https://developers.cloudflare.com/browser-run/faq/) | Static assets do not sleep and Workers run on demand, but quota exhaustion can reject work. Useful for frontend, edge checks, a rewritten small API, queues and offsite backups; not sufficient alone for the current API, DB and scraper.
| **Vercel Hobby** | $0; includes 1M function invocations, 4 active CPU-hours and 360 GB-hours provisioned memory (published quota). Hobby is limited to personal, non-commercial use. [Hobby](https://vercel.com/docs/plans/hobby), [limits](https://vercel.com/docs/limits) | Static Vite yes. Vercel supports Dockerfile-based HTTP containers in Functions, but they are stateless autoscaling functions and scale to zero. It is not a permanent worker host. [Container functions](https://vercel.com/docs/functions/runtimes/container) | Hobby Cron is at most once daily with ±59-minute precision; not enough for a six-hour worker schedule. Browser scraper in short functions is a poor fit. [Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) | No DB backup or PostGIS service by itself. Can remain an independent static frontend if usage is eligible, but cannot meet the current backend/worker requirement and commercial-use restriction must be assessed.
| **Supabase Free / Pro** | Free: $0, 500 MB DB, shared 500 MB RAM, 5 GB egress, 1 GB storage; two active projects; Free projects may pause after 7 days of low activity; no automatic backups. Pro: $25/month, includes $10 compute credits (enough for one Micro project), 8 GB disk, 250 GB egress, daily backups retained 7 days; no auto-pause. [Pricing](https://supabase.com/pricing), [pause policy](https://supabase.com/docs/guides/platform/free-project-pausing), [backups](https://supabase.com/docs/guides/platform/backups) | PostgreSQL and PostGIS supported; no general-purpose Docker host. [PostGIS](https://supabase.com/docs/guides/database/extensions/postgis) | Edge Functions are short event/serverless functions; not a long-running Playwright scraper/worker. Needs a separate scheduler/worker host. | Free is unsuitable for guaranteed public production. Pro is a viable managed PostGIS component; daily backups are useful but still require restore drills and preferably a second copy offsite.
| **Neon Free / paid usage-based** | Free: $0, no credit card required, 100 projects, 100 CU-hours/project/month, 1 GB/project, up to 2 CU. Compute scales to zero after 5 minutes idle. It does not inactivity-pause the project, but at the default 0.25 CU a continuously active DB needs about 182.5 CU-hours/month, above the 100-CU-hour quota. [Pricing](https://neon.com/pricing) | Managed PostgreSQL with PostGIS available; cannot host the existing Docker scraper. [PostGIS](https://neon.com/docs/extensions/postgis) | Neon Functions are not a general-purpose Playwright worker service. Pair it with a separate compute/scheduler platform. | Good for staging or intermittent low-volume access; free quota and scale-to-zero prevent an always-on guarantee. Exports to independent object storage must be scheduled and restore-tested; free plan does not include a continuous always-on managed compute budget.
| **Render Free** | $0 web service; 750 free instance-hours/workspace/month; 1 GB Postgres. | Docker web service supported; PostGIS version/extension and resource suitability need validation. | Web services sleep after 15 min idle and take about a minute to restart; free service cannot run one-off jobs. | Free Postgres expires after 30 days, has no backups; Render explicitly says not to use Free services for production. Reject for production. [Free limits](https://render.com/docs/free)
| **Google Cloud Run Free Tier** | Up to 2M requests/month, 360k GB-seconds memory, 180k vCPU-seconds and 1 GB North American egress; a billing account is required and overages are chargeable. [Free tier](https://docs.cloud.google.com/free/docs/free-cloud-features) | Docker/OCI HTTP service yes; no included managed PostGIS database. Cloud SQL is separately paid. | Request/event-driven jobs can run within quota but scale to zero. A scheduled service still needs Cloud Scheduler/other trigger and database; worker time/egress can exceed free allowance. | Not always-on, North-America-only egress allowance, billing/overage risk. Good for trials, not the required guarantee.
| **GitHub Actions** | GitHub Free private repositories have an included monthly compute dollar allowance; excess can be billable unless a spending budget stops it. [Included usage](https://docs.github.com/en/billing/reference/product-usage-included) | CI runners support Docker; not a durable host or database. | Good for tests and builds. Scheduled actions can be delayed or dropped under load, so not production scheduling/worker infrastructure. [Schedule behavior](https://docs.github.com/en/actions/how-tos/troubleshoot-workflows) | Keep for CI only. The repository workflow added here has no deployment step; GitHub Actions billing budget settings are not inspected.

### Architecture A — best free, no guarantee

```mermaid
flowchart LR
  U[Browser] --> CF[Cloudflare Pages: static Vite frontend]
  CF -->|HTTPS through Cloudflare edge| VM[Oracle Always Free ARM VM]
  VM --> API[Fastify API container]
  VM --> DB[(PostgreSQL + PostGIS container)]
  VM --> W[Scraper and offers workers]
  W --> DB
  VM --> CRON[OS scheduler / worker schedule]
  DB -->|encrypted daily dumps| R2[Cloudflare R2 offsite backup]
  UP[UptimeRobot Free: 5-minute checks] --> CF
  UP --> API
  GH[GitHub Actions: CI only] -->|tests / build| MAIN[GitHub main]
  MAIN -. approved manual release only .-> CF
```

UptimeRobot Free currently lists 50 monitors and 5-minute checks; this detects some failures but does not guarantee recovery or an SLA. [Pricing](https://uptimerobot.com/pricing/). Daily backup, retention, encryption, alert destinations and restoration must be configured and tested. R2 free limits are not unlimited; storage/operations above them cost money.

### Architecture B — paid baseline and availability ceiling

```mermaid
flowchart LR
  U[Browser] --> CF[Cloudflare Pages / edge]
  CF -->|HTTPS| API[Cloud VM: Fastify API]
  CF -->|HTTPS| API2[Second API instance for failover]
  API --> DB[(Managed Supabase PostgreSQL + PostGIS)]
  API2 --> DB
  W[Cloud VM worker(s): Playwright / offer jobs] --> DB
  DB -->|daily managed backup + separate encrypted dump| R2[Offsite object storage]
  MON[External uptime checks + alerting] --> API
  MON --> API2
  GH[GitHub Actions CI] --> GHRELEASE[Manual, gated release]
```

An indicative Hetzner CX33 list price after the 2026-06 price change is €8.49/month excluding VAT plus €0.50/month for primary IPv4 (or free IPv6). The public Cost-Optimized page currently marks CX33 unavailable, so this is **not a confirmed orderable quote**. [Price change](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [IPv4 price](https://docs.hetzner.com/cloud/servers/primary-ips/overview/). Supabase Pro adds $25/month before applicable taxes/extra usage, producing a starting component total of **€8.99 + $25/month before tax**, if capacity is orderable. A second similarly sized API VM approximately doubles the VM component. Domain registration, possible tax/currency conversion, higher compute/storage/egress, email, monitoring upgrades and recovery storage can add cost.

Hetzner publishes a 99.9% monthly “commercially reasonable efforts” SLA for a Cloud Server, with credit only after the threshold; one VM is still a single point of failure. The estimate is a practical baseline, not a 100% uptime promise. [Hetzner Cloud SLA](https://docs.hetzner.com/general/company-and-policy/slas-cloud/). For a stronger target, use redundant app instances, managed DB with the required plan/SLA, health checks, tested restore and an owner-approved budget. The minimum cost for a true multi-zone design is not determined without region, traffic, data size and recovery-time targets.

## Security and privacy gates before public API exposure

- Keep database networking private. Public users should reach only the HTTPS frontend/API, never PostgreSQL.
- Move `PLACES_ADMIN_TOKEN` to cloud secret storage, use a high-entropy value, rotate it, and limit admin access further (identity-based auth, IP/WAF rule or a private admin path). Do not add it to `VITE_*`, Git, build artifacts, logs, or URLs.
- Split public read access from admin writes. Introduce account authentication only if user-synced favorites are added; current favorites are local to one browser. Do not create accounts/PII until purpose, retention, deletion/export and provider responsibilities are chosen.
- Add a distributed edge limiter/WAF; current per-process counters do not protect multiple replicas or volumetric traffic. Set ceilings for search radius/page size, request body size and external provider fan-out.
- Verify that `GET /api/crawls/:id` rejects missing/incorrect admin credentials and that authorized responses/logs do not expose unnecessary internal paths, upstream URLs or exception details. Public source catalog visibility should be deliberate.
- Reduce exact GPS data in URLs and logs. Fastify redaction does not prove that Vercel, Cloudflare or other upstream access logs omit query strings. Use TLS and a short, documented retention period.
- Give the runtime database role only required read/write privileges. A separate migration/admin identity should own schema changes; current startup code executes `CREATE TABLE`/`ALTER TABLE`, so production role separation needs a migration/startup design before launch.
- Keep backups encrypted, off-host, access-controlled and independent from the primary VM. Verify a restore into a separate test database; a successful dump alone is not a restore test.
- Review OSM attribution/licensing and tile, Photon, Nominatim, Overpass, route and catalogue-provider usage limits before increasing traffic or collection. Third-party availability and service policies remain external dependencies.

## Vulnerability review: minimatch / Crawlee

`npm audit --omit=dev` on `backend/scraper` reported **12 moderate dependency-tree findings**, all cascading through the Crawlee dependency tree to `minimatch@9.0.9`. The current advisory database range is `>=7.0.0 <11.0.1`; `11.0.1` is fixed. npm's suggested remediation changes Crawlee to an older breaking version and is not an acceptable safe fix. Crawlee 3.18.2 requires `minimatch ^9.0.0`, while the fixed 11.x version is a major change. [GitHub advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249)

No override or major dependency upgrade was applied. The vulnerable code path is specific to `optimizationLevel >= 2`; minimatch defaults to level 1. The app calls Crawlee `enqueueLinks` with a same-domain strategy and a transform callback, without caller-controlled `include`/`exclude` globs. Configured `product_url_regex` values are JavaScript regular expressions, not minimatch globs, and source configuration is admin-only. No public attacker-controlled minimatch glob was found in the app path reviewed. This reduces demonstrated reachability but does not remove the npm advisory. Keep the moderate findings documented and re-evaluate after a compatible upstream release.

## Migration and release order

1. Owner chooses the free best-effort route or approves a monthly cost ceiling and availability target for the paid route. No resources should be created before this choice.
2. Build and integration-test a disposable cloud-compatible staging stack; first verify `places`/PostGIS schema, OSM bootstrap, source coverage, offer-to-place links, retention boundaries, retries, Docker ARM/x86 compatibility and restart behavior.
3. Define controlled schema migrations, inspect a sanitized production-shaped export, and take a verified backup before any live migration. Apply nothing to an existing production database until the owner approves the exact migration and backup/rollback plan.
4. Provision staging resources only after owner approval. Store secrets in server-side platform storage, make the database private, enable edge protections, set spend limits and deploy from GitHub with CI checks. CI is not production cron.
5. Configure import/scraping schedules, lawful source limits, one-year expiry cleanup, encrypted external backups, restore drills, availability alerts and worker restart/retry semantics. Test each automatically after restart and after simulated failure.
6. Run browser-to-API-to-PostGIS end-to-end checks from desktop and mobile, including map tiles, GPS permissions, search, offers, routes, error states and an empty database. Confirm real data and sources, not fixture-only results.
7. Present the new staging URLs, health checks, backup restore evidence, cost quotas and rollback procedure. Obtain separate owner approval before production deployment, changing the production API setting or DNS, or retiring the Quick Tunnel.
8. Switch traffic only after all gates pass. Keep the previous origin available through a defined rollback window; remove it only after a verified production period and owner approval.

## Snapshot historique — tests et limites au 14 novembre 2026

Les chiffres ci-dessous décrivent la revue initiale du 14 novembre, pas l’état de la dernière archive. Les mises à jour des 20–21 novembre sont consignées dans les addenda qui suivent.

- Backend: `npm test` passed **113/113** tests and `npm run check` passed after the API/admin, stable offer-ID and crawler lease-stop changes.
- Frontend: `npm run lint` passed with **0 warnings** and `npm run build` passed. The entry JavaScript is 431.73 kB (131.55 kB gzip), down from 1,130.58 kB (322.19 kB gzip). MapLibre is now a conditional 1,103.48 kB chunk; its map worker is 519.18 kB. Vite still reports those optional map chunks above 500 kB. The entry bundle fell by about 62% uncompressed; the map library remains a separate large download when that engine is selected.
- Production dependency audit: frontend reported no production advisories; backend reported the moderate Crawlee/minimatch tree above. No risky upgrade was applied.
- GitHub Actions workflow is added but has not run on GitHub yet. It performs CI only; no deploy step exists.
- No local PostgreSQL client/server or listener on port 5432 was found. The Docker CLI exists but its engine is unavailable; Windows Application Control was not bypassed. `backend/scraper/migrations/validate-migrations.psql` is a repeatable check using temporary tables only, but it has **not** been run. No local Chromium executable was available for a browser-navigation smoke test. No ARM image build, live PostGIS query test, production DB introspection, migration execution, scraper browser run, scheduled cloud job, backup restore, mobile browser test or new cloud deployment was completed.
- The API health request did not succeed from this environment. It is not valid to claim the current API is down or up based solely on that failed request.

---

## Addendum du 20 novembre 2026 — tests PostgreSQL Prompt 26 et durcissement

Depuis la revue initiale du 14 novembre, l'utilisateur a exécuté avec succès le runner `test:postgres:prompt26` dans WSL avec Docker Desktop, PostgreSQL 17, Node 22.23.1 et `pg` disponible. Le résultat final communiqué est `OVERALL=PASS` après vérification du `tmpfs` réel, migrations fraîches et historiques, validations identité/places/offres, verrous à deux sessions, upserts concurrents, réconciliation propre et conflictuelle, sauvegardes/restaurations et cas d'échec de `pg_dump`. Le conteneur jetable a été supprimé. Ces tests ne modifient ni ne certifient une base de production.

Une continuation du backend ajoute en outre : validation des entiers et bornes des paramètres d'administration/API/configuration ; validation d'origine stricte des URL de collecte (protocole, hôte et port) ; refus des IP littérales/domaines internes/ports personnalisés dans la configuration de source ; refus de stage après une redirection hors origine ; permissions privées `0600` des dumps et sidecars de backup ; couverture des tests unitaires frontend dans la commande `verify` et la CI.

Les contrôles locaux de cette copie : `npm run check` backend PASS, syntaxe Bash PASS, 208/208 tests backend passés hors des deux fichiers qui ne se chargent pas sans dépendances `pg`/`fastify`, tests frontend unitaires 4/4 PASS. Le build frontend et le lint n'ont pas été relancés ici car les dépendances frontend ne sont pas installées dans l'environnement de vérification. Le runner PostgreSQL doit être rejoué après intégration du contrôle additionnel des permissions de backup `0600`.

### Dépendances — point restant documenté

Le lockfile backend a précédemment donné 12 vulnérabilités modérées associées à `minimatch@9.0.9` dans l'arbre Crawlee. L'advisory GHSA-g3hv-75wg-m249/CVE-2026-118764 corrige le problème à partir de `minimatch@11.0.1` ; l'explication technique implique une amplification de `globparts` lorsque `optimizationLevel >= 2`. La version stable `crawlee@3.18.2` reste le tag npm `latest` observé le 20 novembre 2026, tandis que Crawlee 4.0 est encore en RC/beta. Un override v11 dans l'arbre v9 ou un saut vers Crawlee 4 RC serait une modification majeure non validée : aucun `npm audit fix --force` n'a été utilisé. Refaire l'audit JSON backend/frontend avec le registre npm disponible et attendre une version stable compatible de Crawlee avant de changer cet arbre. Cette alerte modérée reste ouverte ; les garde-fous applicatifs réduisent l'exposition, sans constituer une suppression de l'advisory.

Les sources Lidl et Franprix restent désactivées tant que les droits de réutilisation, la politique robots.txt, l'attribution et les limites de collecte ne sont pas explicitement approuvés et consignés. Aucun déploiement, commit, push, changement de secret, migration de production ou modification de base réelle n'a été fait.

## Revue d'état — 21 novembre 2026

### Validation de l'archive

- Le workspace `preview-fix` contient les deux corrections TypeScript signalées dans le précédent run : déclaration `catalog-price.d.ts` et tuple mutable `BrandOfferEntry`.
- Le build post-correction n'est pas certifié : aucun résultat `tsc -b && vite build` réussi n'a encore été fourni. Ne pas confondre le correctif présent dans l'archive avec une compilation validée.
- Les résultats WSL antérieurs restent bons pour Oxlint (0 warning/error), backend (217/217) et frontend (4/4). Le runner PostgreSQL antérieur a donné `OVERALL=PASS` dans un workspace précédent ; il reste à rejouer sur `preview-fix` après build PASS.
- Le test navigateur end-to-end n'a pas été exécuté sur cette archive. L'adresse locale Vite est documentée dans `preview-local.md`; le procès-verbal à remplir est `browser-functional-checklist.md`.

### Dépendances

Le lockfile backend utilise Fastify 5.12.8 et `@fastify/cors` 11.4.3. Le `package.json` est désormais aligné sur ces versions minimales sans changement de major. `crawlee`/`@crawlee/core` restent sur la version stable 3.18.2, dont l'arbre contient `minimatch@9.0.9`. Le finding GHSA-g3hv-75wg-m249 (CVE-2026-118764) reste documenté : le correctif est en 11.0.1, mais aucun override majeur n'est appliqué sans test d'intégration Crawlee. Voir `dependency-security.md`.

### Vercel — revue en lecture seule

Le projet Vercel `mapnifique` expose les domaines `mapnifique.vercel.app` et `mapnifique-g-c35c.vercel.app`. Le dernier déploiement retourné par l'API Vercel était `READY`, source `redeploy`, mais les métadonnées Git ne permettaient pas de relier ce déploiement à cette archive `preview-fix`. L'API du site public n'a pas pu être inspectée ici ; l'outil navigateur de test public n'a pas démarré faute de crédits disponibles. En conséquence, ces domaines ne sont **pas** validés comme preview du code récent et aucune URL publique de l'archive n'est certifiée.

Aucun push Git, aucun changement de projet Vercel, aucune création de cloud, aucun DNS, secret ou déploiement n'a été effectué.

### Garde-fous de mise en production

La configuration Compose actuelle est une configuration locale : elle expose l'API uniquement sur `127.0.0.1:8787` et conserve PostgreSQL sur un volume local persistant. Elle n'est pas une infrastructure publique permanente. Avant mise en production, il faut encore un endpoint API stable en HTTPS, un PostgreSQL/PostGIS privé et durable, un rôle DB runtime moins privilégié que le rôle de migration (le démarrage actuel exécute encore certains contrôles/DDL), des secrets côté serveur, une planification durable des workers, des sauvegardes chiffrées hors hôte avec test de restauration, des alertes de disponibilité, une politique de logs/rétention, et la validation des licences/robots des sources d'offres.

Le choix entre gratuit best-effort et hébergement payant/managed doit inclure un plafond de coût mensuel et un objectif de disponibilité. Aucun service cloud payant ou gratuit n'a été créé dans cette passe.
