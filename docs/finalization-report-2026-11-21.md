# Rapport de finalisation — 21 novembre 2026, workspace v5

## État des chantiers

| Chantier | État |
|---|---|
| Build TypeScript / Vite (v4) | PASS confirmé par le log WSL utilisateur ; v5 à revalider |
| Tests backend / frontend (v4) | 217/217 + 4/4 PASS ; v5 ajoute 2 tests à revalider |
| PostgreSQL temporaire (v4) | OVERALL=PASS ; v5 à revalider |
| Preview | Corrigé pour écouter uniquement sur 127.0.0.1 |
| Publication GitHub | Script renforcé ; authentification WSL manquante, push non confirmé |
| Sécurité npm | Audit npm v4 à zéro ; GHSA minimatch toujours suivi, test override isolé en CI |
| API hébergée | Adaptateur Neon Functions préparé ; déploiement non effectué |
| Base hébergée | Procédure Neon Free préparée ; projet non créé |
| Sauvegardes | Scripts de dump/chiffrement/stockage/restauration préparés ; bucket et secrets non configurés |
| Sources de promotions | Aucun flux libre et licencié universel établi ; Lidl/Franprix désactivés |
| Navigateur réel | Checklist conservée ; pas de test GPS réel certifié |
| Déploiement public | Non effectué |

## Changements v5

- `src/app.js` exporte `buildApp()` et permet au backend Node local et à Neon Functions d'utiliser les mêmes routes Fastify.
- `src/server.js` garde la responsabilité de l'écoute réseau locale et de l'initialisation du schéma.
- `functions/api.js` adapte Fetch Request/Response à `Fastify.inject`, sans ouvrir de socket.
- `DATABASE_POOL_MAX=2` dans Neon Functions ; URL `DATABASE_URL` injectée par la plateforme.
- Deux tests d'app factory / CORS ajoutés.
- Carte par défaut MapLibre + style OpenFreeMap ; aucun token cartographique à payer.
- CI exécutée sur `main` et les branches `work/**` ; audit résumé inclus ; test minimatch isolé séparé.
- Workflows de rétention quotidienne et sauvegarde chiffrée hebdomadaire préparés, sans secrets par défaut.
- Preview Vite limité à loopback.

## Limites non résolues sans accès aux comptes

La création de comptes, de projets et de secrets Neon/Cloudflare/GitHub exige une authentification personnelle. Aucun paiement n'est nécessaire pour les plans Free décrits, mais les quotas restent réels. La sauvegarde dans un deuxième projet Neon n'est pas un fournisseur indépendant ; elle protège d'abord contre la perte de la base principale.

Les données promotionnelles ne peuvent pas être collectées simplement parce qu'elles sont visibles publiquement. L'activation attend une licence ou une autorisation exploitable.
