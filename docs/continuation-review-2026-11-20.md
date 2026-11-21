# Reprise du chantier MapNifique — 20 novembre 2026

## Base et méthode

- Base de travail : `MapNifique-Workspace-Complet-20261120-115458.zip`.
- Correctif de référence : paquet `MapNifique-Prompt26-PostgreSQL.zip`.
- Fusion effectuée uniquement dans une copie isolée ; l'archive source et les fichiers réels de l'utilisateur n'ont pas été modifiés.
- Le manifeste Prompt 26 contient 41 fichiers. Après fusion, les 41 fichiers présents dans le workspace correspondent exactement aux SHA-256 `source_sha256` du manifeste Prompt 26 (41/41, aucun fichier manquant ni divergent).
- Les protections absentes dans la copie de travail ont été restaurées ; les autres fichiers conformes au manifeste n'ont pas été réécrits inutilement.

## Corrections réintégrées

- Migration `20261120_003_identity_reconcile_preflight.sql` : l'absence d'`identity_key` et les GTIN-8/12/13 valides restent acceptés en version 1 ; les invariants canoniques deviennent bloquants en version 2.
- Réconciliation : la transition vers la version 2 est incluse dans la transaction et les validations dépendantes de la version 2 sont rejouées avant le `COMMIT` ; le cas « déjà en version 2 » repasse aussi par les validateurs.
- Schéma places/offers : restauration des contrôles de cohérence, de la séparation `store`/`brand`/`online`, de l'obligation de `brand_key` pour les offres non-magasin et de la validation des colonnes, contraintes et index.
- API et synchronisation : refus des `placeId` sur les offres `brand`/`online` et refus d'une offre non-magasin sans `brandKey`, en cohérence avec le schéma.
- Tests : ajout du runner PostgreSQL Prompt 26, du fixture legacy et du validateur de préflight ; le runner couvre les migrations fraîches et legacy, la réexécution de la migration 002, les validations d'identité, le rollback, deux sessions PostgreSQL concurrentes, les upserts et les sauvegardes/restaurations.
- Sauvegarde/restauration : mode de test limité aux noms de conteneur et de base Prompt 26 ; aucun `.env` ni `docker compose` n'est chargé dans ce mode.

## Résultats des contrôles réellement exécutés

| Contrôle | Résultat | Détail |
|---|---|---|
| `npm run check` backend | PASS | Toutes les vérifications `node --check` déclarées passent. |
| Suite backend complète | PARTIEL | 202 tests découverts : 200 réussissent ; 2 fichiers ne se chargent pas faute de modules `pg` et `fastify`. |
| Suite backend sans les 2 fichiers dépendants de ces modules | PASS | 200/200 tests réussis. `db.test.js` et `security.test.js` ont été exclus explicitement de cette sélection. |
| Syntaxe des scripts Bash | PASS | Tous les `scripts/*.sh` contrôlés par `bash -n`. |
| Tests unitaires frontend | PASS | 4/4 tests. |
| Garde-fous du mode test backup/restore | PASS | Conteneur de test hors périmètre refusé avec code 64 par les deux scripts. |
| Lint frontend | BLOQUÉ | `oxlint` absent (`command not found`). |
| Build frontend | BLOQUÉ | TypeScript ne trouve pas les définitions `vite/client` et `node`. |
| Migrations et intégration PostgreSQL réelles | NON EXÉCUTÉES | Docker CLI/Engine et `psql` absents dans l'environnement ; aucune base temporaire n'a été démarrée. |

Environnement de vérification : Node.js `v22.16.0`, npm `10.9.2`. Les dépendances backend ne sont pas installées. Aucun `npm install` ou téléchargement de dépendances n'a été lancé.

## Revue statique du runner PostgreSQL

- Image autorisée par défaut : `docker.io/library/postgres:17-alpine` ; une autre référence que `docker.io/library/postgres:*` est refusée.
- Le port PostgreSQL est publié sur `127.0.0.1` avec port hôte dynamique.
- Le stockage est monté en `tmpfs` sur `PGDATA` ; le runner exige exactement ce montage et refuse tout bind mount ou volume persistant.
- Le conteneur est nommé avec un identifiant Prompt 26 propre à l'exécution, lancé avec `--rm`, puis contrôlé/supprimé par le trap de nettoyage.
- Le runner n'utilise ni `.env`, ni Compose, ni installation npm. La réconciliation Node est conditionnelle à la présence préalable de `pg`.
- La validation ci-dessus est une revue du code et de ses garde-fous, pas une exécution du runner PostgreSQL.

## Limites et précautions

- Les tests SQL, concurrence, migrations, backup/restore et réconciliation contre PostgreSQL restent à exécuter sur un hôte disposant de Docker Engine et des dépendances backend. Ne pas interpréter leur présence dans le runner comme une validation déjà obtenue.
- Aucun changement n'a été appliqué à une base réelle, aux conteneurs du scraper, à un service cloud ou au dépôt GitHub.
- Aucun commit, push ou déploiement n'a été effectué.
- Aucune source de collecte n'a été activée ou approuvée par ce travail.
- Aucun fichier `.env` réel, fichier de base locale ou dump de données métier n'a été trouvé dans le workspace livré. Les fichiers `.env.example` sont conservés.

## Provenance SHA-256 des archives d'entrée

- Workspace source : `9f12129402a5f4b61a6c9ad55da7e86d27554647c21f3dbfc873daa25602275c`
- Paquet Prompt 26 : `5f9238dbb33f23fe61bbfce68ed1dbdff974d241ae842f857b2f4832c541a9e8`

## Livraison et vérification du patch

- L'archive consolidée contient 160 fichiers du workspace ; les dossiers `node_modules`/caches d'exécution sont exclus et les `.env.example` sont conservés.
- Le patch fourni regroupe 20 fichiers modifiés ou ajoutés. Il a été testé avec `patch --dry-run`, puis appliqué à une copie intacte ; les 160 fichiers comparables correspondent ensuite octet pour octet au workspace consolidé.
- L'archive ZIP a été relue avec un contrôle d'intégrité ZIP (`testzip`) et ne contient ni `node_modules`, ni fichier `.env` réel.

## Revue du diff historique de 5 260 lignes

Le fichier recherché est bien `diff(2).patch` (5 260 lignes). Les trois copies archivées (`diff.patch`, `diff(1).patch`, `diff(2).patch`) sont strictement identiques : SHA-256 `c442f15648d569264ad23b5646807987e9a1170c5c130c4cc297d3c17bf99d34`. Le diff porte sur 20 fichiers, avec 4 554 insertions et 332 suppressions ; les 374 lignes restantes correspondent au contexte du format unified diff.

Le diff est historique : sa comparaison part du dossier `backups/prompt20-20261119-221119` et décrit l'introduction du moteur d'identité/staging et des migrations de novembre. Ce n'est pas un patch de mise à jour à rejouer sur le workspace actuel. Les 20 chemins concernés existent dans le workspace consolidé, mais 18 ont depuis évolué ; le manifeste Prompt 26 constitue la référence de la version plus récente (41/41 empreintes conformes).

### Portée fonctionnelle auditée

- **Extraction et collecte** : évolution de `extract.js`, `crawler.js`, `worker.js` et `server.js` pour séparer la preuve d'une fiche produit des liens d'offres, préserver les observations et gérer les jobs avec lease/heartbeat et reprise contrôlée.
- **Identité** : ajout de `identity.js` et de ses tests ; GTIN GS1 avec chiffre de contrôle, normalisation canonique, URL de produit avec suppression limitée du tracking, conservation des paramètres identifiants, variantes structurées et clés de secours ne dépendant pas du prix.
- **Staging** : ajout de `stage.js` et de ses tests ; transactions, verrouillage du job et vérification du lease, idempotence des candidats/observations, conservation des provenances, détection des collisions et blocage des changements d'identité nécessitant une revue humaine.
- **PostgreSQL** : baseline, migration d'identité, alias uniques, tables de candidats/observations/provenances/anomalies et fonctions de contrôle/purge.
- **Réconciliation et sauvegarde** : ajout des modes `--audit`/`--execute`, des scripts de backup/restore et d'un premier runner d'intégration PostgreSQL.

### Points sensibles trouvés dans l'étape historique et durcis ensuite

1. **Runner PostgreSQL historique** : il utilisait un port fixe par défaut (`55432`), publiait `-p "$PORT:5432"` sans limiter l'adresse hôte à `127.0.0.1`, ne demandait pas `--tmpfs` et nettoyait le conteneur avec `docker rm -f` sans contrôle explicite des montages. Il ne donnait donc pas les garanties d'isolation attendues pour la validation finale. Le runner Prompt 26 le remplace : port dynamique en loopback, `tmpfs` obligatoire, contrôle des montages, mot de passe aléatoire, conteneur dédié et nettoyage vérifié.
2. **Préflight identité version 1** : la première fonction `identity_data_problems()` signalait systématiquement les `identity_key` NULL et les GTIN non canoniques. Or ces valeurs peuvent être normales avant réconciliation d'un historique v1. La migration 003 introduite ensuite rend les contrôles dépendants de `schema_state.version` et teste un GTIN-13 valide en v1 puis le refus des clés manquantes en v2.
3. **Réconciliation historique** : la première version du script court-circuitait les validateurs lorsque le schéma était déjà en version 2 ; elle ne canonisait pas l'URL historique et ne réécrivait pas le GTIN stocké vers sa forme canonique. Le script actuel contrôle les validateurs même en v2, bloque les URL/GTIN historiques invalides, écrit le GTIN normalisé, puis rejoue les validateurs après le passage en version 2 et avant le `COMMIT`.
4. **Restauration** : le script historique avertissait et demandait une confirmation avant d'écraser la base configurée. Cette action reste destructive par nature. Le mode de test Prompt 26 ajoute un périmètre strict de conteneur/base jetables et une confirmation dédiée ; aucune restauration réelle n'a été exécutée ici.
5. **Purge des candidats** : la fonction actuelle ne purge que les candidats de jobs terminés/échoués, au-delà de la rétention, sans blocage, observation en attente ni anomalie associée. Les anomalies revues anciennes sont archivées avec un instantané avant suppression. Les lignes de produits et les observations de prix finales ne sont pas la cible de cette purge.

### Conclusion de la revue du diff

Le diff de 5 260 lignes correspond à l'étape fondatrice Prompt 20 ; il ne doit pas être appliqué à nouveau au workspace Prompt 26. Les évolutions suivantes ont corrigé plusieurs faiblesses visibles dans ce premier état, notamment le préflight v1/v2, la réconciliation après passage en v2 et l'isolation du runner PostgreSQL. Les vérifications unitaires disponibles passent, mais les garanties SQL et transactionnelles doivent encore être confirmées par l'exécution du runner Prompt 26 sur un moteur PostgreSQL jetable.

## Addendum — exécution PostgreSQL confirmée et durcissement backend (20 novembre 2026)

### Exécution confirmée sur l'environnement WSL de l'utilisateur

Le runner Prompt 26 a ensuite été exécuté avec Docker Desktop, Node `v22.23.1` et le driver `pg` disponible. Le résultat complet fourni par l'utilisateur contient :

- `STORAGE_ISOLATION=verified`, `MOUNTS=tmpfs-only`, `HOST_BIND=127.0.0.1:<port dynamique>` ;
- migrations neuves et historiques 000–003, validateurs identité/lieux/offres et réexécution 002 ;
- `POSTGRES_TWO_SESSION_LOCKING=PASS` et `POSTGRES_CONCURRENT_OFFER_UPSERT=PASS` ;
- audit/exécution de réconciliation propre, refus attendu d'un dataset conflictuel ;
- sauvegarde/restauration legacy et versionnée, échec `pg_dump` volontairement testé ;
- `SQL_MIGRATIONS_AND_VALIDATORS=PASS`, `NODE_RECONCILIATION=PASS`, `BACKUP_RESTORE_STATUS=PASS`, `SQL_STATUS=PASS`, `OVERALL=PASS` ;
- conteneur temporaire supprimé en fin de run.

Le log correspondant est conservé sur la machine de l'utilisateur sous `backend/scraper/backups/prompt26-postgres-validation-20261120T220334Z`. Cela valide la suite sur des bases PostgreSQL temporaires et non sur une base de production.

### Correctifs backend ajoutés dans la présente continuation

1. Ajout d'un parseur numérique borné : refus de `NaN`, valeurs non entières, booléens, objets, nombres non sûrs et valeurs hors limites. Il est utilisé pour les paramètres de collecte saisis dans l'admin, les paramètres API de pagination et les valeurs de configuration backend qui pouvaient auparavant devenir `NaN`.
2. La validation de collecte compare désormais l'origine complète (`protocole + hôte + port`) et refuse les identifiants intégrés. Les liens d'extraction, les URL de départ et les URL de la requête API partagent la même politique. Une navigation finale redirigée hors origine échoue avant l'extraction et le staging de ses données.
3. La configuration de source refuse les IP littérales, les domaines locaux/internes et les ports personnalisés. La résolution DNS de domaines publics n'est pas épinglée ; ce contrôle ne prétend donc pas éliminer à lui seul tous les scénarios de DNS rebinding.
4. `backup.sh` utilise `umask 077` et fixe les dumps SQL et sidecars `.version` à `0600`. Le runner PostgreSQL vérifie désormais ces modes sur les sauvegardes qu'il crée.
5. Ajout de tests unitaires ciblés pour les bornes numériques, l'origine HTTP(S), les IP/domaines internes/ports personnalisés et les valeurs de collecte invalides.
6. Le contrôle racine et la CI ajoutent l'exécution de `frontend` `test:unit`, qui existait mais n'était pas inclus dans le contrôle global.
7. Ajout de `scripts/security-audit.sh` pour enregistrer les sorties `npm audit --json` du backend et du frontend dans un dossier privé, sans modifier les lockfiles.

### Contrôles exécutés sur cette copie de continuation

- `npm run check` backend : PASS.
- `bash -n` sur tous les scripts Bash backend : PASS.
- Tests ciblés `numeric`, `url-policy`, `source-admin` : 15/15 PASS.
- Tests frontend unitaires : 4/4 PASS.
- Suite backend complète sans `node_modules` dans l'environnement d'audit : 208 PASS / 2 fichiers non chargés (`pg` absent dans `db.test.js`, `fastify` absent dans `security.test.js`). En excluant explicitement ces deux fichiers, 208/208 tests passent. Ce résultat ne doit pas être confondu avec un échec fonctionnel ; la suite complète doit être relancée après `npm ci` sur le workspace cible.
- Le runner PostgreSQL fourni par l'utilisateur a réussi avant l'ajout des assertions de permissions `0600`. Il doit être relancé une fois après l'application de cette continuation pour certifier aussi les nouvelles assertions de confidentialité des fichiers de sauvegarde.

### Dépendances : décision de sécurité

La revue précédente du lockfile backend documente 12 findings de sévérité modérée associés à la branche `minimatch@9.0.9` utilisée transitivement par Crawlee. L'advisory GHSA-g3hv-75wg-m249/CVE-2026-118764 a un correctif à partir de `11.0.1` ; la description publiée porte sur une amplification de globparts lorsque `optimizationLevel >= 2`. Le projet n'accepte aucune entrée de glob minimatch fournie par utilisateur public dans son chemin de collecte ; les `product_url_regex` sont des regex JavaScript, distinctes de minimatch. Cela limite l'exposition démontrée mais ne supprime pas l'advisory.

Au 20 novembre 2026, `crawlee@3.18.2` est toujours le tag stable `latest`, tandis que les versions 4.0 sont en préversion RC/beta. Forcer `minimatch@11` dans une dépendance qui attend la branche 9, ou migrer vers Crawlee 4 RC, serait une mise à jour majeure non validée. Aucun override, `npm audit fix --force` ou remplacement de version n'a donc été appliqué. La sortie JSON d'audit doit être réexécutée sur l'environnement WSL disposant du registre npm, puis recontrôlée dès qu'une version stable compatible de Crawlee est publiée.

### Garde-fous conservés

Aucune activation de source, approbation de licence, écriture dans la base réelle, application de migration sur production, déploiement, commit ni push GitHub n'a été effectué. Les sources Lidl et Franprix restent désactivées en l'absence de preuve de licence/conditions d'utilisation validées.
