# Backend MapNifique Scraper

Backend complémentaire de `frontend/`: API Node.js/Fastify, PostgreSQL/PostGIS et workers de collecte. Le frontend utilise les mêmes routes publiques `/api/search/intelligent`, `/api/offers`, `/api/offers/brands`, `/api/discover` et `/api/route`.

## Prérequis

- Node.js 22.13 ou ultérieur et npm.
- Docker Engine/Desktop avec Docker Compose v2.

## Démarrage local

Depuis `backend/scraper/`, le script `scripts/start.sh` génère des secrets locaux aléatoires si `.env` n'existe pas. Le fichier `.env` reste privé et ignoré par Git.

```bash
bash scripts/start.sh
```

Le script démarre d'abord **PostgreSQL uniquement**, attend son état `healthy`, puis vérifie la version 2 du schéma et les fonctions de contrôle. Il ne démarre l'API et les workers que si ces contrôles réussissent. En l'absence de migrations, il s'arrête en donnant les étapes nécessaires : aucune migration ni réconciliation n'est exécutée automatiquement.

Pour préparer une base locale neuve, démarre d'abord uniquement PostgreSQL :

```bash
docker compose up -d db
```

Après avoir vérifié que cette base est bien la base locale dédiée et que les sauvegardes requises existent, applique manuellement les migrations dans l'ordre :

```bash
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < migrations/20261120_000_baseline_schema.sql
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < migrations/20261120_001_product_identity.sql
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < migrations/20261120_002_places_offers.sql
docker compose exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < migrations/20261120_003_identity_reconcile_preflight.sql
```

Exécute ensuite le mode `reconcile:audit` avec une configuration explicitement limitée à cette base locale. Examine et résous les problèmes avant toute réconciliation d'exécution. Le mode `reconcile:execute` n'est jamais lancé automatiquement. Lorsque la réconciliation contrôlée a abouti en version 2, relance `bash scripts/start.sh` pour démarrer les services applicatifs.

**Ne lance pas `docker compose up -d --build` sur tous les services avant que le schéma soit prêt** : l'API et les workers refusent intentionnellement de démarrer hors version 2.

Les migrations de schéma sont donc appliquées manuellement, dans cet ordre :

1. `migrations/20261120_000_baseline_schema.sql`
2. `migrations/20261120_001_product_identity.sql`
3. `migrations/20261120_002_places_offers.sql`
4. `migrations/20261120_003_identity_reconcile_preflight.sql`
5. audit, revue, puis réconciliation contrôlée vers la version 2.

La migration 003 conserve la compatibilité de préflight avec les GTIN historiques GS1 valides en 8, 12, 13 ou 14 chiffres avant réconciliation. En version 2, les GTIN stockés doivent être canoniques sur 14 chiffres. Elle ne change pas la version du schéma et ne réécrit aucune donnée.

## Validation PostgreSQL temporaire

Depuis WSL Ubuntu, avec l'intégration Docker Desktop activée, exécute :

```bash
bash -n scripts/test-identity-db.sh
bash scripts/test-identity-db.sh
```

Le script `test-identity-db.sh` délègue à `scripts/test-prompt26-postgres.sh`. Il crée quatre bases dédiées dans un conteneur PostgreSQL 17 officiel, avec `PGDATA` sur tmpfs (aucun volume Docker persistant) et port hôte publié uniquement sur loopback. Il teste les migrations fraîches, l'ancien DDL `places/offers`, les validateurs SQL, la réexécution de la migration 002 et le préflight GTIN v1/v2. Si le module Node `pg` est disponible, il teste aussi l'audit/réconciliation propre et le refus d'un jeu conflictuel. En son absence, le résultat global reste `PARTIAL` et le script retourne le code 2 : les migrations SQL réussies ne sont pas présentées comme une réconciliation complète.

**Ce runner n'est prévu que pour les bases jetables Prompt 26. Ne change pas ses noms de bases, son nom de conteneur ou son image vers une infrastructure réelle.**

L’API est publiée uniquement sur `127.0.0.1:8787` pour le développement local; PostgreSQL n’a pas de port hôte publié. Le serveur Vite du monorepo relaie `/api` vers cette adresse. Photon utilise `https://photon.komoot.io` par défaut; `PHOTON_URL` peut pointer vers une instance que tu contrôles.

Vérifier l’API et les tests sans démarrer Docker :

```bash
npm run check
npm test
```

Depuis la racine du monorepo, les équivalents sont `npm run check:backend` et `npm run test:backend`.

## Synchronisation OSM facultative

Le service Compose `osm-sync` est désactivé par défaut. Pour l’activer, placer `osm-pilot.lua` et `osm-sync.pgpass` dans le dossier local `data/` ignoré par Git, ou définir `MAPNIFIQUE_DATA_DIR` dans `.env` vers un répertoire local contenant ces fichiers. Protéger `osm-sync.pgpass` (mode `600` sous Linux), puis lancer :

```bash
docker compose --profile osm-sync up -d osm-sync
```

Aucun de ces fichiers ni les extraits PBF ne sont requis pour la recherche Overpass/Photon standard ou pour les builds. Les fichiers de données OSM, secrets, volumes et sauvegardes locales ne doivent pas être ajoutés au dépôt.

Le service de réplication ne réalise pas l’import initial d’un fichier PBF et ne crée pas l’état de réplication à lui seul. Il suppose un schéma/catalogue OSM et un premier import déjà préparés. `scripts/osm-catalog-init.sql` prépare les tables et extensions, mais son exécution ne remplace pas l’import initial. Le parcours complet d’initialisation n’a pas encore été validé sur une base jetable.

## Endpoints d’administration

Les routes `POST /api/sources`, `POST /api/crawls`, `GET /api/crawls/:id` et `POST /api/offers` exigent l’en-tête `x-admin-token`, comparé à `PLACES_ADMIN_TOKEN`. Les routes de lecture publique comprennent `/api/products`, `/api/places`, `/api/offers` et les routes de recherche. Toute offre écrite doit avoir un `externalId` stable afin que `(source_id, external_id)` assure une mise à jour idempotente. Exemple local après avoir chargé `.env` sans l’imprimer :

```bash
set -a; . ./.env; set +a
curl -X POST http://127.0.0.1:8787/api/sources \
  -H 'Content-Type: application/json' \
  -H "x-admin-token: ${PLACES_ADMIN_TOKEN}" \
  -d '{"id":"mon-enseigne","name":"Mon enseigne","baseUrl":"https://www.exemple.fr","requestsPerMinute":12,"sameDomainDelaySecs":2,"maxPagesPerRun":100}'
```

N’utilise pas d’enseigne avant d’avoir vérifié ses conditions d’utilisation, droits de réutilisation et règles `robots.txt`. Le scraper ne contourne pas les CAPTCHA, connexions, restrictions techniques ou blocages.

## Protection de l’API

Le serveur applique des limites par adresse IP et par processus : 180 requêtes publiques, 90 requêtes de recherche et 30 écritures administrateur par fenêtre de 60 secondes par défaut. Les variables `API_RATE_LIMIT_PER_MINUTE`, `SEARCH_RATE_LIMIT_PER_MINUTE`, `ADMIN_RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_WINDOW_MS` et `RATE_LIMIT_MAX_CLIENTS` permettent de régler ces valeurs. Les réponses limitées renvoient HTTP 429 et `Retry-After`.

Le stockage du limiteur est en mémoire : il est réinitialisé au redémarrage et chaque réplique a son propre compteur. Il ne remplace donc ni une limite de débit distribuée, ni un pare-feu/WAF, ni une protection DDoS. En production, place l’API derrière une limite au niveau du fournisseur et ne publie pas directement son port.

Par défaut, Fastify ne fait confiance à aucun en-tête proxy. Si l’API se trouve derrière un proxy connu, renseigne `TRUSTED_PROXY_IPS` avec ses adresses ou CIDR séparés par des virgules. Ne fais jamais confiance à des en-têtes `X-Forwarded-For` fournis directement par les clients. Sans la bonne configuration du proxy, les requêtes peuvent partager l’adresse du proxy et atteindre ensemble la limite.

Les journaux HTTP omettent les paramètres d’URL afin de ne pas conserver les coordonnées de recherche. Les données de géolocalisation reçues sont utilisées pour répondre à la requête et ne sont pas ajoutées à une table par ces routes.

La recherche SQL utilise les coordonnées `lat`/`lon` des lignes `places` pour construire la géographie PostGIS; aucune colonne `places.location` n’est requise. Si le catalogue OSM ou la requête SQL locale est indisponible, la recherche intelligente continue vers Photon/Overpass et signale cette dégradation. Le parcours réel nécessite encore une base PostGIS avec un catalogue alimenté.

## Validité et rétention des offres

Une date de validité doit être une date réelle au format `YYYY-MM-DD`. Une offre active exige `verified_at` et `valid_until`; les dates inversées sont refusées. `valid_until` représente le dernier jour complet de validité dans le fuseau `Europe/Paris`; l’API publique exclut l’offre à partir du jour suivant, même si le worker d’expiration est momentanément en retard.

Le worker transforme les offres actives expirées en statut `expired`, puis supprime les offres expirées dont la date de fin remonte à plus d’un an. Pour les anciennes offres sans date de fin, la date de création est utilisée comme seuil de rétention. Ces deux opérations peuvent être relancées après une interruption.

Le worker scraper utilise un lease avec heartbeat et un jeton par tentative. Une erreur est retentée jusqu’à trois fois, après le délai configuré; un job abandonné est récupérable après expiration du lease. Valeurs par défaut : lease 15 minutes, heartbeat 60 secondes, attente de reprise 5 minutes et trois tentatives. `WORKER_JOB_LEASE_MS`, `WORKER_JOB_HEARTBEAT_MS`, `WORKER_JOB_RETRY_DELAY_MS` et `WORKER_JOB_MAX_ATTEMPTS` peuvent les régler.

Pour une base existante, appliquer manuellement les migrations de `migrations/` après contrôle des données et sauvegarde vérifiée. `20261114_scrape_job_leases.sql`, `20261114_offer_validity_constraints.sql` et `20261114_offer_external_ids.sql` n’ont pas été exécutées ici. La dernière migration s’arrête si des offres historiques n’ont pas d’identifiant stable; ne pas les inventer automatiquement. Le script `migrations/validate-migrations.psql` permet une vérification des migrations avec des tables temporaires, sur une base locale jetable uniquement. Le heartbeat et le SQL de claim ont aussi des tests unitaires, mais n’ont pas encore été vérifiés sur PostgreSQL réel. Si un worker perd son lease pendant une longue collecte, il ne finalisera pas le job; l’arrêt immédiat du navigateur à la perte du lease reste à ajouter.

Les tables `places`, `offers` et `offer_sync_runs` sont désormais créées uniquement par `migrations/20261120_002_places_offers.sql`. Le démarrage de l'API/worker vérifie ces tables et leurs contraintes en lecture seule. La FK `offers.place_id` utilise `ON DELETE RESTRICT`, cohérent avec la contrainte qui exige un `place_id` pour `scope='store'`. Pour une base existante, la migration 002 remplace explicitement l'ancienne FK après vérification PostgreSQL ; sauvegarder et tester d'abord sur une copie jetable.

## Sauvegarde

`bash scripts/backup.sh` écrit un dump dans `backups/`, dossier ignoré par Git. Le volume Docker `postgres_data` conserve les données locales; ne lance pas `docker compose down -v` si tu veux garder ce volume. Cette procédure locale ne remplace pas des sauvegardes cloud chiffrées et testées pour la production.

## Production

La configuration Docker Compose de ce dossier est destinée au développement local. La production doit héberger API, DB et workers dans le cloud, derrière HTTPS et des contrôles d’accès adaptés, indépendamment du PC, de WSL et de Docker Desktop. L’URL publique de l’API est une variable de build publique du frontend (`VITE_MAPNIFIQUE_API_URL`); les mots de passe et jetons restent exclusivement côté serveur. Aucun déploiement ou changement Vercel n’est fait ici.

La collecte utilise Playwright et peut lancer un vrai navigateur. Les tâches de collecte doivent respecter les conditions, robots et limites de chaque source; une offre dépourvue de dates exploitables reste en brouillon. Une plateforme serverless à courte durée d’exécution n’est pas automatiquement compatible avec ce worker long vivant : il faut un ordonnanceur/consommateur cloud adapté et une vérification sur la plateforme avant la migration.

Aucune source de crawl ni aucun collecteur de promotions n’est activé par défaut. Une source de crawl exige une approbation administrative explicite et une note de revue non vide. Les collecteurs de promotions sont soumis à deux opt-in indépendants : `OFFERS_ENABLED_SOURCES` pour demander l’activation et `OFFERS_SOURCE_LICENSE_APPROVED` pour attester que la revue écrite des droits, conditions, `robots.txt` et limites de requêtes est terminée. Les deux variables doivent contenir la source (`lidl` ou `franprix`). Laisser les deux vides tant que la conformité n'est pas établie. Voir [la revue des sources](../../docs/source-policy-review.md). Les collecteurs Franprix/Lidl vérifient aussi les règles `robots.txt` de chaque hôte et de chaque redirection, appliquent `Crawl-delay` et échouent en mode fermé si le fichier est absent ou illisible. `robots.txt` n’est pas une licence de réutilisation. Le worker d’expiration/rétention continue de fonctionner quand aucune source n’est activée.

`npm audit --omit=dev` signale un avis modéré dans l’arbre Crawlee/minimatch. Aucun override ni changement majeur n’a été appliqué; voir [la revue d’hébergement, sécurité et minimatch](../../docs/production-readiness.md#vulnerability-review-minimatch--crawlee) avant toute mise à niveau.


## Migrations du schéma scraper

Sur une base de test neuve, appliquer dans cet ordre :

1. `backend/scraper/migrations/20261120_000_baseline_schema.sql`
2. `backend/scraper/migrations/20261120_001_product_identity.sql`
3. `backend/scraper/migrations/20261120_002_places_offers.sql`
4. Exécuter l'audit de réconciliation, résoudre les problèmes, puis effectuer la réconciliation contrôlée qui marque la version 2.

Les tables `places`, `offers` et `offer_sync_runs` sont créées exclusivement par la migration 002. L'API et le worker ne doivent jamais créer ces tables au démarrage.
