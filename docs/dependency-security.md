# Sécurité des dépendances — état du 21 novembre 2026

## Deux résultats à ne pas confondre

Le dernier `npm run verify:full` exécuté dans WSL a obtenu :

- backend : installation réussie ;
- frontend : installation réussie ;
- 217 tests backend et 4 tests frontend réussis ;
- build TypeScript/Vite réussi ;
- validation PostgreSQL temporaire réussie.

Le dernier `npm run audit:deps` a retourné `backend/scraper=0` et `frontend=0`. C'est le résultat de l'audit npm effectué sur les lockfiles de ce workspace. Les avertissements `lodash.isequal` et `whatwg-encoding` sont des avertissements de dépréciation, et non des vulnérabilités reportées par cet audit.

**Cela ne suffit pas à fermer l'avis GitHub GHSA-g3hv-75wg-m249.** L'avis GitHub est toujours publié et sa plage affichée inclut `minimatch` 9.x jusqu'à `11.0.0`. La condition de DoS décrite nécessite toutefois `optimizationLevel >= 2`.

## État du chemin Crawlee

Le lockfile courant contient `crawlee@3.18.2`, `@crawlee/core@3.18.2` et `minimatch@9.0.9`. L'appel observé dans `@crawlee/core` instancie `Minimatch` sans définir `optimizationLevel`; la valeur par défaut est 1. Le crawler MapNifique n'expose pas non plus de motifs glob contrôlés librement par les visiteurs.

Cela réduit l'exploitabilité de ce chemin précis, mais ne remplace pas un correctif de dépendance.

## Test de compatibilité isolé

Le workspace conserve `npm run test:security:minimatch`. Ce test crée une copie temporaire du backend, applique un override expérimental `minimatch@11`, installe les dépendances, exécute les tests backend, un smoke test `enqueueLinks`/Crawlee, l'audit et les tests PostgreSQL temporaires. Il n'écrase pas le lockfile de travail.

Ne pas appliquer `npm audit fix --force` ni un override directement dans le workspace tant que ce test isolé n'a pas réussi. Le résultat `npm audit=0` et le test de compatibilité sont deux contrôles différents.

## Références

- Avis : https://github.com/advisories/GHSA-g3hv-75wg-m249
- Source Crawlee : https://github.com/apify/crawlee/tree/master/packages/core
