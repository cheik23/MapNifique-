# Publier la version validée dans GitHub sans toucher à main

Le dépôt GitHub `cheik23/MapNifique-` contient l'ancien monolithe sur `main`. Le nouveau workspace React/TypeScript/Vite + Fastify/PostgreSQL/PostGIS est publié sur une branche de transition et une Pull Request ; aucune fusion automatique n'est effectuée.

## État après la première tentative

Le script précédent a créé localement la branche `work/mapnifique-finalisation-20261121` et le commit `f0674c7` dans `~/MapNifique-GitHub-Publish-20261121`. Le push HTTPS a échoué car GitHub n'a pas reçu d'identifiants utilisables (`No anonymous write access`). Le commit local `f0674c7` est conservé ; il ne faut pas relancer un nouveau clone ni supprimer ce dossier. L’exécution du script a confirmé que les 153 fichiers ont été synchronisés et commités localement ; seul le push distant a échoué.

## Authentifier WSL sans coller de mot de passe ou de token dans le terminal

Méthode recommandée : GitHub CLI via la connexion web OAuth :

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
```

Autorise la connexion dans le navigateur. Ne colle aucun mot de passe GitHub ou jeton dans une commande Git. Une clé SSH GitHub déjà configurée est également acceptée.

## Reprendre la publication

Depuis la racine `MapNifique-Workspace`, installer la version actualisée de ce script puis lancer :

```bash
npm run publish:github
```

Le script actualisé :
- vérifie les identifiants avant toute opération Git distante ; détecte une session `gh` authentifiée ou une clé SSH ;
- ne déclenche pas de prompt mot de passe HTTPS et interrompt proprement si aucun mécanisme utilisable n’est disponible ;
- reconnaît le clone staging existant et reprend le commit local ;
- synchronise les derniers fichiers du workspace avant le push ;
- ne fait jamais de force-push et ne pousse jamais sur `main`.

Le clone local est conservé dans `~/MapNifique-GitHub-Publish-20261121`. Le lien PR s'affiche après un push réussi :

`https://github.com/cheik23/MapNifique-/compare/main...work/mapnifique-finalisation-20261121?expand=1`

Examiner le diff, attendre une CI verte, puis seulement envisager la fusion. Ne pas déployer avant d'avoir vérifié que Vercel, l'API et la base pointent vers l'architecture attendue.


## Ordre recommandé après le commit local existant

Le workflow CI inclut maintenant un `npm audit --audit-level=moderate` pour le backend. Il échouera tant que les 12 findings backend subsistent. Avant de pousser la branche et d'ouvrir une PR, exécuter depuis le workspace source :

```bash
npm run test:security:minimatch
```

Ce test n'applique l'override `minimatch` au workspace source que si l'essai isolé complet réussit. En cas de succès, réinstaller et valider le workspace puis refaire l'audit :

```bash
npm ci --prefix backend/scraper
npm run verify:full
npm run audit:deps
npm run audit:deps:summary
```

Si l'essai isolé échoue, ne pas contourner le contrôle CI avec `npm audit fix --force`. Le dossier temporaire est conservé pour inspection.

Authentifier GitHub seulement après ces validations :

```bash
gh auth login --hostname github.com --git-protocol https --web
gh auth status --hostname github.com
npm run publish:github
```
