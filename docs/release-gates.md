# MapNifique — critères de sortie de release

Aucune mise en production ne doit être considérée comme prête avant que chaque porte soit vérifiée dans la même révision Git / le même checksum d’archive.

## Gate 1 — dépendances et qualité

Depuis la racine du workspace :

```bash
node --version                         # >= 22.13
npm ci --prefix backend/scraper
npm ci --prefix frontend
npm run lint
npm run check:backend
npm run test:backend
npm run test:frontend
npm run build
```

Attendu : aucune erreur lint, backend, frontend ni TypeScript ; `vite build` termine avec code 0. Capturer les tailles de bundle et examiner chaque chunk optionnel supérieur à 500 kB.

## Gate 2 — audit de dépendances

```bash
npm run audit:deps
npm run audit:deps:summary
```

Examiner les fichiers JSON et stderr du dossier de rapport. Pour cette version, l’avis `minimatch@9.0.9` reste ouvert et doit être accepté explicitement avec sa mitigation ou résolu par une version stable/override majeur entièrement testé. Les warnings de dépréciation ne sont pas des advisories de sécurité.

## Gate 3 — PostgreSQL jetable

```bash
npm --prefix backend/scraper run test:postgres:prompt26
```

Attendu : `STORAGE_ISOLATION=verified`, `MOUNTS=tmpfs-only`, tests migrations neuves/historiques, validations identité, verrous et upserts concurrents, sauvegardes/restaurations et `OVERALL=PASS`. Vérifier que le conteneur de test est supprimé. Ne jamais remplacer le nom de base/containeur avec une cible de production.

## Gate 4 — navigateur

Suivre `browser-functional-checklist.md` au minimum sur desktop Chrome/Edge, viewport mobile et vrai iPhone Safari. Un test local sans API ne compte pas comme test des commerces/offres. Pour les flux API, connecter uniquement une base de staging jetable, avec données réelles licenciées ou anonymisées.

## Gate 5 — staging et exploitation

Avant staging public : API HTTPS stable, base privée, secrets server-side, migrations préparées par rôle dédié, health/readiness, quotas, sauvegardes chiffrées hors hôte et restauration testée, alerting, politique logs/rétention, restart/rollback worker et revue de chaque source.

## Gate 6 — feu vert production

Confirmer par écrit l’hébergeur, le plafond de coût mensuel, l’objectif de disponibilité, la région, le propriétaire des secrets, le plan de sauvegarde/restauration et le retour arrière. Obtenir une approbation distincte pour la migration de la base réelle, le changement DNS/API, et le déploiement. CI ne déploie pas automatiquement.
