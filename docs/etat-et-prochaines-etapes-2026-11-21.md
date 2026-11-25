# MapNifique — rapport d’état et clôture des travaux disponibles

**Date : 21 novembre 2026**
**Workspace :** `MapNifique-Workspace`
**Dépôt cible :** `cheik23/MapNifique-`
**Branche de transition :** `work/mapnifique-finalisation-20261121`

## 1. Éléments confirmés

| Chantier | État vérifié |
|---|---|
| Build TypeScript (`tsc -b`) et Vite | PASS |
| Lint frontend | 0 avertissement, 0 erreur |
| Tests backend | 217/217 PASS |
| Tests unitaires frontend | 4/4 PASS |
| PostgreSQL temporaire | `OVERALL=PASS` ; conteneur supprimé |
| Preview Vite local | Démarré sur `http://localhost:4173` |
| Publication Git locale | Branche et commit créés localement |
| Push GitHub | BLOQUÉ : authentification HTTPS absente |

Les résultats de build et PostgreSQL proviennent du lancement WSL communiqué par l'utilisateur le 21 novembre. Le preview confirme seulement le démarrage de Vite Preview. Il ne certifie pas le GPS, les recherches API, les promotions, les itinéraires ou l'UX mobile.

## 2. État Git précis

Le dépôt `main` de GitHub correspond à l'ancien monolithe. Pour éviter de remplacer directement l'historique, la nouvelle architecture a été synchronisée dans un clone isolé :

- Clone : `~/MapNifique-GitHub-Publish-20261121`
- Branche : `work/mapnifique-finalisation-20261121`
- Commit initial local : `f0674c7`
- Contenu : 153 fichiers, environ 36 287 insertions et 136 suppressions
- État distant : le push a échoué avec `No anonymous write access` ; aucune branche distante n'a été créée
- `main` : non modifiée

Le script actualisé sait reprendre le clone de staging, ajouter les derniers fichiers et pousser sans force-push. Il vérifie d'abord une authentification `gh` ou SSH et n'ouvre plus de prompt mot de passe.

## 3. Sécurité des dépendances

Le dernier audit communiqué indique **12 findings modérés backend et 0 frontend**. Le finding `minimatch` concerne les versions `>=7.0.0` et `<11.0.1`, corrigées à partir de `11.0.1`. `@crawlee/core@3.18.2` déclare encore `minimatch ^9.0.0`, donc un override majeur n'est pas à appliquer sans tests de compatibilité.

Le workspace fournit `npm run test:security:minimatch`. Le script :

1. copie le backend dans un répertoire temporaire ;
2. teste un override global `minimatch ^11.0.1` et régénère le lockfile ;
3. effectue l'installation propre, le check de syntaxe et la suite backend ;
4. lance un smoke test `CheerioCrawler + enqueueLinks + globs` sur un serveur local ;
5. exige un audit npm à zéro vulnérabilité ;
6. relance le runner PostgreSQL jetable ;
7. ne copie `package.json` et `package-lock.json` dans le workspace que si toutes les étapes réussissent.

Ce script n'a pas encore été exécuté dans WSL. Ne pas présenter les 12 findings comme résolus. Si l'essai échoue, le dossier temporaire est conservé et le workspace source n'est pas modifié. Le workflow CI inclut maintenant un audit npm `--audit-level=moderate`, donc il faut traiter ce blocage avant d'attendre une CI verte.

## 4. Prochaines commandes exactes

### A. Depuis le workspace courant

```bash
cd ~/MapNifique-Finalisation-20261121/MapNifique-Workspace
npm run test:security:minimatch
```

En cas de succès seulement :

```bash
npm ci --prefix backend/scraper
npm run verify:full
npm run audit:deps
npm run audit:deps:summary
```

### B. Authentifier GitHub dans WSL

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
npm run publish:github
```

Autoriser la session depuis le navigateur. Ne jamais coller le mot de passe GitHub ou un PAT dans le chat ou dans une commande shell. Si `gh` n'est pas installé, l'installer depuis https://cli.github.com/.

Le script pousse uniquement `work/mapnifique-finalisation-20261121`. Après un push, ouvrir et examiner la Pull Request :

`https://github.com/cheik23/MapNifique-/compare/main...work/mapnifique-finalisation-20261121?expand=1`

Ne pas fusionner tant que la CI n'est pas verte et que le diff n'a pas été relu.

## 5. Chantiers restant à réaliser

| Chantier | Ce qui manque |
|---|---|
| GitHub | Authentifier `gh`, pousser la branche et ouvrir la PR |
| Vulnérabilités | Faire réussir le test d'override ou choisir une mise à jour Crawlee officiellement compatible ; atteindre un audit backend à zéro |
| CI | Exécuter les workflows sur la PR, analyser chaque échec et obtenir tous les checks verts |
| Parcours navigateur | Tester GPS accepté/refusé, recherche globale/proximité, catégories, fiches, offres, état vide, API indisponible, routes, écrans responsive, clavier et PWA iOS |
| Staging | Disposer d'une API HTTPS stable et d'une base PostgreSQL/PostGIS isolée contenant des données de test non sensibles |
| Hébergement permanent | API Fastify, DB privée et persistante, workers et scheduler durables, stockage/quotas et réseau ; option technique recommandée documentée (VPS x86 8 Go + R2) mais aucun compte/service créé |
| Sauvegardes | Dumps chiffrés hors hôte, rétention documentée, restauration complète testée depuis le stockage cloud |
| Observabilité | Alertes API/DB/workers, logs structurés et expurgés, métriques, alertes de fraîcheur des données |
| Sources commerciales | Documenter licence/droits, robots, attribution, fréquence, contact et conservation avant activation ; Lidl/Franprix restent désactivés |
| Déploiement public | Corriger le lien Vercel vers le nouveau repo/branche et configurer son root `frontend/` après revue ; déployer l'API séparément |

## 6. Constat Vercel — inspection sans modification

Le projet existant `mapnifique` est lié au dépôt GitHub `cheik23/MapNifique-` et a un dernier déploiement `READY` de source `redeploy`, sans SHA de commit vérifiable. Sa variable frontend `VITE_MAPNIFIQUE_API_URL` cible encore un Cloudflare Quick Tunnel temporaire. Une Quick Tunnel sert à l'expérimentation, pas à une disponibilité publique permanente ; il faut une URL API stable et HTTPS. L'architecture monorepo nécessite un build Vercel depuis `frontend/` (ou configuration équivalente).

Aucun paramètre Vercel, secret, DNS, déploiement ou service cloud n'a été modifié. Le backend, PostgreSQL/PostGIS et les workers ne peuvent pas être considérés comme hébergés en permanence.

## 7. Architecture d’hébergement recommandée

Le comparatif documenté écarte Render Free (arrêt après inactivité et DB Free de 30 jours), Supabase Free (pause après sept jours et absence de backup automatique), Railway Free (sleep) et Oracle A1 (ARM alors que le PostGIS Docker actuel est amd64). Pour une première exploitation publique PC éteint, la cible la plus simple et la plus sobre est un VPS x86 4 vCPU/8 Go qui sert le frontend statique via Caddy et héberge l'API Fastify, PostGIS et les workers ; les sauvegardes seront chiffrées hors hôte sur R2. Le VPS-2 OVH est actuellement affiché autour de 8,65 € TTC/mois dans la gamme annoncée 2027 ; le prix et les options doivent être revérifiés avant commande. Vercel Hobby est réservé à l'usage personnel/non commercial ; si MapNifique est exploité commercialement, il ne faut pas déployer sur ce plan. Ce choix reste une proposition, aucun achat/compte n’a été effectué. Voir `docs/hosting-options-2026-11-21.md`.

## 8. Décision technique

La compilation, les tests unitaires et les tests PostgreSQL jetables sont finalisés et confirmés. La publication distante est bloquée uniquement par l'authentification du Git local. Les vulnérabilités, tests E2E, staging et infrastructure publique restent des gates réels ; ils ne doivent pas être « validés » par simple mise à jour de documentation. Aucun déploiement de production, changement de base réelle ni activation de source commerciale n'a été effectué.


## Addendum — précaution sur le plan Vercel Hobby (21 novembre 2026)

La revue des conditions Vercel datées du 19 octobre 2026 confirme que le plan Hobby est réservé à l'usage personnel ou non commercial ; Vercel présente Pro à 20 USD/mois. Étant donné l'objectif potentiel de revenus/commissions de MapNifique, le choix par défaut retenu pour la première exploitation commerciale est désormais un VPS x86 unique qui sert frontend, API, DB et workers. Cloudflare Pages reste une alternative statique séparée sous réserve de valider les conditions applicables à l'usage commercial visé. Aucun compte n'a été modifié et aucun paiement effectué.
