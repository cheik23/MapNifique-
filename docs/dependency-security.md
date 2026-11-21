# MapNifique — revue de sécurité des dépendances

**Date : 21 novembre 2026**

## État lockfile

| Package | Version effectivement verrouillée | Déclaration minimale | Note |
|---|---:|---:|---|
| `fastify` | 5.12.8 | `^5.12.8` | Aligné sur le correctif Fastify 5.x ; ne pas redescendre en 5.6.x |
| `@fastify/cors` | 11.4.3 | `^11.4.3` | Déclaration alignée sur le lockfile |
| `crawlee` | 3.18.2 | `^3.18.2` | Version stable `latest` observée ; 3.18.3 est encore préversion `beta` |
| `@crawlee/core` | 3.18.2 | transitif | Déclare `minimatch ^9.0.0` |
| `minimatch` | 9.0.9 | `^9.0.0` via `@crawlee/core` | Affecté par GHSA-g3hv-75wg-m249 (`>=7.0.0` et `<11.0.1`) ; correction à partir de 11.0.1 ; candidat de test : 11.0.9 |

La commande `npm ci` exécutée par l'utilisateur le 20 novembre a signalé 12 vulnérabilités modérées dans le backend et 0 dans le frontend. Le fichier `backups/security-audit-20261120T224314Z/backend-scraper.json` reste la source exacte du rapport : 12 est un nombre de findings npm, pas nécessairement 12 failles différentes. Le résumé local lisible est maintenant disponible :

```bash
npm run audit:deps
npm run audit:deps:summary
```

Ou en pointant un rapport antérieur :

```bash
npm run audit:deps:summary -- backups/security-audit-20261120T224314Z
```

## Analyse du finding minimatch

L'avis concerne une amplification de `globParts` lorsque `optimizationLevel >= 2` et qu'un motif glob contrôlé par un attaquant est compilé. Le défaut n'est pas limité à une méthode appelée directement par MapNifique ; il existe dans le package transitif, d'où la présence dans `npm audit`.

La revue de la chaîne applicative a trouvé :

- l'appel MapNifique à Crawlee `enqueueLinks` fournit `strategy: 'same-domain'` et `transformRequestFunction`, sans fournir `globs`, `include` ni `exclude` configurables par l'utilisateur ;
- le motif de produit est un `RegExp` JavaScript construit par `compileProductPattern`, pas un motif `minimatch` ;
- la source est limitée à une origine HTTP(S) publique, sans IP littérale, domaine interne ni port arbitraire ; chaque URL candidate est contrôlée avant d'être traitée ;
- Crawlee 3.18.2 construit ses objets `Minimatch` avec `{ nocase: true }`, sans demander `optimizationLevel: 2` ; minimatch conserve le niveau 1 par défaut.

Ces mesures réduisent la voie d'exploitation observée dans le flux actuel, mais elles ne suppriment ni l'advisory ni le finding npm. L'avis GitHub définit la plage affectée comme `>= 7.0.0` et `< 11.0.1` ; la première version corrigée est `11.0.1`. Au 21 novembre 2026, `11.0.9` est la dernière version publiée de minimatch (16 novembre) et les bases consultées ne signalent pas d'avis connu sur cette version.

Le package stable `crawlee` publié avec le tag npm `latest` reste `3.18.2` ; `3.18.3` est encore une préversion beta. `@crawlee/core@3.18.2` déclare `minimatch ^9.0.0`. Aucun override 11.x n'a été appliqué : il franchirait une limite majeure non déclarée par Crawlee. Le seul usage repéré par Crawlee dans ce chemin est `new Minimatch(...).match(...)`, qui semble compatible d'après l'API consultée, mais cela ne remplace pas une installation, la suite du crawler Playwright et un crawl synthétique autorisé.

## Procédure de mise à jour sûre

1. Refaire `npm run audit:deps` et `npm run audit:deps:summary` lorsque le registre npm est accessible ; conserver les JSON avant/après.
2. Vérifier dans les advisories la version affectée, les chemins `nodes`, et `fixAvailable` ; séparer les vraies vulnérabilités des simples warnings de dépréciation npm.
3. Préférer une version stable de Crawlee qui élargit sa contrainte minimatch vers une version corrigée. À défaut, tester isolément un override limité à `@crawlee/core -> minimatch@11.0.9` sur une branche/copie, en gardant à l’esprit que c’est un override de major non garanti par l'amont.
4. Sur une branche/copie séparée : générer le lockfile avec npm depuis le registre, vérifier qu’aucun autre package ne force minimatch 9, lancer les tests backend, les tests crawler Playwright, le runner PostgreSQL complet, puis un crawl synthétique autorisé à faible volume. Revenir à la version précédente au moindre échec.
5. Rejeter toute mise à jour qui utilise `npm audit fix --force`, qui rétrograde Crawlee, ou qui introduit des changements non testés.

Les avertissements `lodash.isequal` et `whatwg-encoding` sont des notices de dépréciation affichées lors de l'installation ; ils ne doivent pas être comptés comme des vulnérabilités sans advisory correspondant.
