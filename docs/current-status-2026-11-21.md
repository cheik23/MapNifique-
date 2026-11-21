# MapNifique — état du 21 novembre 2026 (workspace v5)

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
- Les workflows maintenance/backups sautent proprement si leurs secrets ne sont pas configurés.
- Sources Lidl/Franprix maintenues désactivées tant qu'une autorisation de réutilisation n'est pas documentée.
