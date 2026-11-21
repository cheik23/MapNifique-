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

1. **Publication Git/GitHub** — le dépôt distant actuel `cheik23/MapNifique-` a encore l'ancien monolithe sur `main`. Cette session peut lire le dépôt, mais l'API GitHub a refusé la création de branche (HTTP 403). La publication n'est donc pas déclarée faite. Le script `scripts/publish-github-branch.sh`, accessible avec `npm run publish:github`, prépare un clone isolé, crée une branche de transition depuis `main`, exclut secrets/sauvegardes/builds, commit et pousse uniquement cette branche. Il a été testé sur un dépôt Git local simulé ; le push vers le véritable GitHub reste à faire depuis WSL avec l'authentification Git de l'utilisateur. Ne pas fusionner directement dans `main`.
2. **Dépendances backend** — l'audit du 21 novembre signale 12 findings modérés côté backend et 0 côté frontend. Le résumé relie l'essentiel au `minimatch@9.0.9` transitif de Crawlee. GHSA-g3hv-75wg-m249 affecte `minimatch >=7.0.0 <11.0.1`, corrigé à partir de 11.0.1. Crawlee 3.18.2 demande `minimatch ^9.0.0`; un override 11.x doit être testé dans une branche isolée avec `npm ci`, tests backend, crawl Playwright synthétique et audit après mise à jour. Aucun `npm audit fix --force` n'a été lancé et aucun override non testé n'a été commité.
3. **Vérification navigateur** — exécuter la checklist `docs/browser-functional-checklist.md` : GPS réel, affichage cartographique, recherche, catégories, fiches lieux, offres, erreurs API, routes, responsive, accessibilité et installation PWA/iPhone. Aucun test navigateur E2E n'est certifié par les tests unitaires actuels.
4. **CI GitHub** — le workflow est configuré pour lancer lint, tests, build et PostgreSQL jetable sur PR vers `main`, mais il ne peut pas être vérifié avant la publication de la branche.
5. **Hébergement permanent** — aucun backend/API permanent, PostgreSQL/PostGIS cloud, worker planifié, DNS/TLS, sauvegarde externe avec restauration testée ni monitoring n'est certifié pour cette architecture. Le déploiement Vercel existant n'a pas été relié avec preuve à cette archive. Il ne faut donc pas présenter l'application actuelle comme prête pour une production publique indépendante.
6. **Sources de commerces et promotions** — garder les sources commerciales désactivées tant que licence, conditions d'utilisation, robots, attribution, fréquence et conservation ne sont pas documentés. Les offres ne doivent pas être inventées pour remplir la carte.
7. **Performance frontend** — Vite signale un chunk MapLibre d'environ 1,1 Mo non compressé. Ce n'est pas un échec de build ; une séparation de code autour de la carte est une optimisation recommandée avant montée en charge.

## Ordre de travail recommandé

1. Publier la branche de transition et ouvrir une PR, sans fusion automatique.
2. Examiner l'audit npm JSON complet et faire un test isolé de minimatch 11.0.9.
3. Exécuter la checklist navigateur avec API et base de staging jetables.
4. Choisir et configurer hébergement API/PostGIS/worker, stockage des sauvegardes et monitoring ; vérifier une restauration réelle.
5. Faire la revue juridique/technique des sources et n'activer que les collecteurs approuvés.
6. Faire la revue de PR, attendre la CI verte, puis seulement décider d'une fusion et d'un déploiement.
