# Modèle de données

## Versions de schéma

La table `schema_state` porte une version unique :

| Version | Contenu | Posée par |
|---|---|---|
| 0 | Schéma historique (`sources`, `scrape_jobs`, `products`, `price_observations`) | `migrations/20261120_000_baseline_schema.sql` |
| 1 | Identité produit, staging, provenances, alias, anomalies ; tables lieux/offres/journal préparées par 002 | `migrations/20261120_001_product_identity.sql` et `migrations/20261120_002_places_offers.sql` |
| 2 | Données historiques réconciliées et validées | `scripts/reconcile-product-identity.js --execute` |

L'API et le worker appellent `assertSchemaReady()` : hors version 2 ils refusent de
démarrer (code de sortie 78). `GET /health` renvoie `503` avec `schema.version` si la
version n'est pas 2. Aucun DDL n'est exécuté au démarrage. `assertPlacesSchemaReady()` contrôle aussi, sans écriture, les colonnes et contraintes de `places`, `offers` et `offer_sync_runs` issues de la migration 002.

## Commerces et promotions

- `places` représente un établissement physique identifié par `(source_id, external_id)` ; une enseigne ayant plusieurs magasins conserve plusieurs lignes.
- `offers` représente une promotion, un bon ou un cashback. `scope='store'` exige un `place_id` existant ; `scope='brand'` et `scope='online'` restent distincts.
- `offers.place_id` utilise `ON DELETE RESTRICT` : un établissement référencé par une offre magasin ne peut pas être supprimé implicitement.
- `offer_sync_runs` journalise chaque tentative de collecte. Une erreur de collecteur est enregistrée puis retournée à l'orchestrateur ; une exécution `--once` se termine avec un code non nul si une source échoue.
- Les sources de crawl sont désactivées par défaut à la création et leur activation exige une revue administrative explicite, datée et documentée (les notes internes ne sont pas exposées par l’API publique). Les collecteurs Lidl/Franprix exigent en plus deux variables explicites (`OFFERS_ENABLED_SOURCES` et `OFFERS_SOURCE_LICENSE_APPROVED`) ; toutes deux restent vides tant que les droits ne sont pas validés.

## Identité produit

Hiérarchie déterministe, dans cet ordre :

1. identifiant externe stable et documenté ;
2. GTIN valide (GTIN-8/12/13/14 accepté, normalisé sur 14 chiffres, chiffre de
   contrôle GS1 vérifié) → clé `g:<GTIN-14>` ;
3. référence marchand `m:<merchant>/<ref>` ou référence `r:<ref>` (portée source) ;
4. URL de fiche prouvée → `u:<url>` ;
5. empreinte de secours SHA-256 → `f:<hash>` (source, page de découverte, nom
   normalisé, variantes structurées ; jamais le prix).

Un SKU est un identifiant **secondaire** (namespace `sku`, portée source) par défaut. Il ne devient une clé primaire `r:<SKU>` que si la configuration de la source déclare explicitement `skuIsProductIdentifier: true` après vérification que cette enseigne garantit son unicité et sa stabilité. Un SKU n'est jamais copié dans `merchantRef`, n'est jamais enregistré comme GTIN et n'est jamais comparé entre deux enseignes.

Pour l'extraction CSS, une carte produit doit définir un sélecteur `productLink` dédié. Le sélecteur `productDetail` ne valide une fiche que lorsqu'il est réellement présent dans la page courante. Sans preuve, `product_url` reste `NULL` et `discovered_from` conserve la page d'origine.

### Alias vérifiés

`product_identifiers` conserve **tous** les identifiants vérifiés d'un produit :
`gtin`, `merchant_ref`, `ref`, `sku`, `url`. La contrainte
`UNIQUE (namespace, source_id, value)` interdit qu'un même alias désigne deux
produits d'une même source. Un GTIN doit être canonique (`^[0-9]{14}$`).

## Produit, découverte et observation

- `products.product_url` : URL individuelle de fiche, **nullable**. Elle n'est
  renseignée que sur preuve (`jsonld-product-url`, `webpage-mainentity`,
  `css-card-link`, `product-url-regex`, `product-detail`). `Offer.url` n'est jamais
  une preuve ; une page catalogue n'est jamais promue.
- `products.discovered_from` : page depuis laquelle le produit a été découvert.
- `products.identity_key` / `products.identity` : clé primaire et variantes
  fusionnées.
- `price_observations` : observations commerciales historiques, dédupliquées par
  `(product_id, fingerprint)`. Le fingerprint conserve ses 8 clés et leur ordre :
  `day`, `storeCode`, `price`, `regularPrice`, `currency`, `promotion`,
  `availability`, `priceScope`, encodées en base64url. La date reste UTC.
- `price_observation_sources` : provenance de chaque observation (page de
  découverte, méthode, preuve). Une observation peut avoir plusieurs provenances.

`price_observations.currency` est nullable : une devise inconnue reste `NULL`,
jamais remplacée par `EUR` sans configuration (`DEFAULT_CURRENCY`).

## Staging reprenable

| Table | Rôle |
|---|---|
| `product_candidates` | produit découvert, clé de découverte stable `(job_id, discovery_key)` |
| `product_candidate_observations` | observations commerciales du candidat, `UNIQUE (candidate_id, fingerprint)` ; `product_observation_id` relie chaque observation finalisée à sa ligne de production, `NULL` signifie à traiter |
| `product_candidate_observation_sources` | provenances d'une observation |
| `product_candidate_sources` | provenances générales du candidat |

`discovery_key` dépend de l'URL produit prouvée, sinon de la page de découverte,
du nom normalisé et des variantes. Elle ne dépend ni de la méthode d'extraction,
ni de l'ordre d'extraction, ni d'un identifiant découvert plus tard : un rejeu ne
crée pas de doublon et n'écrase aucune observation.

Cycle de vie : `staged` → (`classified`) → `finalized`, ou `blocked` sur anomalie.
Un candidat finalisé ne peut plus être supprimé que par la purge de rétention
(`mapnifique.maintenance = on`).

## Classification et finalisation

La classification construit des composantes connexes par identifiants partagés,
puis évalue les conflits sur toute la composante :

- plusieurs GTIN dans une composante → `gtin-conflict` ;
- même GTIN avec variantes incompatibles → `variant-conflict` ;
- plusieurs produits historiques pour un groupe → `multiple-historical-products` ;
- alias déjà rattaché à un autre produit → `alias-collision` ;
- empreinte commerciale réutilisée avec un contenu différent →
  `price-fingerprint-collision`.

Toute collision annule l'unité de travail (`ROLLBACK`), consigne l'anomalie dans
`product_identity_anomalies` et laisse les candidats `blocked` pour reprise après
correction. Aucune fusion automatique n'est effectuée sur une ambiguïté.

La finalisation s'exécute sur **une seule connexion réservée** :
`BEGIN` → `SELECT … FOR UPDATE` sur le job (fencing du lease) → verrou consultatif
par source → lecture → validation → écritures → `COMMIT`, avec `ROLLBACK` et
`release()` en cas d'erreur. Les écritures produit utilisent
`ON CONFLICT DO NOTHING` suivi d'une relecture et d'une vérification explicite :
aucun `ON CONFLICT DO UPDATE` aveugle.

`products_found` ne compte que des produits définitifs, après finalisation.

## Rétention

`identity_purge_stale_candidates(retention_days, anomaly_archive_days)` supprime
les candidats des jobs terminés plus anciens que la rétention, archive les
anomalies revues anciennes et ne purge **jamais** une anomalie non revue.
Les produits et les observations commerciales historiques ne sont pas purgés.

## API

`GET /api/products` expose `productUrl` (`url`), `discoveredFrom`, `identityKey`
et la liste des alias vérifiés. `GET /api/products/:id/prices` expose les
observations et leurs provenances.
