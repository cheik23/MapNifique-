# Déployer MapNifique sur Neon Free + Cloudflare Pages Free

Ce parcours ne doit déclencher aucune dépense. Choisir exclusivement les offres Free, ne pas ajouter de moyen de paiement, ne pas acheter de domaine et ne jamais activer un plan payant.

## 1. Créer la base Neon Free

1. Créer un compte sur https://console.neon.tech/ et un projet `mapnifique-prod`.

2. Choisir PostgreSQL 17 et la région AWS Europe (Francfort) `aws-eu-central-1`. Au 21 novembre 2026, Neon Functions ne sont disponibles en Europe que dans cette région ; `eu-west-1` ne convient pas pour cette fonction.

3. Garder le plan Free. La base doit être neuve et vide.

4. Récupérer la chaîne de connexion directe de la branche `main` ; ne pas la coller dans le dépôt.

Neon Free annonce 1 Go de stockage, 100 heures-CU par mois, PostGIS et un quota Functions. Vérifier les quotas dans la console avant toute utilisation.

## 2. Appliquer le schéma sur la base vide

Dans WSL, depuis la racine de `MapNifique-Workspace` :

```bash

cd backend/scraper

npm ci

cd ../..

read -rsp 'URL Neon directe (saisie masquée) : ' DATABASE_URL

echo

export DATABASE_URL

bash scripts/apply-neon-migrations.sh

unset DATABASE_URL

```

Le script refuse toute relation du schéma public (tables ordinaires ou partitionnées, vues, vues matérialisées, séquences et tables étrangères) en vérifiant pg_class JOIN pg_namespace sur n.nspname='public' et c.relkind IN ('r','p','v','m','S','f'). Il applique les migrations 000 à 003, exécute l'audit/réconciliation d'identité et exige le schéma v2. Ne l'utilise pas pour mettre à jour une base existante.

## 3. Déployer l'API Neon Function

```bash

npm i -g neon@latest

neon login

neon projects list

```

Récupère l'identifiant du projet Neon et lance :

```bash

export NEON_PROJECT_ID='IDENTIFIANT_PROJET'

export NEON_BRANCH='main'

npm run deploy:neon

unset NEON_PROJECT_ID NEON_BRANCH

```

Le CLI déploie `backend/scraper/functions/api.js` avec le runtime Node.js 24, `CORS_ORIGINS=https://mapnifique.pages.dev` et un pool PostgreSQL limité à deux connexions. La variable `DATABASE_URL` est fournie par Neon Functions. Le CLI affiche l'URL de la fonction : la conserver dans un gestionnaire privé, pas dans Git.

Pour l'administration des sources, un `PLACES_ADMIN_TOKEN` doit être configuré comme variable secrète de fonction via la console Neon. Ne le mets jamais dans `VITE_*` ni dans GitHub public.

## 4. Publier le frontend sur Cloudflare Pages Free

1. Créer un compte Cloudflare Free et un projet Pages nommé `mapnifique` relié au dépôt GitHub public.

2. Choisir la branche `main` seulement après la revue et la fusion de la Pull Request.

3. Répertoire racine : `frontend`.

4. Commande de build : `npm ci && npm run build`.

5. Répertoire de sortie : `dist`.

6. Variable de build `VITE_MAPNIFIQUE_API_URL` : URL de Neon Function (sans ajouter `/api`).
