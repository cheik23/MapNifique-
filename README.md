# freebuff-map

PWA de cartographie : carte interactive (Leaflet), recherche vocale, scan de produits
(Open Food Facts), comparateur, marketplace d'applications, espace développeur
et abonnement Premium.

## Prérequis

- Node.js 18 ou plus récent
- npm

## Lancer le projet en local

```bash
npm install
npm run dev
```

Vite affiche l'URL locale (par défaut <http://localhost:5173>).
Le micro et la géolocalisation fonctionnent sur `localhost` ou en HTTPS.

## Construire pour la production

```bash
npm run build
```

Le résultat est généré dans `dist/`. Pour le prévisualiser avant de déployer :

```bash
npm run preview
```

## Déploiement

- `vite.config.js` définit `base: './'` : les chemins restent relatifs, donc
  l'app fonctionne aussi dans un sous-dossier (GitHub Pages).
- `vercel.json` ajoute le fallback SPA : toutes les routes sont servies par
  `index.html`.
- Pour Netlify, créer un fichier `_redirects` contenant :
  `/*  /index.html  200`

## Repères dans le code

| Fichier | Rôle |
|---|---|
| `index.html` | Structure, styles et vues identifiées par `data-view` |
| `src/main.js` | Navigation (`showView`), voix, scan, comparateur, auth, marketplace, onboarding |
| `src/db.js` | IndexedDB v2 : `recherches`, `produits`, `offres`, `developer_apps`, `users` |
| `sw.js` | Service Worker : hors-ligne, cache des tuiles et des appels Open Food Facts |
| `public/icons/` | Icônes PWA 192×192 et 512×512 |
