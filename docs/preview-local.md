# Voir le preview MapNifique en local

## 1. Preview de développement (HMR)

Depuis WSL, à la racine de `MapNifique-Workspace` :

```bash
npm ci --prefix frontend
npm run dev
```

Ouvrir dans le navigateur Windows : <http://localhost:5173>. Arrêter le serveur avec `Ctrl+C`. Si le port est occupé, lancer `npm run dev -- --port 5174` puis ouvrir <http://localhost:5174>.

## 2. Preview du build de production

Après que `npm run build` a terminé sans erreur :

```bash
npm run preview
```

Ouvrir <http://localhost:4173>. Ce serveur sert le contenu compilé de `frontend/dist`, et non le serveur de développement. Il faut l'arrêter avec `Ctrl+C`.

## 3. Limites de l'API

Vite relaie `/api` vers `http://127.0.0.1:8787`. Sans API locale, le shell, les composants et une partie de la carte sont inspectables, mais les recherches PostgreSQL, les fiches alimentées par l'API et les promotions ne sont pas des tests de bout en bout valides. Ne pas inventer de magasins ou d'offres pour remplir l'écran.

Pour un preview complet, connecter le frontend uniquement à une API de staging liée à une base jetable ou à une copie anonymisée et vérifiée. Ne pas pointer le preview vers la base réelle. Le backend compose de ce workspace persiste les données dans un volume Docker local ; ne pas l'utiliser comme environnement jetable sans changer explicitement de projet et de volume.

## 4. Preview public

Aucune URL publique n'est certifiée comme correspondant à cette archive. Le projet Vercel `mapnifique` possède un déploiement READY, mais sa source `redeploy` et ses métadonnées Git ne permettent pas de l'associer à ce workspace. Ne pas présenter `mapnifique.vercel.app` comme la prévisualisation de ce code tant que l'alignement source/build n'a pas été vérifié.
