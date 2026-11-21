# MapNifique — état du projet au 21 novembre 2026

## Validations confirmées par le dernier lancement local

- `npm run verify:full` : terminé avec `MAPNIFIQUE_FULL_VALIDATION=PASS`.
- Frontend : `tsc -b` et `vite build` réussis ; 2 111 modules transformés.
- Lint : 0 avertissement et 0 erreur.
- Backend : 217 tests réussis, 0 échec.
- Frontend : 4 tests unitaires réussis, 0 échec.
- PostgreSQL temporaire : migrations neuves et historiques, validations d'identité et de lieux/offres, deux sessions concurrentes, upsert idempotent, backup/restore, contrôles d'isolation tmpfs et tests de réconciliation réussis (`OVERALL=PASS`). Le conteneur a été supprimé à la fin.

Ces résultats proviennent du lancement local effectué le 21 novembre 2026 dans `~/MapNifique-Finalisation-20261121/MapNifique-Workspace`. Ils ne certifient pas une base de production, un hébergement cloud ni un parcours utilisateur réel dans un navigateur.

## Commandes locales

À exécuter depuis la racine exacte `~/MapNifique-Finalisation-20261121/MapNifique-Workspace`, et non depuis l'ancien dossier `~/MapNifique-Backend-Hardening/MapNifique-Workspace` :

```bash
npm run preview
```

Le script racine délègue à Vite Preview sur `http://localhost:4173`. Le build doit avoir été généré au préalable et `frontend/node_modules` doit être installé. Le premier message « Missing script: preview » provenait de l'ancien workspace ; le package racine de cette archive contient maintenant le script.

## Points restant à traiter

1. **Publication Git/GitHub** — le lancement utilisateur a créé localement `work/mapnifique-finalisation-20261121` et le commit `f0674c7` dans `~/MapNifique-GitHub-Publish-20261121` (153 fichiers ; `36 287 insertions`, 136 suppressions). Le push HTTPS a échoué avec `No anonymous write access` après demande d'identifiants. La branche distante n'est donc pas encore publiée. Le script mis à jour détecte GitHub CLI ou SSH, reprend ce clone local sans refaire le commit et ne déclenche plus de prompt de mot de passe. Se connecter avec `gh auth login --hostname github.com --git-protocol https --web`, puis relancer `npm run publish:github`. `main` n'a pas été modifiée.
2. **Dépendances backend** — l'audit local utilisateur signale 12 findings modérés côté backend et 0 côté frontend ; ils se propagent à travers la chaîne Crawlee/minimatch. GHSA-g3hv-75wg-m249 affecte `minimatch >=7.0.0 <11.0.1`, corrigé à partir de 11.0.1. Crawlee 3.18.2 demande `minimatch ^9.0.0`. Le nouveau `npm run test:security:minimatch` teste un override en copie isolée, incluant installation, tests unitaires backend, smoke test Crawlee réel, audit npm et Postgres jetable ; il ne copie les manifests/lockfile au workspace source qu'après réussite totale. Ce protocole n'est pas encore exécuté, les 12 findings restent ouverts.
3. **Vérification navigateur** — exécuter la checklist `docs/browser-functional-checklist.md` : GPS réel, affichage cartographique, recherche, catégories, fiches lieux, offres, erreurs API, routes, responsive, accessibilité et installation PWA/iPhone. Aucun test navigateur E2E n'est certifié par les tests unitaires actuels.
4. **CI GitHub** — le workflow est configuré pour lancer lint, tests, build et PostgreSQL jetable sur PR vers `main`, mais il ne peut pas être vérifié avant la publication de la branche.
5. **Hébergement permanent** — aucun backend/API permanent, PostgreSQL/PostGIS cloud, worker planifié, DNS/TLS, sauvegarde externe avec restauration testée ni monitoring n'est certifié pour cette architecture. Le projet Vercel `mapnifique` est lié au dépôt historique `cheik23/MapNifique-`; le dernier déploiement `READY` (13 novembre 2026) est de source `redeploy`, sans commit Git vérifiable. `VITE_MAPNIFIQUE_API_URL` cible encore un Cloudflare Quick Tunnel temporaire pour Preview et Production. Ne pas redéployer cette architecture sur cette cible avant d'avoir configuré une API HTTPS stable. Après fusion, le build Vercel devra viser `frontend/` (ou équivalent) ; le backend et les workers devront être hébergés séparément.
6. **Sources de commerces et promotions** — garder les sources commerciales désactivées tant que licence, conditions d'utilisation, robots, attribution, fréquence et conservation ne sont pas documentés. Les offres ne doivent pas être inventées pour remplir la carte.
7. **Performance frontend** — Vite signale un chunk MapLibre d'environ 1,1 Mo non compressé. Ce n'est pas un échec de build ; une séparation de code autour de la carte est une optimisation recommandée avant montée en charge.

## Ordre de travail recommandé

1. Authentifier GitHub CLI ou SSH depuis WSL, reprendre la branche locale et ouvrir une PR, sans fusion automatique.
2. Exécuter `npm run test:security:minimatch` ; en cas de réussite, refaire la validation complète et l'audit.
3. Exécuter la checklist navigateur avec API et base de staging jetables.
4. Choisir et configurer hébergement API/PostGIS/worker, stockage des sauvegardes et monitoring ; vérifier une restauration réelle.
5. Faire la revue juridique/technique des sources et n'activer que les collecteurs approuvés.
6. Faire la revue de PR, attendre la CI verte, puis seulement décider d'une fusion et d'un déploiement.


## Mise à jour après le lancement utilisateur — 21 novembre 2026

- Le preview local a été lancé avec succès sur `http://localhost:4173`. Le shell Vite tourne ; aucun parcours fonctionnel complet n'en découle sans API/DB et tests navigateur.
- La publication Git a créé le clone de staging, la branche `work/mapnifique-finalisation-20261121` et le commit local `f0674c7` avec les 153 fichiers de l'archive. Le push HTTPS a échoué parce qu'aucun identifiant utilisable n'était fourni (`No anonymous write access`). La branche n'est pas sur GitHub à cette heure. `main` n'a pas été modifiée.
- Le script `publish-github-branch.sh` a été corrigé pour reprendre le clone local, détecter une authentification `gh`/SSH et éviter les prompts de mot de passe. Le prochain push doit utiliser `gh auth login ... --web` ou une clé SSH déjà associée au compte.
- Le workflow CI ajoute désormais un audit npm avec seuil `moderate`. Exécuter d'abord `npm run test:security:minimatch` ; le push ne doit intervenir qu'après une résolution vérifiée ou une décision documentée de laisser la CI en échec.
- Le test d'override reste expérimental, n'a pas encore été lancé dans WSL et ne signifie pas que les 12 findings sont résolus.


## Hébergement — complément de conformité (21 novembre 2026)

Ne pas prendre Vercel Hobby comme destination de production si MapNifique est exploité à des fins commerciales/monétisées : les conditions en vigueur le réservent à un usage personnel/non commercial. Option de référence mise à jour : un VPS x86 sert le frontend statique via Caddy et héberge API, PostgreSQL/PostGIS et workers ; alternative Cloudflare Pages pour frontend seulement après revue des conditions/quota applicables. Aucun plan payant ni VPS n'a été créé ou commandé.
