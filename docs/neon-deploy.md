# Déployer MapNifique sur Neon Free + Cloudflare Pages Free

Ce parcours ne doit déclencher aucune dépense. Choisir exclusivement les offres Free, ne pas ajouter de moyen de paiement, ne pas acheter de domaine et ne jamais activer un plan payant.

## 1. Créer la base Neon Free

1. Créer un compte sur https://console.neon.tech/ et un projet `mapnifique-prod`.
2. Choisir PostgreSQL 17 et une région européenne disponible (par exemple AWS `eu-west-1` si proposée).
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

Le script refuse toute base qui contient déjà `schema_state`. Il applique les migrations 000 à 003, exécute l'audit/réconciliation d'identité et exige le schéma v2. Ne l'utilise pas pour mettre à jour une base existante.

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
7. Ne pas ajouter de domaine personnalisé ; utiliser `https://mapnifique.pages.dev`.

Le site est un frontend statique ; l'API est exécutée par Neon Functions. Vite `preview` reste strictement local sur `127.0.0.1`.

## 5. Activer le nettoyage quotidien des offres

Après avoir ajouté le secret GitHub Actions `NEON_DATABASE_URL` (chaîne de connexion de la base), le workflow `maintenance-neon.yml` exécute chaque jour `offers-worker` en mode `OFFERS_ONCE=1`. Les sources restent désactivées car `OFFERS_ENABLED_SOURCES` est vide et `OFFERS_SOURCE_LICENSE_APPROVED=false`. Le job ne fait que la rétention et l'expiration selon `Europe/Paris`.

## 6. Créer le stockage de sauvegarde séparé

1. Créer un SECOND projet Neon Free `mapnifique-backups`.
2. Créer un bucket privé `mapnifique-backups` dans Object Storage.
3. Générer une paire de clés `age` localement :

```bash
age-keygen -o "$HOME/.mapnifique-age-key.txt"
chmod 600 "$HOME/.mapnifique-age-key.txt"
age-keygen -y "$HOME/.mapnifique-age-key.txt"
```

Conserver la clé privée hors cloud et hors Git ; copier seulement la clé publique produite dans le secret `AGE_RECIPIENT`.
4. Créer les secrets GitHub Actions :
   - `NEON_DATABASE_URL`
   - `AGE_RECIPIENT` (clé publique)
   - `NEON_BACKUP_ACCESS_KEY_ID`
   - `NEON_BACKUP_SECRET_ACCESS_KEY`
   - `NEON_BACKUP_ENDPOINT`
   - `NEON_BACKUP_REGION`
   - `NEON_BACKUP_BUCKET`
5. Le workflow `backup-neon.yml` s'exécute chaque dimanche. Tant qu'un secret manque, il s'arrête proprement sans installer de logiciel ni contacter la base.

Le bucket doit rester privé. Le workflow conserve quatre sauvegardes au maximum, chiffre avant upload et refuse tout dépassement du plafond défini.

## 7. Tester une restauration

Télécharger une sauvegarde chiffrée du bucket vers une machine locale, puis créer une nouvelle base Neon Free vide ou une base de test locale PostgreSQL 17. Exécuter :

```bash
export BACKUP_FILE='/chemin/backup.dump.age'
export AGE_IDENTITY_FILE='/chemin/age-private-key.txt'
export RESTORE_DATABASE_URL='CONNEXION_VERS_BASE_VIDE'
bash scripts/restore-neon-backup.sh
unset BACKUP_FILE AGE_IDENTITY_FILE RESTORE_DATABASE_URL
```

Le script refuse une base contenant déjà des objets publics et vérifie que la version restaurée est `2`.

## 8. Règles de zéro dépense

- Ne pas changer les plans Neon ou Cloudflare vers un plan payant.
- Ne pas ajouter de moyen de paiement.
- Ne pas utiliser de runners GitHub plus grands.
- Ne pas stocker des sauvegardes comme GitHub Actions artifacts ; le bucket Neon Free séparé est utilisé.
- Si un quota Free est atteint, l'action doit échouer proprement ou le service se mettre en pause. Ne pas contourner les quotas.

### Récupérer une sauvegarde avant restauration

Depuis une machine où les clés S3 du projet de sauvegarde sont configurées, télécharger l'objet choisi :

```bash
aws s3 cp 's3://BUCKET/weekly/OBJET.dump.age' ./mapnifique-backup.dump.age \
  --endpoint-url "$AWS_ENDPOINT_URL_S3" --region "$AWS_REGION"
```

La clé privée `~/.mapnifique-age-key.txt` ne doit jamais être ajoutée à GitHub ni à Neon.
