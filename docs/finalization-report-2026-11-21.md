# MapNifique — rapport de finalisation technique

**Date : 21 novembre 2026**
**Base de travail :** archive `MapNifique-Workspace-Complet-20261120-preview-fix.zip`
**Périmètre :** build, dépendances, PostgreSQL, parcours navigateur et préparation production.
**Règle de sûreté :** aucun accès en écriture à une base réelle, aucun commit/push Git, aucune modification Vercel/DNS, aucun secret modifié, aucune création de ressource cloud et aucun déploiement.

## 1. Build frontend

### Correctifs présents

L'archive de départ contenait déjà les deux corrections demandées après le run `verify:full` du 20 novembre :

1. `frontend/src/utils/catalog-price.d.ts` déclare le contrat de `formatCatalogPrice` importé depuis `catalog-price.js` ;
2. `frontend/src/App.tsx` déclare le tuple mutable `BrandOfferEntry` et type explicitement le retour de chaque tâche `Promise.all`, évitant `Offer[] | readonly []`.

Le contrôle TypeScript isolé de ces deux constructions a réussi avec le compilateur global TypeScript 5.8.3 disponible dans l'environnement de préparation. Il ne s'agit pas du build complet du projet : celui-ci utilise la version du lockfile, TypeScript 7.0.2, et ses dépendances React/Vite.

### Limite actuelle

Le `npm run build` complet n'a pas pu être exécuté ici : les dépendances ne sont pas installées dans cet environnement de préparation, le cache npm est vide et la résolution de `registry.npmjs.org` a échoué par DNS. L'utilisateur n'a pas encore transmis un résultat `npm run build` postérieur à l'intégration du correctif. Le build reste donc **à certifier dans WSL**.

## 2. Sécurité et dépendances

### Correctifs faits

- `backend/scraper/package.json` et `backend/scraper/package-lock.json` déclarent maintenant `fastify: ^5.12.8` et `@fastify/cors: ^11.4.3`, alignés avec les versions réellement verrouillées (Fastify 5.12.8, CORS 11.4.3). Ce n'est pas une montée de major ; le lockfile n'a pas été régénéré avec des versions différentes.
- Ajout de `scripts/summarize-security-audit.mjs` et `npm run audit:deps:summary`, pour afficher les totaux, les paquets, chemins, plages affectées et possibilités de correction à partir des JSON produits par `npm run audit:deps`.
- Ajout de `docs/dependency-security.md` qui décrit le finding encore ouvert et le protocole de mise à niveau sûre.

### Finding restant

Le `npm ci` WSL du 20 novembre a signalé 12 findings modérés côté backend et aucun côté frontend. Le rapport d'audit précédent identifie l'arbre Crawlee/minimatch comme origine commune. Le lockfile actuel contient `crawlee/@crawlee/core 3.18.2` et `minimatch 9.0.9`.

L'avis GHSA-g3hv-75wg-m249 / CVE-2026-118764 corrige le défaut à partir de minimatch 11.0.1. Le niveau 11.0.9 est la version publique la plus récente observée et les bases consultées ne signalent pas d'avis direct pour cette version. Mais Crawlee 3.18.2 déclare `minimatch ^9.0.0`. Forcer un paquet de major 11 sous Crawlee sans lockfile régénéré ni test du crawler serait risqué. Aucun override 11.x n'a été posé, aucun `npm audit fix --force` n'a été exécuté.

La revue du code applicatif montre que MapNifique ne transmet pas de globs contrôlables par un utilisateur à `enqueueLinks`; le filtrage de fiche produit est une RegExp distincte, et les origines de source sont validées. Crawlee instancie Minimatch sans demander le niveau d'optimisation 2 ; le niveau par défaut est 1. Cela réduit la voie d'exploitation documentée mais **ne supprime pas** l'avis npm. La dette de sécurité reste explicitement ouverte jusqu'à une correction stable upstream ou à un override 11.0.9 validé sur une branche, avec tests crawler Playwright et PostgreSQL.

Les avis de dépréciation `lodash.isequal` et `whatwg-encoding` vus à l'installation ne sont pas comptés comme des vulnérabilités sans advisory distinct.

## 3. Validation PostgreSQL

Un run antérieur communiqué par l'utilisateur dans le workspace précédent s'est terminé avec `OVERALL=PASS`, après :

- vérification du `tmpfs` effectif et absence de mounts persistants ;
- migrations sur schémas neufs et historiques ;
- validators identité / places / offres et réexécution idempotente ;
- verrouillage à deux sessions et upserts concurrents ;
- audit et exécution de réconciliation propre, refus explicite des collisions ;
- backups legacy et versionnés, restores, et échec pg_dump contrôlé ;
- suppression du conteneur jetable.

Ce run ne correspond pas à l'archive finale actuelle. Le `verify:full` de l'archive hardening a échoué plus tôt au build frontend ; sa phase PostgreSQL finale n'a donc pas eu lieu. J'ai ajouté le test PostgreSQL à la CI et la commande `npm run verify:release`. **Il faut encore obtenir `OVERALL=PASS` sur l'archive finale** après compilation réussie.

## 4. Fonctionnel navigateur et preview

Deux preview locaux sont désormais documentés/configurés :

- développement avec HMR : `npm run dev` → `http://localhost:5173` ;
- preview du build compilé : après build vert, `npm run preview` → `http://localhost:4173`.

La checklist `docs/browser-functional-checklist.md` couvre GPS accepté/refusé/timeout, carte/attribution, recherche libre et proximité, catégories, fiche commerce, périmètres d'offres, expiration, états vides, panne API, itinéraires, responsive, accessibilité et PWA/iPhone Safari.

Aucun test navigateur n'a été exécuté sur l'archive finale : le navigateur distant n'a pas pu démarrer faute de crédits disponibles, et le service local WSL de l'utilisateur n'est pas accessible depuis cet environnement. Le site Vercel expose un déploiement READY, mais sa source est `redeploy` et les métadonnées ne permettent pas de prouver qu'il correspond à cette archive. Il ne doit pas être annoncé comme preview validé.

## 5. Préparation production

### État observé

- Compose reste une configuration locale : l'API est publiée sur `127.0.0.1:8787`, PostgreSQL conserve son volume local ; cela ne constitue pas une API publique permanente.
- Aucun endpoint API stable en HTTPS, base PostGIS hébergée privée, worker cloud, ordonnanceur durable, backup hors hôte chiffré et restauré, ou alerting de disponibilité n'est certifié pour cette archive.
- Les collecteurs Lidl et Franprix restent désactivés : les droits de réutilisation ne sont pas validés et les règles robots de certains hôtes ne sont pas entièrement vérifiées.
- Le démarrage actuel nécessite le schéma et la réconciliation d'identité en version 2 ; une séparation stricte du rôle de migration et du rôle runtime doit être finalisée avant exploitation publique.

### Choix d'hébergement

Le chemin gratuit possible reste best-effort (frontend statique + VM/containers auto-hébergés + sauvegarde externe), sans garantie de disponibilité ni de capacité constante. Pour une disponibilité publique plus sérieuse, il faut prévoir un coût récurrent pour compute long-running et PostgreSQL/PostGIS managé, ainsi qu'un second emplacement de sauvegarde. Aucun service n'a été créé car le plafond de dépense et le niveau de disponibilité cible ne sont pas définis.

### Non effectués

Pas de push, PR, commit, déploiement, DNS, changement de variable d'environnement Vercel, migration sur base réelle, restauration de production, activation des sources commerciales ni achat d'infrastructure.

## 6. Contrôles réalisés dans l'environnement de préparation

| Contrôle | Résultat |
|---|---|
| Parse des manifests `package.json` et lockfiles | PASS |
| Cohérence des dépendances racine package / lockfile Fastify et CORS | PASS |
| Versions verrouillées Fastify 5.12.8, CORS 11.4.3, minimatch 9.0.9 relevées | PASS |
| `node --check` pour tous les fichiers JS/MJS backend et script d'audit | PASS |
| `bash -n` pour tous les scripts shell | PASS |
| Test isolé TypeScript de la déclaration de module et du tuple mutable | PASS |
| Test du résumé npm audit sur fixture JSON | PASS |
| Fichiers `.env`, `.pem`, `.key` dans l'archive | Aucun trouvé |
| YAML workflow GitHub Actions parsé | PASS |
| Build frontend complet | NON EXÉCUTÉ (registre npm indisponible) |
| Suite complète backend/frontend dans cet environnement | NON EXÉCUTÉ (dépendances non installées) |
| PostgreSQL/Docker sur cette archive dans cet environnement | NON EXÉCUTÉ (Docker CLI absent) |
| Test navigateur sur cette archive | NON EXÉCUTÉ (navigateur distant indisponible) |

## 7. Exécution finale dans WSL

Extraire l'archive dans un dossier propre, puis lancer depuis la racine `MapNifique-Workspace` :

```bash
npm run verify:full
npm run audit:deps
npm run audit:deps:summary
```

`verify:full` installe les dépendances par lockfile, exécute lint/check/tests/build puis le runner PostgreSQL jetable. Il s'arrête si le build échoue ; dans ce cas, ne pas interpréter l'absence de sortie PostgreSQL comme un PASS. Si `verify:full` termine avec `MAPNIFIQUE_FULL_VALIDATION=PASS`, le build et le runner SQL ont tous deux passé sur cette archive.

Pour voir l'interface sans backend : `npm run dev` et ouvrir `http://localhost:5173`. Pour prévisualiser le build compilé : `npm run preview` et ouvrir `http://localhost:4173`. Remplir ensuite `docs/browser-functional-checklist.md` avec des données de staging licenciées. Ne pas relier ces previews à la base de production.

La production reste bloquée tant que le build, PostgreSQL sur cette archive, les tests navigateur, l'audit minimatch, le staging complet et le plan de coût/sauvegarde ne sont pas tous acceptés.


## Addendum — résultats ultérieurs et correction de statut (21 novembre 2026)

Ce rapport décrivait l'état de préparation avant réception des nouveaux résultats WSL. Les lignes plus anciennes ci-dessus qui disent que le build, PostgreSQL ou Git n'étaient pas exécutés ne décrivent plus l'état actuel. Les résultats ci-dessous les remplacent :

- L'utilisateur a ensuite exécuté `npm run verify:full` sur `MapNifique-Workspace-Complet-20261121-finalisation.zip` : `tsc -b` PASS, `vite build` PASS (2 111 modules), Oxlint 0 erreur, backend 217/217, frontend 4/4, PostgreSQL jetable `OVERALL=PASS` et `MAPNIFIQUE_FULL_VALIDATION=PASS`.
- L'utilisateur a vérifié `npm run preview` sur la version `git-ready` : Vite Preview a démarré sur `http://localhost:4173`. Cela ne remplace pas les tests fonctionnels navigateur avec API/base actives.
- L'utilisateur a ensuite créé localement un clone de publication, la branche `work/mapnifique-finalisation-20261121` et le commit initial `f0674c7` (153 fichiers). Le push HTTPS a échoué faute d'authentification (`No anonymous write access`). Aucun push GitHub, branche distante ou PR n'est confirmé ; `main` reste inchangée.
- Le script de publication a depuis été renforcé pour reprendre le clone local et détecter GitHub CLI ou SSH avant de pousser. La reprise après un push rejeté a été testée sur un dépôt Git bare local ; `main` est restée inchangée. Le vrai push GitHub nécessite toujours `gh auth login ... --web` ou une clé SSH active dans WSL.
- Un test d'override `minimatch ^11.0.1` en copie isolée a été ajouté ; il n'a pas encore été exécuté dans WSL et les 12 findings modérés backend restent ouverts.
- Le projet Vercel existant a été inspecté en lecture seule ; son API pointe encore vers un Quick Tunnel Cloudflare temporaire. Aucun réglage Vercel ou déploiement n'a été modifié.
- Un comparatif d'hébergement a été ajouté. La piste à faible coût recommandée pour une première version publique est Vercel pour le frontend + VPS x86 4 vCPU/8 Go pour API/PostGIS/workers + sauvegardes chiffrées R2 hors hôte. C'est une recommandation à valider, pas une infrastructure créée ou commandée.

Les seuls points désormais certifiés sont donc la compilation, les tests automatisés locaux et le runner PostgreSQL jetable. La publication distante, l'audit final à zéro, les tests navigateur, le staging complet, les sauvegardes cloud restaurées, le choix/achat d'hébergement et le déploiement public restent à faire.
