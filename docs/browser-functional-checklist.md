# MapNifique — contrôle fonctionnel navigateur

**Statut au 21 novembre 2026 : non exécuté dans un navigateur sur cette archive.** Les tests unitaires ne remplacent pas ces vérifications manuelles. Ce document sert de procès-verbal ; cocher et dater chaque cas uniquement après observation réelle.

## Démarrage du preview local

Depuis WSL, à la racine de `MapNifique-Workspace` :

```bash
npm ci --prefix frontend
npm run dev
```

Ouvrir `http://localhost:5173` dans le navigateur Windows. Arrêter Vite avec `Ctrl+C`. Si le port est occupé : `npm run dev -- --port 5174`, puis ouvrir `http://localhost:5174`.

Le proxy Vite envoie `/api` vers `http://127.0.0.1:8787`. Sans API, l’écran et la carte peuvent être inspectés, mais la recherche catalogue, les lieux servis par PostgreSQL, les promotions et certains itinéraires ne sont pas des tests end-to-end valides. Ne pas inventer de magasins ou d’offres pour remplir l’écran.

## Procès-verbal

Pour chaque contrôle, inscrire `PASS`, `FAIL` ou `NOT TESTED`, le navigateur/version, la taille d’écran, l’heure et la capture d’écran ou le journal non sensible.

| Parcours | Vérification attendue | Statut |
|---|---|---|
| Chargement à froid | L’application s’affiche sans écran blanc ; erreurs réseau lisibles ; aucun commerce/offre fictif | NOT TESTED |
| Carte | Tuiles chargées, attribution visible, centre et zoom cohérents, aucun débordement de panneau | NOT TESTED |
| Permission GPS acceptée | Le marqueur utilisateur apparaît seulement après autorisation ; rayon/proximité cohérents | NOT TESTED |
| Permission GPS refusée | Explication claire ; recherche libre ou centre de carte reste utilisable | NOT TESTED |
| GPS indisponible / timeout | Pas de localisation prétendue ; possibilité de relancer ou rechercher par ville | NOT TESTED |
| Recherche libre | Entrée, soumission, effacement, chargement, annulation d’une ancienne recherche | NOT TESTED |
| Recherche proximité | Coordonnées valides exigées ; rayon réellement appliqué côté API | NOT TESTED |
| Catégories | Beauty, alimentation, pharmacies, sport et catégories génériques ne se confondent pas | NOT TESTED |
| Fiche commerce | Nom, adresse, distance et provenance corrects ; fermeture/réouverture préserve le contexte | NOT TESTED |
| Promotions | Offre liée au bon magasin/à la bonne enseigne ; scope magasin/brand/online/cashback distinct | NOT TESTED |
| Expiration | Offre hors validité non visible ; date de fin incluse sur la journée locale Europe/Paris | NOT TESTED |
| Données absentes | État vide explicite ; aucun exemple commercial présenté comme réel | NOT TESTED |
| API arrêtée / timeout | État dégradé compréhensible ; aucune boucle de requêtes ni données périmées trompeuses | NOT TESTED |
| Itinéraire | Départ/destination corrects ; chargement, erreur, étapes et tracé cohérents | NOT TESTED |
| Responsive | 390×844, 768×1024, 1366×768 et 1920×1080 : commandes accessibles, carte utilisable | NOT TESTED |
| Accessibilité | Navigation clavier, focus visible, libellés, contrastes, mouvement réduit | NOT TESTED |
| PWA | Manifest, icônes, service worker, installation Safari iOS et mise à jour du cache vérifiés | NOT TESTED |

## Limites d'interprétation

- Le mode développement Vite n'est pas un build de production et n'est pas une URL publique.
- Le test API local doit utiliser une base de staging jetable ou une copie de production anonymisée et restaurée ; jamais la base réelle pour ce parcours.
- Un test visuel avec le backend arrêté ne valide ni la qualité des données, ni les offres, ni les itinéraires réels.
- Pour iOS Safari, effectuer le test sur un véritable iPhone ; l'émulation desktop ne valide pas l'installation PWA ni les permissions natives.
