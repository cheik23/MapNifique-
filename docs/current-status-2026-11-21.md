# MapNifique — état du 21 novembre 2026 (workspace v6)

## Confirmé sur la base v4 par l'exécution WSL de l'utilisateur

- `npm run verify:full` : PASS ; TypeScript et Vite compilent.
- Backend : 217/217 tests PASS ; frontend : 4/4 PASS.
- PostgreSQL temporaire : OVERALL=PASS, conteneur supprimé et données synthétiques isolées.
- `npm run audit:deps` : backend=0, frontend=0 lors du dernier audit npm.
- `npm run preview` démarre sur le port 4173.

## Ajouts v5 qui nécessitent un nouveau passage de tests

- Extraction des routes Fastify dans `src/app.js`, serveur local conservé dans `src/server.js`.
- Adaptateur Neon Functions Node.js 24 via `Fastify.inject()`.
- Deux tests pour l'app factory et CORS Pages.
- MapLibre devient le moteur par défaut et charge le style OpenFreeMap sans clé.
- Preview local limité à `127.0.0.1`.
- Workflows CI de branche, test de compatibilité minimatch, maintenance quotidienne et sauvegarde hebdomadaire chiffrée.

**Important :** les ajouts v5 n'ont pas encore été exécutés dans l'environnement WSL de l'utilisateur ni dans GitHub Actions. L'ancien `PASS` v4 ne certifie pas automatiquement ces changements.

## Sécurité

- Le dernier npm audit est à zéro selon le log WSL.
- L'avis GitHub GHSA-g3hv-75wg-m249 reste suivi, car sa plage publiée englobe la version minimatch du lockfile. Le chemin Crawlee observé utilise le niveau d'optimisation par défaut, mais le test d'override isolé doit encore être lancé.
- Ne pas forcer une version majeure sans preuve de compatibilité.

## Publication et production

- Branche locale connue : `work/mapnifique-finalisation-20261121` ; commits `f0674c7` et `e146339` présents dans le clone WSL du même nom.
- Aucun push GitHub confirmé : l'authentification HTTPS a échoué et `gh` n'était pas installé dans WSL.
- Aucun projet Neon/Cloudflare n'a été créé ; aucun service cloud n'a été activé.
- v6 ajoute un worker Playwright one-shot périodique sur GitHub Actions public ; le workflow reste inactif tant que le secret NEON_DATABASE_URL est absent.
- v6 ajoute un worker Playwright one-shot périodique sur GitHub Actions public ; le workflow reste inactif tant que le secret NEON_DATABASE_URL est absent.
- Les workflows maintenance/backups sautent proprement si leurs secrets ne sont pas configurés.
- Sources Lidl/Franprix maintenues désactivées tant qu'une autorisation de réutilisation n'est pas documentée.


## Addendum v6 — 21 novembre 2026

- Le worker Crawlee/Playwright peut maintenant faire un passage unique (`WORKER_RUN_ONCE=1`) et relâcher le lease si le budget de temps est atteint.
- Nouveau workflow `.github/workflows/crawler-worker.yml` : runner standard GitHub Actions public toutes les 10 minutes, au plus un job et 8 minutes de collecte. Le workflow reste inactif si `NEON_DATABASE_URL` n'est pas configuré.
- Le guide Neon impose Francfort (`aws-eu-central-1`) pour Neon Functions en Europe.
- Le script de publication a été corrigé : sur un dépôt public, la lecture anonyme de `main` n'est plus considérée comme une authentification d'écriture.
- Validation statique du workspace v6 dans l'environnement assistant : syntaxe JavaScript, shell, JSON, YAML et intégrité ZIP PASS.
- Les tests `npm ci`, `verify:full`, audit npm et tests PostgreSQL de v6 n'ont pas été rejoués ici : le registre npm n'était pas joignable et le cache npm était incomplet. Le précédent PASS de la v4 ne certifie pas la v5/v6.
- Aucune branche de revue n'existe encore sur GitHub ; les commits `f0674c7`, `e146339` et `8d4c6c4` restent locaux. Le push échoue faute d'authentification GitHub en écriture.
