# Sécurité des dépendances — état au 22 novembre 2026

## Deux résultats à ne pas confondre

Le dernier `npm run verify:full` exécuté dans WSL a obtenu :

- backend : installation réussie ;
- frontend : installation réussie ;
- 217 tests backend et 4 tests frontend réussis (21 novembre) ;
- build TypeScript/Vite réussi ;
- validation PostgreSQL temporaire réussie.

Le 22 novembre, après application de l'override vérifié (voir ci-dessous), les mêmes contrôles ont été rejoués sous WSL (Node 22.23.1) : 222 tests backend réussis, 4 tests frontend réussis, lint 0 avertissement/0 erreur, build Vite réussi, et `npm audit --audit-level=moderate` retourne `backend=0` et `frontend=0`. Les avertissements `lodash.isequal` et `whatwg-encoding` sont des avertissements de dépréciation, et non des vulnérabilités reportées par cet audit.

## État du chemin Crawlee

**Mise à jour du 22 novembre : l'override `minimatch ^11.0.1` est désormais appliqué** dans `backend/scraper/package.json` et le lockfile résout `minimatch@11.0.9`. L'avis GitHub GHSA-g3hv-75wg-m249 n'impacte plus l'arbre de dépendances : l'audit npm backend revient à zéro vulnérabilité. Crawlee 3.18.2 déclare toujours `minimatch ^9.0.0` ; l'override majeur est maintenu par le workflow `security-compatibility.yml`, qui rejoue l'essai isolé et vérifie que le manifeste applique bien la version 11.x à chaque push.

## Test de compatibilité isolé

Le workspace conserve `npm run test:security:minimatch`. Ce test crée une copie temporaire du backend, applique un override `minimatch@11`, installe les dépendances, exécute les tests backend, un smoke test `enqueueLinks`/Crawlee, l'audit et les tests PostgreSQL temporaires. Il n'écrase le lockfile de travail que si toutes les étapes réussissent.

**Résultat du 22 novembre 2026 (exécution WSL réelle) :** essai complet réussi — `MINIMATCH_LOCKED_VERSION=11.0.9`, 222/222 tests backend, `CRAWLEE_MINIMATCH_ENQUEUE_LINKS=PASS`, `AUDIT_TOTAL=0`, PostgreSQL `OVERALL=PASS` avec conteneur jetable supprimé, puis `MINIMATCH_OVERRIDE_APPLIED=PASS`. L'override a été appliqué uniquement après ce passage.

## Références

- Avis : https://github.com/advisories/GHSA-g3hv-75wg-m249
- Source Crawlee : https://github.com/apify/crawlee/tree/master/packages/core
