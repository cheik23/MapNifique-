# Publier la version validée dans GitHub sans toucher à main

Le dépôt GitHub `cheik23/MapNifique-` contient encore l'application historique monolithique sur `main`. Le workspace actuel est une nouvelle architecture React/TypeScript/Vite + Fastify/PostgreSQL/PostGIS. La publication doit donc passer par une branche de transition et une Pull Request ; ne pas remplacer `main` directement.

Depuis la racine de `MapNifique-Workspace` dans WSL :

```bash
bash scripts/publish-github-branch.sh
```

Le script crée un clone isolé dans `~/MapNifique-GitHub-Publish-20261121`, crée `work/mapnifique-finalisation-20261121` depuis `origin/main`, copie le workspace courant en excluant les répertoires `backups`, les dépendances installées, les builds, les données runtime, les bases locales et les secrets, crée un commit et pousse uniquement cette branche. Il ne fait ni commit ni push sur `main` et n'effectue aucune fusion ni aucun déploiement.

Prérequis : accès réseau GitHub depuis WSL, authentification Git configurée (Git Credential Manager ou clé SSH), `git` et `python3`. Le script conserve le clone local et son commit si le push échoue ; depuis ce dossier, après réparation de l'authentification, relancer `git push --set-upstream origin work/mapnifique-finalisation-20261121`.

Pour utiliser un autre nom de branche ou un autre dossier de staging :

```bash
MAPNIFIQUE_BRANCH=work/mapnifique-finalisation-20261121-v2 \
MAPNIFIQUE_PUBLISH_DIR="$HOME/MapNifique-GitHub-Publish-v2" \
bash scripts/publish-github-branch.sh
```

Après la publication, ouvrir la Pull Request affichée par le script. Examiner le diff complet, lancer/vérifier GitHub Actions, puis vérifier que le nouveau projet Vercel et les services backend sont bien rattachés au code attendu avant toute fusion ou mise en production.
