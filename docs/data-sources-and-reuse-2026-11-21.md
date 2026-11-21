# Sources de données gratuites et réutilisation

## Lieux de commerces

- OpenStreetMap fournit des données sous ODbL avec attribution et obligations de partage à respecter pour les bases dérivées.
- Overpass, Photon et Nominatim sont des services communautaires publics. Ils sont utiles pour les recherches ciblées mais n'offrent aucun SLA ni capacité garantie pour une application à fort trafic.
- Nominatim public : identifier clairement l'application, respecter une limite maximale d'une requête par seconde, mettre en cache et ne pas l'utiliser pour l'autocomplétion.
- Overpass : les instances publiques demandent un usage modéré ; le code MapNifique limite déjà les rayons et refuse les recherches sans borne. Conserver cache, quotas et limitation de concurrence.
- Ne pas télécharger massivement les tuiles `tile.openstreetmap.org`. Le défaut frontend passe à MapLibre + OpenFreeMap, sans clé API ; conserver l'attribution exposée par le style.

## Promotions commerciales

Aucun flux ouvert unique et clairement licencié n'a été identifié pour les promotions locales Lidl, Franprix et les autres enseignes françaises.

- Open Food Facts / Open Products Facts : données ouvertes de produits et fiches, pas des offres promotionnelles locales vérifiées en magasin.
- Lidl : les conditions de son site encadrent la copie ou le téléchargement de contenus et exigent une autorisation préalable pour certaines réutilisations. Ne pas scraper ni republier catalogue, images ou fiches sans permission explicite adaptée.
- Franprix : aucune licence ouverte de réutilisation des catalogues/promotions n'est établie dans ce chantier. Ne pas activer la source par défaut.
- Une page publique ou un endpoint accessible n'est pas une licence de réutilisation.

## Politique MapNifique

Les collecteurs d'offres ne peuvent être activés que si les trois éléments sont réunis :
1. autorisation/licence documentée pour la collecte et la réutilisation ;
2. règles `robots.txt`, CGU, attribution, fréquence et domaine documentées ;
3. activation explicite de la source et note de revue enregistrée dans la base.

La double validation `enabled + licenseApproved + licenseReviewNote` est conservée. En attendant, le catalogue d'offres reste vide plutôt que d'afficher des promotions collectées sans droit clair.

## Liens officiels à réexaminer avant activation

- OSM Foundation copyright/licence : https://www.openstreetmap.org/copyright
- Tile Usage Policy : https://operations.osmfoundation.org/policies/tiles/
- Nominatim Usage Policy : https://operations.osmfoundation.org/policies/nominatim/
- Overpass API : https://wiki.openstreetmap.org/wiki/Overpass_API#Public_Overpass_API_instances
- OpenFreeMap : https://openfreemap.org/
- Open Food Facts licence : https://world.openfoodfacts.org/terms-of-use
- Lidl France : consulter les CGU/mentions légales en vigueur avant toute collecte ; obtenir un accord si la réutilisation des contenus n'est pas expressément autorisée.
