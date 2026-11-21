# Architecture MapNifique à 0 € — révision du 21 novembre 2026

## Décision

Ne pas utiliser de VPS « gratuit » comme fondation. Oracle Always Free peut récupérer des instances inactives et la création de compte impose des contrôles qui ne correspondent pas à une promesse stricte de zéro dépense.

La cible de départ est une architecture serverless et statique, sans carte bancaire requise par le plan Neon Free et sans nom de domaine acheté :

| Composant | Service | Plan / limites gratuites utilisées |
|---|---|---|
| Frontend PWA | Cloudflare Pages | hébergement statique `*.pages.dev`, déploiement depuis GitHub |
| API HTTP | Neon Functions | runtime Node.js 24, 1 million d'invocations, 10 heures-capacité actives et 400 heures-capacité en attente par mois |
| PostgreSQL | Neon Postgres 17 | PostGIS disponible, 1 Go de stockage et 100 heures-CU par mois |
| Nettoyage planifié | GitHub Actions public | runner standard gratuit dans un dépôt public ; exécution quotidienne |
| Collectes ponctuelles approuvées | GitHub Actions public | runner standard gratuit ; exécution à la demande, pas de daemon continu |
| Sauvegardes | Neon Object Storage dans un second projet Free | bucket privé, chiffrement age, 5 Go inclus par projet selon la page tarifaire |
| Carte | MapLibre + OpenFreeMap | pas de clé API ni d'abonnement ; attribution de la source OSM/tiles |
| Géocodage / lieux | Photon, Nominatim et Overpass publics | usage borné, cache et respect des politiques ; aucune garantie de disponibilité |

Sources tarifaires et techniques :
- Neon Free et Functions : https://neon.com/pricing
- Neon Functions CLI/runtime : https://neon.com/docs/cli/functions
- Neon PostGIS : https://neon.com/docs/extensions/pg-extensions
- Cloudflare Pages : https://developers.cloudflare.com/pages/platform/limits/
- GitHub Actions, runners publics gratuits : https://docs.github.com/en/billing/concepts/product-billing/github-actions
- OpenFreeMap : https://openfreemap.org/

## Limites honnêtes — aucun coût caché, mais aucun service illimité

- Neon Free se met à l'échelle zéro après inactivité et redémarre au premier appel. La première requête peut donc être plus lente. Les fonctions gratuites ont un quota de capacité ; ce n'est pas un serveur 24/7 dédié.
- Neon Free limite la base à 1 Go et 100 heures-CU par mois. Si la limite est atteinte, le service peut être suspendu ou limité jusqu'au prochain cycle. Ne pas choisir un plan payant ni activer une facturation à l'usage.
- Les fonctions Neon disposent de 1 million d'invocations, 10 heures de capacité active et 400 heures de capacité en attente par mois. Une croissance importante exigera une nouvelle décision, mais aucune dépense automatique n'est autorisée.
- Cloudflare Pages sert les assets statiques. Le nom gratuit `mapnifique.pages.dev` suffit ; pas d'achat de domaine.
- GitHub Actions est utilisé uniquement avec des runners standards sur dépôt public. Pas de runners larges, pas d'artifacts de sauvegarde persistants et pas de cache démesuré.
- Les services publics OSM ne fournissent ni SLA ni capacité garantie pour un usage massif. Le cache et les limites côté API restent obligatoires.

**Règle budgétaire :** rester sur les plans Free. Ne pas activer un plan payant, ne pas mettre de moyen de paiement, ne pas provisionner de VPS, ne pas acheter de domaine, ne pas activer R2/Workers payants. En cas de quota dépassé, l'application se dégrade ou s'arrête ; elle ne doit jamais basculer automatiquement sur une offre facturée.

## API Neon Functions : réutilisation du backend existant

Le backend a été séparé en `src/app.js` (enregistrement Fastify, aucun socket réseau) et `src/server.js` (serveur local traditionnel). La fonction `backend/scraper/functions/api.js` adapte les requêtes Fetch HTTP en `Fastify.inject()` et réutilise les mêmes routes, validations et contrôles.

- Neon fournit `DATABASE_URL` à la fonction ; le pool est limité à deux connexions par instance.
- La fonction tourne sous Node.js 24 et n'ouvre aucun port réseau.
- Les workers Crawlee/Playwright ne tournent pas dans l'API : ce sont des tâches ponctuelles, à lancer via un runner GitHub Actions uniquement lorsque des sources sont autorisées.
- `VITE_MAPNIFIQUE_API_URL` reçoit l'URL publique de la fonction Neon, sans suffixe `/api`.
- Le domaine CORS par défaut est `https://mapnifique.pages.dev`.

## Données de commerces et offres

Les lieux peuvent être trouvés via OSM/Overpass/Photon avec requêtes géographiques bornées et cache. Il ne faut pas importer l'intégralité de la France dans Neon Free (base limitée à 1 Go). Le catalogue OSM local/PostGIS reste facultatif ; au lancement, privilégier les requêtes ciblées et la mise en cache limitée.

Il n'existe pas de flux universel, gratuit et librement réutilisable couvrant les promotions des supermarchés français. Open Food Facts fournit des données produits, pas un flux officiel de promotions locales en magasin. Les collectes Lidl et Franprix restent désactivées tant qu'une licence ou autorisation de réutilisation explicite n'est pas documentée. Le système d'approbation double opt-in existant est conservé.

## Backups

- Une sauvegarde complète hebdomadaire est créée avec `pg_dump` PostgreSQL 17, compressée et chiffrée avec `age`.
- Elle est envoyée vers un bucket privé dans un SECOND projet Neon Free (pas le projet qui contient la base), en conservant quatre sauvegardes hebdomadaires.
- Le script refuse un dump supérieur à 900 Mo et refuse de dépasser 4,8 Go d'objets conservés : il échoue au lieu d'engendrer des frais.
- La clé privée `age` reste hors GitHub et hors du serveur. Seule l'identité publique `AGE_RECIPIENT` est stockée dans GitHub Actions.
- Une restauration exige une base de destination vide, teste l'intégrité du dump et vérifie `schema_state.version = 2`.

Ce stockage est indépendant de la base principale mais reste dans le même fournisseur/compte Neon ; il protège contre la perte ou corruption de la base, pas contre la suppression globale du compte.

## Étapes d'activation encore nécessaires

Les comptes Neon et Cloudflare appartiennent à l'utilisateur et ne sont pas créés dans ce workspace. Une fois les comptes Free créés, suivre `docs/neon-deploy.md`. Aucun secret ni identifiant ne doit être ajouté au dépôt public.


## Worker Playwright en mode zéro euro (ajout v6)

L'API publique repose sur Neon Functions + Neon Postgres. Les tâches de maintenance quotidiennes peuvent être exécutées par Function Triggers Neon ou GitHub Actions. En revanche, la collecte Crawlee/Playwright nécessite un navigateur Chromium : un worker permanent gratuit et fiable n'est pas garanti. Pour éviter un VPS payant, le workflow GitHub public `crawler-worker.yml` lance un seul job toutes les dix minutes avec Chromium sur `ubuntu-latest` ; le préflight lit la file avant d'installer Chromium et le temps d'un passage est limité à huit minutes. Cela donne une collecte périodique, pas un traitement instantané ni une garantie de démarrage à la minute. GitHub confirme que les runners standards sont gratuits dans les dépôts publics. Si GitHub retarde ou manque un cron, les jobs restent dans PostgreSQL et seront repris au prochain passage.
