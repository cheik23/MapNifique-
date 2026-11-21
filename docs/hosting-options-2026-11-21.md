# MapNifique — choix d’hébergement et trajectoire de mise en production

**Revue du 21 novembre 2026 — aucun compte cloud ni service créé.**

## Objectif opérationnel

MapNifique doit rester accessible quand le PC/WSL est éteint. L'application comprend un frontend statique, une API Fastify, PostgreSQL/PostGIS, un crawler Playwright, un worker d'offres et une tâche de synchronisation/maintenance. Une offre d'hébergement n'est donc acceptable que si elle permet une API stable, un stockage DB persistant, des processus de fond exécutés durablement, TLS, des sauvegardes externes et un contrôle des dépenses.

## Comparatif vérifié

| Solution | Ce qui est intéressant | Limite qui la disqualifie ou la conditionne |
|---|---|---|
| Render Free | Frontend statique gratuit, web service de test | Web service endormi après 15 min sans trafic ; redémarrage d'environ 1 min ; système de fichiers éphémère ; Postgres Free limité à 1 Go, expire après 30 jours et sans backups. Pas la production MapNifique. |
| Supabase Free | PostgreSQL géré, 500 Mo et 5 Go d'egress affichés | Pause après une semaine d'activité DB insuffisante ; pas de sauvegarde automatique ni PITR sur Free. Utilisable pour un test, pas comme seule base publique durable. |
| Railway Free | $1 de crédit mensuel, services utilisables pour essais | Services endormis en inactivité, pas de domaine personnalisé ni de cron sur Free ; le plan Hobby commence à $5 minimum/mois pour l'exécution continue, puis ressources facturées selon usage. |
| Oracle Always Free A1 | Jusqu'à 2 OCPU / 12 Go RAM ARM, 200 Go de Block Volume et 20 Go d'Object Storage dans le quota Always Free | Instances inactives susceptibles d'être récupérées ; capacité régionale variable. Autre blocage : l'image `postgis/postgis:17-3.6-alpine` utilisée actuellement est annoncée `linux/amd64`, pas `arm64`. Il faudrait construire/tester une image PostGIS ARM dédiée avant d'envisager A1. |
| OVHcloud VPS x86 | Docker/Playwright/PostGIS dans un environnement x86 simple, VM permanente et IP publique | Coût mensuel ; administration système et sécurité à notre charge. La page OVH consultée affiche VPS-1 2 vCores/4 Go à 4,57 € TTC/mois et VPS-2 4 vCores/8 Go à 8,65 € TTC/mois, à reconfirmer dans le panier avant commande. |

## Recommandation technique provisoire

Pour une première version publique qui continue à fonctionner PC éteint, le compromis simple à valider est :

1. **Application complète :** pour limiter les frais et éviter une dépendance au PC, servir le frontend statique (`frontend/dist`), l'API Fastify, PostgreSQL/PostGIS et les workers depuis un VPS x86 en France/Europe. Caddy servira les fichiers frontend et terminera TLS, puis transmettra `/api/*` vers Fastify sur le réseau Docker privé. Un seul domaine peut suffire au départ ; la base ne sera jamais publiée sur Internet.
2. **Alternative frontend séparé :** Cloudflare Pages peut héberger le frontend statique (Free : jusqu'à 500 builds/mois, 20 000 fichiers et un build concurrent), avec une API sur le VPS. Il faudra vérifier les conditions et limites applicables au cas commercial exact avant de retenir cette option. Vercel Hobby est réservé à l'usage personnel/non commercial ; pour une exploitation commerciale, il faut un plan approprié (Pro affiché à 20 USD/mois) ou éviter ce plan.
3. **Crawler :** démarrer avec `DEFAULT_MAX_CONCURRENCY=1`, puis augmenter seulement après mesures de RAM et de CPU. Playwright et PostGIS sont cohébergés au début ; isoler le worker si la charge le nécessite.
4. **TLS et DNS :** un nom DNS stable tel que `api.<domaine-validé>` est nécessaire. Caddy peut obtenir/renouveler le certificat automatiquement lorsque le DNS pointe vers le VPS et que 80/443 sont accessibles. Le domaine et le DNS restent à choisir ; aucun achat n'est effectué ici.
5. **Sauvegardes :** `pg_dump` chiffré côté client avec Restic vers Cloudflare R2. R2 affiche 10 Go-mois de stockage Standard, 1 million d'opérations Class A, 10 millions Class B et egress Internet gratuit dans son palier Free. Il faut configurer un seuil de stockage, un lifecycle de rétention, une clé d'accès restreinte et des tests de restauration. La sauvegarde quotidienne incluse chez l'hébergeur ne remplace pas cette copie hors hôte.
6. **Exploitation :** pare-feu n'autorisant que SSH restreint et 80/443, mises à jour de sécurité, secrets côté VPS, health checks API/DB, alerte d'absence de worker et de fraîcheur des données, logs applicatifs déjà expurgés des coordonnées. Ne pas activer des logs proxy contenant les URI complètes et leurs paramètres géographiques.

Cette architecture est mono-serveur : elle vise une première disponibilité permanente à coût faible, pas une haute disponibilité multi-zone. Une panne VPS arrêtera API, base et workers jusqu'à restauration/recréation. La résilience repose d'abord sur des sauvegardes offsite restaurables et une procédure documentée.

## Pourquoi ne pas sélectionner immédiatement une offre gratuite

Les offres gratuites examinées ont des pauses, expirations, limites de stockage ou des contraintes d'architecture incompatibles avec un service de proximité qui doit répondre à toute heure. L'offre Oracle A1 est la seule piste compute Always Free suffisamment dotée en RAM, mais elle est ARM ; le conteneur PostGIS du Compose actuel est x86. Il serait imprudent de choisir A1 sans construire et valider toute la pile ARM.

## Séquence de déploiement — sans toucher à la production existante

1. Pousser et relire la branche de transition GitHub, obtenir une CI verte.
2. Finir l'audit npm backend et la vérification navigateur locale.
3. Choisir le budget maximum, le fournisseur VPS et le domaine ; vérifier les prix finaux et conditions de renouvellement avant commande.
4. Créer un environnement de staging isolé sur le VPS, déployer migrations sur DB neuve, Caddy/TLS et données de test.
5. Configurer sauvegarde R2 chiffrée, contrôle de rétention et effectuer une restauration réelle sur une autre base.
6. Tester GPS, recherche, catégories, fiches, offres, routes, responsive, iPhone et comportement en cas d'arrêt API/worker.
7. Tester le frontend servi par Caddy sur le VPS de staging, avec l'API HTTPS stable et une CORS allowlist limitée au domaine retenu. Si l'option Cloudflare Pages ou Vercel est retenue, valider d'abord les conditions commerciales, les quotas, la racine `frontend/` et les variables Preview. Garder le domaine/projet de Production actuel inchangé.
8. Après acceptation du staging, préparer le déploiement Production avec un plan de retour arrière, des sauvegardes restaurables et les valeurs d'environnement appropriées.

## Références officielles consultées

- OVHcloud VPS France et tarifs affichés : https://www.ovhcloud.com/fr/vps/
- Render Free : https://render.com/docs/free
- Supabase pricing : https://supabase.com/pricing
- Supabase Free pausing : https://supabase.com/docs/guides/platform/free-project-pausing
- Railway plans : https://docs.railway.com/pricing/free-plan
- Oracle Always Free : https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Image PostGIS officielle examinée : https://hub.docker.com/r/postgis/postgis/tags
- Cloudflare R2 pricing : https://developers.cloudflare.com/r2/pricing/
- Cloudflare Pages limits : https://developers.cloudflare.com/pages/platform/limits/
- Vercel Hobby terms : https://vercel.com/legal/terms
- Vercel pricing : https://vercel.com/pricing
