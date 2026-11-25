import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSearchIntent,
    buildOverpassQuery,
    overpassToPlace,
    resolveDestinationFeature,
    photonToPlace,
    deduplicate,
    matchesDestinationCity,
    registerIntelligentSearchRoutes,
  osmDisplayCategory,
} from "./intelligent-search.js";

function feature(name, lat, lon, properties = {}) {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { name, ...properties },
  };
}

function appHarness() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) { routes.set(`GET ${path}`, handler); },
  };
}

function replyHarness() {
  return {
    statusCode: 200,
    payload: null,
    code(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return payload; },
  };
}

test("interim Paris is an activity, never the similar Inter-Actif brand", () => {
  const result = resolveSearchIntent(
    "interim Paris",
    ["Inter-Actif", "Adecco", "Pariès"],
    ["Paris"],
  );
  assert.equal(result.brand, null);
  assert.equal(result.category, "Emploi & intérim");
  assert.deepEqual(result.osmFilters, [
    ["office", "employment_agency"],
    ["company", "temporary_work_agency"],
    ["government", "employment_agency"],
  ]);
  assert.equal(result.destinationQuery, "Paris");
  assert.deepEqual(result.searchTokens, []);
});

test("an exact Inter-Actif query remains an exact brand search", () => {
  const result = resolveSearchIntent("Inter-Actif Paris", ["Inter-Actif"], ["Paris"]);
  assert.equal(result.brand, "Inter-Actif");
  assert.equal(result.category, null);
  assert.equal(result.destinationQuery, "Paris");
});

test("brand typo correction remains strict and preserves the city", () => {
  const brands = ["Zara", "Adidas", "Adidas Originals", "Sephora", "Inter-Actif", "Pariès"];
  const zara = resolveSearchIntent("Zarra Les Passages Boulogne", brands, []);
  const adidas = resolveSearchIntent("Adiddas Paris", brands, ["Paris"]);
  const sephora = resolveSearchIntent("Sephorra La Défense", brands, []);
  assert.equal(zara.brand, "Zara");
  assert.equal(zara.destinationQuery, "Les Passages Boulogne");
  assert.equal(adidas.brand, "Adidas");
  assert.equal(adidas.destinationQuery, "Paris");
  assert.equal(sephora.brand, "Sephora");
  assert.equal(sephora.destinationQuery, "La Défense");
});

test("unknown free text is not rewritten into a brand and retains a known city", () => {
  const result = resolveSearchIntent(
    "bird watcher Paris",
    ["Inter-Actif", "Midas", "Pariès"],
    ["Paris"],
  );
  assert.equal(result.brand, null);
  assert.equal(result.category, null);
  assert.equal(result.destinationQuery, "Paris");
  assert.deepEqual(result.searchTokens, ["bird", "watcher"]);
});

test("free text can coexist with a city without requiring a fixed category", () => {
  const result = resolveSearchIntent("bird watcher New York", [], ["New York"]);
  assert.equal(result.destinationQuery, "New York");
  assert.deepEqual(result.searchTokens, ["bird", "watcher"]);
});

test("common trades map to OSM tags without being brands", () => {
  const plumber = resolveSearchIntent("plombier Bordeaux", ["Plomberie Moderne"], ["Bordeaux"]);
  const lawyer = resolveSearchIntent("avocat Lyon", [], ["Lyon"]);
  assert.equal(plumber.brand, null);
  assert.equal(plumber.category, "Plombier");
  assert.deepEqual(plumber.osmFilters, [["craft", "plumber"]]);
  assert.equal(plumber.destinationQuery, "Bordeaux");
  assert.equal(lawyer.category, "Avocat");
  assert.deepEqual(lawyer.osmFilters, [["office", "lawyer"]]);
});


test("le toilettage animalier reconnaît les synonymes français et anglais", () => {
  const expectedTags = [
    ["shop", "pet_grooming"],
    ["shop", "dog_grooming"],
    ["shop", "dog_hairdresser"],
    ["amenity", "dog_grooming"],
    ["animal", "wellness"],
  ];

  for (const query of [
    "dog groomer Paris",
    "dog grooming Paris",
    "pet grooming Paris",
    "pet grooming salon Paris",
    "toilettage Paris",
    "toilettage animalier Paris",
    "toilettage canin Paris",
    "toiletteur Paris",
    "toiletteur canin Paris",
    "salon de toilettage Paris",
    "toiletteur animalier Paris",
    "toilettage pour chiens Paris",
  ]) {
    const result = resolveSearchIntent(query, [], ["Paris"]);
    assert.equal(result.category, "Toilettage animalier", query);
    assert.deepEqual(result.osmFilters, expectedTags, query);
    assert.equal(result.destinationQuery, "Paris", query);
    assert.deepEqual(result.searchTokens, [], query);
  }
});


test("les catégories Animalerie et Santé sont cohérentes dans OSM et PostgreSQL", async () => {
  assert.equal(osmDisplayCategory("shop", "pet"), "Animalerie");
  assert.equal(osmDisplayCategory("amenity", "veterinary"), "Santé");
  assert.equal(osmDisplayCategory("healthcare", "veterinary"), "Santé");
  assert.equal(osmDisplayCategory("shop", "pet_grooming"), "Toilettage animalier");

  const app = appHarness();
  let mainSql = "";

  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Paris") {
      return {
        ok: true,
        json: async () => ({
          features: [feature("Paris", 48.8566, 2.3522, { type: "city" })],
        }),
      };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: false,
    nominatimEnabled: false,
    nominatimBoundaryEnabled: false,
  });

  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "animalerie Paris", mode: "global", limit: "10" },
  }, replyHarness());

  assert.equal(result.intent.activity, "Animalerie");
  assert.ok(mainSql.includes("THEN 'Animalerie'"));
  assert.ok(mainSql.includes("THEN 'Santé'"));
  assert.ok(mainSql.includes("category_value='pet'"));
  assert.ok(mainSql.includes("category_value='veterinary'"));
});

test("le toilettage reste distinct de l'animalerie et du vétérinaire", () => {
  const petShop = resolveSearchIntent("animalerie Paris", [], ["Paris"]);
  const vet = resolveSearchIntent("vétérinaire Paris", [], ["Paris"]);

  assert.equal(petShop.category, "Animalerie");
  assert.deepEqual(petShop.osmFilters, [["shop", "pet"]]);

  assert.equal(vet.category, "Vétérinaire");
  assert.deepEqual(vet.osmFilters, [["amenity", "veterinary"]]);
});

test("les balises OSM de toilettage sont classées sans absorber l'animalerie ou le lavage", () => {
  for (const [key, value] of [
    ["shop", "pet_grooming"],
    ["shop", "dog_grooming"],
    ["shop", "dog_hairdresser"],
    ["amenity", "dog_grooming"],
    ["animal", "wellness"],
  ]) {
    assert.equal(osmDisplayCategory(key, value), "Toilettage animalier");
  }

  assert.notEqual(osmDisplayCategory("shop", "pet"), "Toilettage animalier");
  assert.notEqual(osmDisplayCategory("amenity", "veterinary"), "Toilettage animalier");
  assert.notEqual(osmDisplayCategory("amenity", "dog_wash"), "Toilettage animalier");
});

test("Overpass utilise les balises de toilettage pour la recherche et le filtre de catégorie", () => {
  const intent = resolveSearchIntent("dog groomer Paris", [], ["Paris"]);
  const activityQuery = buildOverpassQuery({
    center: { lat: 48.8566, lon: 2.3522 },
    radiusM: 18000,
    intent,
  });

  for (const tag of [
    '["shop"="pet_grooming"]',
    '["shop"="dog_grooming"]',
    '["shop"="dog_hairdresser"]',
    '["amenity"="dog_grooming"]',
    '["animal"="wellness"]',
  ]) {
    assert.ok(activityQuery.includes(tag), `tag Overpass absent : ${tag}`);
  }

  const categoryQuery = buildOverpassQuery({
    center: { lat: 48.8566, lon: 2.3522 },
    radiusM: 5000,
    intent: { brand: null, osmFilters: [], searchTokens: [] },
    categoryFilter: "Toilettage animalier",
  });

  assert.ok(categoryQuery.includes('["shop"="pet_grooming"]'));
  assert.ok(categoryQuery.includes('["amenity"="dog_grooming"]'));
});

test("dog groomer Paris produit un filtre SQL de toilettage avec la ville", async () => {
  const app = appHarness();
  let mainSql = "";
  let mainValues = [];

  const pool = {
    query: async (sql, values = []) => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      mainValues = values;
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Paris") {
      return {
        ok: true,
        json: async () => ({
          features: [feature("Paris", 48.8566, 2.3522, { type: "city" })],
        }),
      };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: false,
    nominatimEnabled: false,
    nominatimBoundaryEnabled: false,
  });

  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "dog groomer Paris", mode: "global", limit: "10" },
  }, replyHarness());

  assert.equal(result.intent.activity, "Toilettage animalier");
  assert.equal(result.intent.brand, null);
  assert.equal(result.destination, "Paris");
  assert.ok(mainSql.includes("Toilettage animalier"));
  assert.ok(mainValues.includes("pet_grooming"));
  assert.ok(mainValues.includes("dog_grooming"));
  assert.ok(mainValues.includes("dog_hairdresser"));
});
test("brand and activity filters can coexist", () => {
  const result = resolveSearchIntent("Nike magasin de sport Paris", ["Nike"], ["Paris"]);
  assert.equal(result.brand, "Nike");
  assert.equal(result.category, "Sport");
  assert.equal(result.destinationQuery, "Paris");
});

test("Overpass query searches employment agencies around the resolved city", () => {
  const intent = resolveSearchIntent("interim Paris", [], ["Paris"]);
  const query = buildOverpassQuery({
    center: { lat: 48.8566, lon: 2.3522 },
    radiusM: 18000,
    intent,
  });
  assert.match(query, /office.*employment_agency/);
  assert.match(query, /company.*temporary_work_agency/);
  assert.match(query, /around:18000,48\.8566,2\.3522/);
});

test("brand Overpass lookup uses fast exact indexed tag selectors", () => {
  const intent = resolveSearchIntent("Zarra Les Passages Boulogne", ["Zara"], []);
  const query = buildOverpassQuery({
    center: { lat: 48.8372, lon: 2.2399 },
    radiusM: 3000,
    intent,
  });
  assert.match(query, /\["name"="Zara"\]/);
  assert.match(query, /\["brand"="Zara"\]/);
  assert.match(query, /\["operator"="Zara"\]/);
  assert.doesNotMatch(query, /\[~/);
  assert.match(query, /around:3000,48\.8372,2\.2399/);
});

test("Overpass query refuses a global unbounded scan", () => {
  const intent = resolveSearchIntent("plombier", []);
  assert.equal(buildOverpassQuery({ center: null, radiusM: 3000, intent }), null);
});

test("Overpass elements normalize into place cards with OSM provenance", () => {
  const place = overpassToPlace({
    type: "node",
    id: 123,
    lat: 48.85,
    lon: 2.35,
    tags: {
      name: "Agence Exemple",
      office: "employment_agency",
      "addr:city": "Paris",
      "addr:street": "Rue Exemple",
      phone: "+33123456789",
    },
  });
  assert.equal(place.name, "Agence Exemple");
  assert.equal(place.category, "Emploi & intérim");
  assert.equal(place.city, "Paris");
  assert.equal(place.externalId, "node/123");
});

test("fusionne prudemment deux nœuds OSM du même magasin à 20 mètres", () => {
  const common = {
    name: "Zara",
    brand: "Zara",
    category: "Mode",
    category_key: "shop",
    category_value: "clothes",
    street: "Les Passages",
    postcode: "92100",
    city: "Boulogne-Billancourt",
    address: {
      street: "Les Passages",
      road: "Les Passages",
      postcode: "92100",
      city: "Boulogne-Billancourt",
      country: "France",
    },
  };
  const rows = deduplicate([
    {
      ...common,
      id: "osm-N-3785103382",
      lat: 48.8370757,
      lon: 2.2398373,
      tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1" },
    },
    {
      ...common,
      id: "osm-N-3785103383",
      lat: 48.8370015,
      lon: 2.2400844,
      tags: { name: "Zara", shop: "clothes", brand: "Zara" },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "osm-N-3785103382");
  assert.equal(rows[0].tags.level, "1");
});

test("fusionne les doublons OSM réels avec Wikidata et étage lorsque l'adresse est absente", () => {
  // Reproduction des colonnes réellement observées dans osm_places :
  // street/postcode/city vides, mais brand:wikidata et level présents.
  const rows = deduplicate([
    {
      id: "osm-N-3785103382",
      sourceId: "openstreetmap",
      externalId: "N/3785103382",
      name: "Zara", brand: "Zara", category: "Mode",
      category_key: "shop", category_value: "clothes",
      lat: 48.8370757, lon: 2.2398373,
      street: "", postcode: "", city: "",
      address: {},
      tags: {
        name: "Zara", shop: "clothes", brand: "Zara", level: "1",
        "brand:wikidata": "Q147662", "brand:wikipedia": "en:Zara (retailer)",
      },
    },
    {
      id: "osm-N-3785103383",
      sourceId: "openstreetmap",
      externalId: "N/3785103383",
      name: "Zara", brand: "Zara", category: "Mode",
      category_key: "shop", category_value: "clothes",
      lat: 48.8370015, lon: 2.2400844,
      street: "", postcode: "", city: "",
      address: {},
      tags: {
        name: "Zara", shop: "clothes", brand: "Zara", level: "1",
        "brand:wikidata": "Q147662", "brand:wikipedia": "en:Zara (retailer)",
      },
    },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "osm-N-3785103382");
  assert.equal(rows[0].tags.level, "1");
  assert.equal(rows[0].tags["brand:wikidata"], "Q147662");
});

test("coalesce chaque identifiant OSM avant de fusionner deux nœuds du même magasin", () => {
  const base = (id, lat, lon) => ({
    id: `osm-N-${id}`,
    sourceId: "openstreetmap",
    externalId: `N/${id}`,
    name: "Zara",
    brand: "Zara",
    category: "Mode",
    category_key: "shop",
    category_value: "clothes",
    lat,
    lon,
    street: "",
    postcode: "",
    city: "",
    address: {},
    tags: {
      name: "Zara",
      shop: "clothes",
      brand: "Zara",
      level: "1",
      "brand:wikidata": "Q147662",
    },
  });

  const localA = base("3785103382", 48.8370757, 2.2398373);
  const localB = base("3785103383", 48.8370015, 2.2400844);
  const photon = (row) => ({
    id: row.id,
    sourceId: "openstreetmap",
    externalId: row.externalId,
    sourceUrl: `https://www.openstreetmap.org/node/${row.externalId.split("/")[1]}`,
    name: row.name,
    brand: row.brand,
    brandKey: "zara",
    category: "Mode",
    category_key: "shop",
    category_value: "clothes",
    lat: row.lat,
    lon: row.lon,
    street: "Les Passages",
    postcode: "92100",
    city: "Boulogne-Billancourt",
    address: {
      road: "Les Passages",
      street: "Les Passages",
      postcode: "92100",
      city: "Boulogne-Billancourt",
      country: "France",
    },
    tags: {},
  });
  const overpass = (row) => ({
    ...row,
    id: row.id.replace("osm-N-", "osm-node-"),
    externalId: row.externalId.replace("N/", "node/"),
    sourceUrl: `https://www.openstreetmap.org/node/${row.externalId.split("/")[1]}`,
    address: {},
    street: "",
    postcode: "",
    city: "",
  });

  // Ordre exact observé dans le handler : local A/B, Photon B/A, Overpass A/B.
  const rows = deduplicate([
    localA,
    localB,
    photon(localB),
    photon(localA),
    overpass(localA),
    overpass(localB),
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "osm-N-3785103382");
  assert.equal(rows[0].address.street, "Les Passages");
  assert.equal(rows[0].address.postcode, "92100");
  assert.equal(rows[0].tags["brand:wikidata"], "Q147662");
  assert.equal(rows[0].tags.level, "1");
});

test("la route intelligente fusionne les vrais objets OSM enrichis par Photon et Overpass", async () => {
  const app = appHarness();
  const localRows = [
    {
      id: "osm-N-3785103382", sourceId: "openstreetmap", externalId: "N/3785103382",
      name: "Zara", brand: "Zara", category: "Mode", category_key: "shop", category_value: "clothes",
      lat: 48.8370757, lon: 2.2398373, street: "", postcode: "", city: "", address: {},
      tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1", "brand:wikidata": "Q147662" },
    },
    {
      id: "osm-N-3785103383", sourceId: "openstreetmap", externalId: "N/3785103383",
      name: "Zara", brand: "Zara", category: "Mode", category_key: "shop", category_value: "clothes",
      lat: 48.8370015, lon: 2.2400844, street: "", postcode: "", city: "", address: {},
      tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1", "brand:wikidata": "Q147662" },
    },
  ];

  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Zara" }] };
      if (sql.includes("location catalog")) return { rows: [] };
      return { rows: [{ places: localRows, total: "2" }] };
    },
  };

  const fetcher = async (url, init = {}) => {
    if (String(url).includes("overpass.example")) {
      return {
        ok: true,
        json: async () => ({ elements: [
          { type: "node", id: 3785103382, lat: 48.8370757, lon: 2.2398373,
            tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1", "brand:wikidata": "Q147662" } },
          { type: "node", id: 3785103383, lat: 48.8370015, lon: 2.2400844,
            tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1", "brand:wikidata": "Q147662" } },
        ] }),
      };
    }

    const parsed = new URL(url);
    const q = parsed.searchParams.get("q");
    if (q === "Les Passages Boulogne") {
      return {
        ok: true,
        json: async () => ({ features: [feature("Les Passages", 48.8372, 2.2399, {
          type: "district", city: "Boulogne-Billancourt",
        })] }),
      };
    }
    if (q === "Zara") {
      return {
        ok: true,
        json: async () => ({ features: [
          feature("Zara", 48.8370015, 2.2400844, {
            osm_type: "N", osm_id: 3785103383, osm_key: "shop", osm_value: "clothes",
            street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt",
            extra: { brand: "Zara" },
          }),
          feature("Zara", 48.8370757, 2.2398373, {
            osm_type: "N", osm_id: 3785103382, osm_key: "shop", osm_value: "clothes",
            street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt",
            extra: { brand: "Zara" },
          }),
        ] }),
      };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: true,
    overpassMinIntervalMs: 0,
    overpassUrl: "https://overpass.example/interpreter",
  });

  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Zarra Les Passages Boulogne", mode: "smart", limit: "20" },
  }, replyHarness());

  assert.equal(result.sources.postgresql, 2);
  assert.equal(result.sources.photon, 2);
  assert.equal(result.sources.overpass, 2);
  assert.equal(result.places.length, 1);
  assert.equal(result.total, 1);
  assert.equal(result.places[0].id, "osm-N-3785103382");
  assert.equal(result.places[0].address.street, "Les Passages");
  assert.equal(result.places[0].tags["brand:wikidata"], "Q147662");
});

test("fusionne l'assemblage réel lorsque Photon enrichit l'adresse avant Overpass", () => {
  const base = (id, lat, lon) => ({
    id: `osm-N-${id}`,
    sourceId: "openstreetmap",
    externalId: `N/${id}`,
    name: "Zara",
    brand: "Zara",
    category: "Mode",
    category_key: "shop",
    category_value: "clothes",
    lat,
    lon,
    street: "",
    postcode: "",
    city: "",
    address: {},
    tags: {
      name: "Zara",
      shop: "clothes",
      brand: "Zara",
      level: "1",
      "brand:wikidata": "Q147662",
    },
  });

  const localA = base("3785103382", 48.8370757, 2.2398373);
  const localB = base("3785103383", 48.8370015, 2.2400844);
  const enrichWithPhotonAddress = row => ({
    ...row,
    street: "Les Passages",
    postcode: "92100",
    city: "Boulogne-Billancourt",
    address: {
      road: "Les Passages",
      street: "Les Passages",
      postcode: "92100",
      city: "Boulogne-Billancourt",
      country: "France",
    },
  });
  const photonA = enrichWithPhotonAddress(localA);
  const photonB = enrichWithPhotonAddress(localB);
  // Overpass renvoie les deux nœuds sans adresse, comme dans les tags observés.
  const overpassA = { ...localA, address: {}, street: "", postcode: "", city: "" };
  const overpassB = { ...localB, address: {}, street: "", postcode: "", city: "" };

  // Ordre réel du handler : toutes les lignes PostgreSQL, puis Photon, puis Overpass.
  const rows = deduplicate([localA, localB, photonA, photonB, overpassA, overpassB]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "osm-N-3785103382");
  assert.equal(rows[0].address.road, "Les Passages");
  assert.equal(rows[0].address.postcode, "92100");
});

test("ne fusionne pas sans adresse si l'identité Wikidata ou l'étage manque", () => {
  const base = {
    name: "Zara", brand: "Zara", category: "Mode",
    category_key: "shop", category_value: "clothes",
    lat: 48.8370757, lon: 2.2398373,
    street: "", postcode: "", city: "", address: {},
    tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1", "brand:wikidata": "Q147662" },
  };
  const missingLevel = deduplicate([
    { ...base, id: "zara-known-floor" },
    { ...base, id: "zara-no-floor", lon: 2.2400844, tags: { ...base.tags, level: undefined } },
  ]);
  const missingWikidata = deduplicate([
    { ...base, id: "zara-known-wikidata" },
    { ...base, id: "zara-no-wikidata", lon: 2.2400844, tags: { ...base.tags, "brand:wikidata": undefined } },
  ]);
  assert.equal(missingLevel.length, 2);
  assert.equal(missingWikidata.length, 2);

  const partialAddress = deduplicate([
    { ...base, id: "zara-partial-address" },
    {
      ...base,
      id: "zara-no-address",
      lon: 2.2400844,
      postcode: "92100",
      tags: { ...base.tags },
    },
  ]);
  assert.equal(partialAddress.length, 2);
});

test("ne fusionne pas deux boutiques de la même enseigne à des étages différents", () => {
  const base = {
    name: "Zara", brand: "Zara", category: "Mode",
    category_key: "shop", category_value: "clothes",
    street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt",
    address: { street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt" },
    lat: 48.8370757, lon: 2.2398373,
  };
  const rows = deduplicate([
    { ...base, id: "zara-floor-1", tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "1" } },
    { ...base, id: "zara-floor-2", lon: 2.2400844, tags: { name: "Zara", shop: "clothes", brand: "Zara", level: "2" } },
  ]);
  assert.equal(rows.length, 2);
});

test("ne fusionne pas deux boutiques de même nom sur des adresses différentes", () => {
  const base = {
    name: "Zara", brand: "Zara", category: "Mode",
    category_key: "shop", category_value: "clothes",
    street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt",
    address: { street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt" },
    lat: 48.8370757, lon: 2.2398373,
    tags: { name: "Zara", shop: "clothes", brand: "Zara" },
  };
  const rows = deduplicate([
    { ...base, id: "zara-92100" },
    { ...base, id: "zara-92200", postcode: "92200", address: { ...base.address, postcode: "92200" }, lon: 2.2400844 },
  ]);
  assert.equal(rows.length, 2);
});

test("le total affiché tient compte de la déduplication quand tous les résultats locaux sont chargés", async () => {
  const app = appHarness();
  const row = {
    id: "osm-N-zara-1", name: "Zara", brand: "Zara", category: "Mode",
    category_key: "shop", category_value: "clothes",
    lat: 48.8370757, lon: 2.2398373,
    street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt",
    address: { street: "Les Passages", postcode: "92100", city: "Boulogne-Billancourt" },
    tags: { name: "Zara", brand: "Zara", shop: "clothes" },
  };
  const row2 = {
    ...row,
    id: "osm-N-zara-2",
    lon: 2.2400844,
    tags: { ...row.tags, level: "1" },
  };
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Zara" }] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Boulogne-Billancourt" }] };
      return { rows: [{ places: [row, row2], total: "2" }] };
    },
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Les Passages Boulogne") {
      return { ok: true, json: async () => ({ features: [feature("Les Passages", 48.8372, 2.2399, { type: "district", city: "Boulogne-Billancourt" })] }) };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };
  registerIntelligentSearchRoutes(app, pool, { fetcher, minIntervalMs: 0, overpassEnabled: false });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Zarra Les Passages Boulogne", mode: "smart", limit: "10" },
  }, replyHarness());
  assert.equal(result.places.length, 1);
  assert.equal(result.total, 1);
});

test("Photon maps OSM office employment agency to Emploi & intérim", () => {
  const place = photonToPlace(feature("Adecco", 48.85, 2.35, {
    osm_type: "N", osm_id: 42, osm_key: "office", osm_value: "employment_agency",
  }));
  assert.equal(place.category, "Emploi & intérim");
});

test("destination matching keeps neighbourhood and city radii separate", () => {
  const district = resolveDestinationFeature("La Défense", [feature("La Défense", 48.892, 2.239, { type: "locality" })]);
  const city = resolveDestinationFeature("Lyon", [feature("Lyon", 45.764, 4.8357, { type: "city" })]);
  assert.equal(district.radiusM, 3000);
  assert.equal(city.radiusM, 18000);
});

test("smart mode is global for ordinary typed searches even when GPS coordinates are present", async () => {
  const app = appHarness();
  let mainSql = "";
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Nike" }] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher: async url => {
      const parsed = new URL(url);
      if (parsed.searchParams.get("q") === "Paris") {
        return { ok: true, json: async () => ({ features: [feature("Paris", 48.8566, 2.3522, { type: "city" })] }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    },
    minIntervalMs: 0,
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Nike", mode: "smart", lat: "48.85", lon: "2.35", radiusM: "3000" },
  }, replyHarness());
  assert.equal(result.mode, "global");
  assert.doesNotMatch(mainSql, /ST_DWithin/);
});

test("explicit nearby mode still enforces the GPS radius", async () => {
  const app = appHarness();
  let mainSql = "";
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog") || sql.includes("location catalog")) return { rows: [] };
      mainSql = sql;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  registerIntelligentSearchRoutes(app, pool, { fetcher: async () => ({ ok: true, json: async () => ({ features: [] }) }), minIntervalMs: 0 });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "plombier", mode: "nearby", lat: "48.85", lon: "2.35", radiusM: "2500" },
  }, replyHarness());
  assert.equal(result.mode, "nearby");
  assert.match(mainSql, /ST_DWithin/);
});

test("Overpass results supplement the database for a tagged activity", async () => {
  const app = appHarness();
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async (url, init = {}) => {
    if (String(url).includes("overpass")) {
      const data = new URLSearchParams(init.body).get("data");
      assert.match(data, /employment_agency/);
      return { ok: true, json: async () => ({ elements: [{
        type: "node", id: 999, lat: 48.86, lon: 2.36,
        tags: { name: "Agence Test", office: "employment_agency", "addr:city": "Paris" },
      }] }) };
    }
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Paris") {
      return { ok: true, json: async () => ({ features: [feature("Paris", 48.8566, 2.3522, { type: "city" })] }) };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: true,
    overpassMinIntervalMs: 0,
    overpassUrl: "https://overpass.example/interpreter",
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "interim Paris", mode: "global", limit: "10" },
  }, replyHarness());
  assert.equal(result.intent.activity, "Emploi & intérim");
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].name, "Agence Test");
  assert.equal(result.sources.overpass, 1);
});


test("suggestions while typing do not enqueue public Overpass requests", async () => {
  const app = appHarness();
  let overpassCalled = false;
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async (url) => {
    if (String(url).includes("overpass")) {
      overpassCalled = true;
      return { ok: true, json: async () => ({ elements: [] }) };
    }
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Paris") {
      return { ok: true, json: async () => ({ features: [feature("Paris", 48.8566, 2.3522, { type: "city" })] }) };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: true,
    overpassMinIntervalMs: 0,
    overpassUrl: "https://overpass.example/interpreter",
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "plombier Paris", mode: "global", suggest: "1", limit: "6" },
  }, replyHarness());
  assert.equal(result.mode, "global");
  assert.equal(overpassCalled, false);
  assert.equal(result.sources.overpass, 0);
});

test("un résultat Photon de type bâtiment seul n'est pas un commerce de la marque recherchée", async () => {
  const app = appHarness();
  let mainSql = "";
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Sephora" }] };
      if (sql.includes("location catalog")) return { rows: [] };
      mainSql = sql;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "La Défense") {
      return { ok: true, json: async () => ({ features: [
        feature("La Défense", 48.892, 2.239, { type: "locality" }),
      ] }) };
    }
    if (parsed.searchParams.get("q") === "Sephora") {
      return { ok: true, json: async () => ({ features: [
        feature("Sephora", 48.891296, 2.2379161, {
          osm_type: "N", osm_id: 13282564341, osm_key: "shop", osm_value: "cosmetics",
          city: "Puteaux", extra: { brand: "Sephora", shop: "cosmetics" },
        }),
        feature("Sephora", 48.8876666, 2.2597991, {
          osm_type: "W", osm_id: 81128871, osm_key: "building", osm_value: "office",
          city: "Neuilly-sur-Seine", extra: {},
        }),
      ] }) };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };
  registerIntelligentSearchRoutes(app, pool, { fetcher, minIntervalMs: 0, overpassEnabled: false });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Sephorra La Défense", mode: "smart", limit: "10" },
  }, replyHarness());

  assert.match(mainSql, /p\.tags->>'building'/);
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].name, "Sephora");
  assert.equal(result.places[0].category, "Beauté");
  assert.equal(result.places[0].city, "Puteaux");
});

test("une recherche de marque dans une ville exclut les communes voisines même dans le rayon du centre", async () => {
  const app = appHarness();
  let mainSql = "";
  let mainValues = [];
  const parisRow = {
    id: "osm-N-adidas-paris", sourceId: "openstreetmap", externalId: "N/adidas-paris",
    name: "Adidas", brand: "Adidas", category: "Sport", category_key: "shop", category_value: "sports",
    lat: 48.8565469, lon: 2.3604192, city: "Paris", street: "Rue des Rosiers", postcode: "75004",
    address: { city: "Paris", street: "Rue des Rosiers", postcode: "75004" }, tags: { name: "Adidas", brand: "Adidas", shop: "sports" },
  };
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Adidas" }] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      mainValues = values;
      // PostgreSQL mock reproduit le filtre de ville demandé par le SQL.
      return { rows: [{ places: [parisRow], total: "1" }] };
    },
  };
  const fetcher = async (url, init = {}) => {
    if (String(url).includes("overpass")) {
      const data = new URLSearchParams(init.body).get("data");
      assert.match(data, /around:18000/);
      return { ok: true, json: async () => ({ elements: [
        { type: "node", id: 101, lat: 48.8565469, lon: 2.3604192, tags: { name: "Adidas", brand: "Adidas", shop: "sports", "addr:city": "Paris" } },
        { type: "node", id: 102, lat: 48.8932749, lon: 2.4293692, tags: { name: "Adidas", brand: "Adidas", shop: "sports", "addr:city": "Romainville" } },
      ] }) };
    }
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Paris") {
      return { ok: true, json: async () => ({ features: [feature("Paris", 48.8566, 2.3522, { type: "city" })] }) };
    }
    if (parsed.searchParams.get("q") === "Adidas") {
      return { ok: true, json: async () => ({ features: [
        feature("Adidas", 48.8565469, 2.3604192, { osm_type: "N", osm_id: 101, osm_key: "shop", osm_value: "sports", city: "Paris", extra: { brand: "Adidas", shop: "sports" } }),
        feature("Adidas", 48.8932749, 2.4293692, { osm_type: "N", osm_id: 102, osm_key: "shop", osm_value: "sports", city: "Romainville", extra: { brand: "Adidas", shop: "sports" } }),
      ] }) };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher, minIntervalMs: 0, overpassEnabled: true,
    overpassMinIntervalMs: 0, overpassUrl: "https://overpass.example/interpreter",
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Adiddas Paris", mode: "smart", limit: "20" },
  }, replyHarness());

  assert.match(mainSql, /p\.city ILIKE/);
  assert.ok(mainValues.includes("%paris%"));
  assert.equal(result.destinationScope, "city");
  assert.equal(result.destinationCity, "paris");
  assert.equal(result.places.length, 1);
  assert.ok(result.places.every(place => place.city === "Paris"));
  assert.equal(result.places[0].name, "Adidas");
});

test("la destination est géocodée par Nominatim si Photon expire, sans utiliser Nominatim pour les commerces", async () => {
  const app = appHarness();
  const observed = { photonCalls: 0, nominatimCalls: 0, sql: "", values: [] };
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [] };
      observed.sql = sql;
      observed.values = values;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "photon.komoot.io") {
      observed.photonCalls += 1;
      throw new Error("Photon timeout simulé");
    }
    if (parsed.hostname === "nominatim.example") {
      observed.nominatimCalls += 1;
      assert.equal(parsed.pathname, "/search");
      assert.equal(parsed.searchParams.get("format"), "jsonv2");
      assert.equal(parsed.searchParams.get("q"), "Paris");
      assert.equal(parsed.searchParams.get("addressdetails"), "1");
      assert.equal(parsed.searchParams.get("limit"), "5");
      assert.equal(parsed.searchParams.has("namedetails"), false);
      assert.ok(init.signal instanceof AbortSignal);
      assert.match(init.headers["user-agent"], /MapNifique/);
      return {
        ok: true,
        json: async () => [{
          lat: "48.8566", lon: "2.3522", name: "Paris",
          type: "administrative", addresstype: "city",
          address: { city: "Paris", postcode: "75001", country: "France" },
        }],
      };
    }
    throw new Error(`Hôte inattendu : ${parsed.hostname}`);
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
    nominatimMinIntervalMs: 1000,
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "interim Paris", mode: "smart", limit: "20" },
  }, replyHarness());

  assert.equal(observed.photonCalls, 1, "ne pas refaire une seconde requête à Photon après son timeout");
  assert.equal(observed.nominatimCalls, 1);
  assert.equal(result.destinationResolved, true);
  assert.equal(result.destinationGeocoder, "nominatim");
  assert.equal(result.destinationScope, "city");
  assert.equal(result.destinationCity, "paris");
  assert.match(observed.sql, /p\.city ILIKE/);
  assert.ok(observed.values.includes("%paris%"));
  assert.equal(result.sources.photon, 0);
  assert.match(result.externalError, /Photon est momentanément indisponible/);
  assert.doesNotMatch(result.externalError, /résolution de cette destination/);
});

test("Nominatim résout Paris vers la commune française parmi plusieurs homonymes", async () => {
  const app = appHarness();
  let mainSql = "";
  let mainValues = [];
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Adidas" }] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      mainValues = values;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.hostname === "photon.komoot.io") throw new Error("Photon indisponible");
    assert.equal(parsed.hostname, "nominatim.example");
    assert.equal(parsed.searchParams.get("q"), "Paris");
    assert.equal(parsed.searchParams.get("limit"), "5");
    assert.equal(parsed.searchParams.get("polygon_geojson"), "1");
    assert.equal(parsed.searchParams.get("polygon_threshold"), "0.00001");
    assert.equal(parsed.searchParams.has("namedetails"), false);
    assert.ok(init.signal instanceof AbortSignal);
    return {
      ok: true,
      json: async () => [
        {
          lat: "48.8588897", lon: "2.3200410", name: "Paris",
          type: "administrative", addresstype: "suburb",
          address: { suburb: "Paris", city_district: "Paris", city: "Paris", country: "France", country_code: "fr" },
        },
        {
          lat: "48.8534951", lon: "2.3483915", name: "Paris",
          type: "administrative", addresstype: "city",
          address: { city: "Paris", country: "France", country_code: "fr" },
          osm_type: "relation", osm_id: 71525,
          geojson: {
            type: "Polygon",
            coordinates: [[[2.25,48.82],[2.42,48.82],[2.42,48.90],[2.25,48.90],[2.25,48.82]]],
          },
        },
        {
          lat: "33.6617962", lon: "-95.5555130", name: "Paris",
          type: "administrative", addresstype: "town",
          address: { town: "Paris", county: "Lamar County", state: "Texas", country_code: "us" },
        },
      ],
    };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher, minIntervalMs: 0, overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
    nominatimMinIntervalMs: 1000,
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Adiddas Paris", mode: "smart", limit: "20" },
  }, replyHarness());

  assert.equal(result.destinationResolved, true);
  assert.equal(result.destinationGeocoder, "nominatim");
  assert.equal(result.destinationScope, "city");
  assert.equal(result.destinationCity, "paris");
  assert.ok(mainValues.includes(48.8534951), "le point SQL doit être le centre de Paris en France");
  assert.ok(mainValues.includes(2.3483915), "la longitude SQL doit être celle de Paris en France");
  assert.match(mainSql, /p\.city ILIKE/);
  assert.match(mainSql, /ST_Covers\(/, "le SQL doit utiliser la frontière administrative");
  assert.ok(mainValues.includes("%paris%"));
  assert.ok(mainValues.some(value => typeof value === "string" && value.includes('"type":"Polygon"')),
    "le GeoJSON de Paris doit être transmis en paramètre SQL");
  assert.equal(result.destinationBoundarySource, "nominatim");
  assert.equal(result.destinationBoundaryOsmType, "relation");
  assert.equal(result.destinationBoundaryOsmId, "71525");
});

test("la frontière administrative de Paris conserve les quatre Adidas parisiens et exclut les quatre communes voisines", () => {
  const boundary = {
    type: "Polygon",
    coordinates: [[[2.25,48.82],[2.42,48.82],[2.42,48.90],[2.25,48.90],[2.25,48.82]]],
  };
  const destination = {
    scope: "city", cityName: "paris", label: "Paris",
    point: { lat: 48.8534951, lon: 2.3483915 },
    cityFallbackRadiusM: 10000,
    boundaryGeoJSON: boundary,
  };
  const stores = [
    { id: "N-3738161818", lat: 48.8565469, lon: 2.3604192, city: "Paris" },
    { id: "N-9898243341", lat: 48.8732313, lon: 2.3296794, city: "" },
    { id: "W-372826823", lat: 48.87152805, lon: 2.30364028, city: "" },
    { id: "W-1333093078", lat: 48.8283461, lon: 2.35576165, city: "" },
    { id: "W-406408463", lat: 48.89052605, lon: 2.23883556, city: "" },
    { id: "W-1235249501", lat: 48.92254185, lon: 2.33016197, city: "" },
    { id: "N-7237353100", lat: 48.8932749, lon: 2.4293692, city: "" },
    { id: "N-13282564343", lat: 48.8908563, lon: 2.2392846, city: "" },
  ];
  const inside = stores.filter(place => matchesDestinationCity(place, destination));
  const outside = stores.filter(place => !matchesDestinationCity(place, destination));
  assert.deepEqual(inside.map(place => place.id), [
    "N-3738161818", "N-9898243341", "W-372826823", "W-1333093078",
  ]);
  assert.deepEqual(outside.map(place => place.id), [
    "W-406408463", "W-1235249501", "N-7237353100", "N-13282564343",
  ]);
});

test("une frontière GeoJSON prime sur un addr:city erroné ou un rayon trop large", () => {
  const destination = {
    scope: "city", cityName: "paris", point: { lat: 48.8535, lon: 2.3484 },
    cityFallbackRadiusM: 10000,
    boundaryGeoJSON: {
      type: "Polygon",
      coordinates: [[[2.25,48.82],[2.42,48.82],[2.42,48.90],[2.25,48.90],[2.25,48.82]]],
    },
  };
  assert.equal(matchesDestinationCity({ lat: 48.8565, lon: 2.3604, city: "" }, destination), true);
  assert.equal(matchesDestinationCity({ lat: 48.8905, lon: 2.2388, city: "Paris" }, destination), false);
});

test("Nominatim ajoute une frontière quand Photon a déjà géocodé une ville", async () => {
  const app = appHarness();
  let mainSql = "";
  let mainValues = [];
  let nominatimCalls = 0;
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Adidas" }] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      mainValues = values;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const polygon = {
    type: "Polygon",
    coordinates: [[[2.25,48.82],[2.42,48.82],[2.42,48.90],[2.25,48.90],[2.25,48.82]]],
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === "photon.komoot.io") {
      if (parsed.searchParams.get("q") === "Paris") {
        return { ok: true, json: async () => ({ features: [feature("Paris",48.8534951,2.3483915,{type:"city"})] }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    }
    if (parsed.hostname === "nominatim.example") {
      nominatimCalls++;
      assert.equal(parsed.searchParams.get("polygon_geojson"), "1");
      return {
        ok: true,
        json: async () => [{
          lat: "48.8534951", lon: "2.3483915", name: "Paris",
          type: "administrative", addresstype: "city", osm_type: "relation", osm_id: 71525,
          geojson: polygon,
          address: { city: "Paris", country_code: "fr" },
        }],
      };
    }
    throw new Error(`Hôte inattendu : ${parsed.hostname}`);
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher, minIntervalMs: 0, overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
    nominatimMinIntervalMs: 1000,
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Adidas Paris", mode: "smart", limit: "20" },
  }, replyHarness());
  assert.equal(nominatimCalls, 1);
  assert.equal(result.destinationGeocoder, "photon");
  assert.equal(result.destinationBoundarySource, "nominatim");
  assert.match(mainSql, /ST_Covers\(/);
  assert.ok(mainValues.some(value => typeof value === "string" && value.includes('"type":"Polygon"')));
});

test("une frontière Nominatim homonyme éloignée n'est pas appliquée au point Photon", async () => {
  const app = appHarness();
  let mainSql = "";
  let mainValues = [];
  const pool = {
    query: async (sql, values) => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Adidas" }] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      mainValues = values;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const polygon = {
    type: "Polygon",
    coordinates: [[[-95.6,33.6],[-95.5,33.6],[-95.5,33.7],[-95.6,33.7],[-95.6,33.6]]],
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === "photon.komoot.io") {
      if (parsed.searchParams.get("q") === "Paris") {
        return { ok: true, json: async () => ({ features: [feature("Paris",48.8534951,2.3483915,{type:"city"})] }) };
      }
      return { ok: true, json: async () => ({ features: [] }) };
    }
    return {
      ok: true,
      json: async () => [{
        lat: "33.6617962", lon: "-95.5555130", name: "Paris",
        type: "administrative", addresstype: "town", osm_type: "relation", osm_id: 999,
        geojson: polygon,
        address: { town: "Paris", country_code: "us" },
      }],
    };
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher, minIntervalMs: 0, overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Adidas Paris", mode: "smart", limit: "20" },
  }, replyHarness());
  assert.equal(result.destinationGeocoder, "photon");
  assert.equal(result.destinationBoundarySource, null);
  assert.doesNotMatch(mainSql, /ST_Covers\(/);
  assert.ok(!mainValues.some(value => typeof value === "string" && value.includes('"type":"Polygon"')));
});

test("une suggestion ne déclenche pas Nominatim public", async () => {
  const app = appHarness();
  let nominatimCalls = 0;
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [] };
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === "photon.komoot.io") throw new Error("Photon indisponible");
    if (parsed.hostname === "nominatim.example") nominatimCalls++;
    throw new Error(`Hôte inattendu : ${parsed.hostname}`);
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher, minIntervalMs: 0, overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
  });
  await app.routes.get("GET /api/search/intelligent")({
    query: { q: "interim Paris", mode: "smart", suggest: "1", limit: "6" },
  }, replyHarness());
  assert.equal(nominatimCalls, 0);
});

test("Nominatim conserve le périmètre local d'un quartier comme La Défense", async () => {
  const app = appHarness();
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [{ brand: "Sephora" }] };
      if (sql.includes("location catalog")) return { rows: [] };
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.hostname === "photon.komoot.io") throw new Error("Photon indisponible");
    return {
      ok: true,
      json: async () => [{
        lat: "48.891008", lon: "2.2412078", name: "La Défense",
        type: "suburb", addresstype: "suburb",
        address: { suburb: "La Défense", city: "Courbevoie", country: "France" },
      }],
    };
  };
  registerIntelligentSearchRoutes(app, pool, {
    fetcher, minIntervalMs: 0, overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
    nominatimMinIntervalMs: 1000,
  });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Sephorra La Défense", mode: "smart", limit: "10" },
  }, replyHarness());

  assert.equal(result.destinationResolved, true);
  assert.equal(result.destinationGeocoder, "nominatim");
  assert.equal(result.destinationScope, "local");
  assert.equal(result.destinationRadiusM, 3000);
  assert.equal(result.destinationCity, null);
});

test("France Travail est classé Emploi & intérim via office=government et government=employment_agency", () => {
  const photon = photonToPlace(feature("Pôle Emploi", 48.8678, 2.3432, {
    osm_type: "N", osm_id: 77, osm_key: "office", osm_value: "government",
    extra: { brand: "France Travail", government: "employment_agency" },
  }));
  const overpass = overpassToPlace({
    type: "node", id: 78, lat: 48.8598, lon: 2.3699,
    tags: {
      name: "France Travail", brand: "France Travail", office: "government",
      government: "employment_agency",
    },
  });

  assert.equal(photon.category, "Emploi & intérim");
  assert.equal(overpass.category, "Emploi & intérim");
});

test("Photon peut répondre quand le catalogue PostgreSQL est indisponible", async () => {
  const app = appHarness();
  let mainQueryReached = false;
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog") || sql.includes("location catalog")) return { rows: [] };
      mainQueryReached = true;
      throw new Error("osm_places missing");
    },
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.hostname !== "photon.komoot.io") throw new Error(`Hôte inattendu : ${parsed.hostname}`);
    return {
      ok: true,
      json: async () => ({ features: [feature("Testplace Boutique", 48.85, 2.35)] }),
    };
  };
  registerIntelligentSearchRoutes(app, pool, { fetcher, minIntervalMs: 0, overpassEnabled: false });
  const reply = replyHarness();
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Testplace Boutique", mode: "global" },
  }, reply);

  assert.equal(mainQueryReached, true);
  assert.equal(reply.statusCode, 200);
  assert.equal(result.places[0]?.name, "Testplace Boutique");
  assert.match(result.externalError, /données enregistrées/);
});

test("le SQL de recherche classe aussi les agences publiques de l'emploi", async () => {
  const app = appHarness();
  let mainSql = "";
  const pool = {
    query: async sql => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [{ city: "Paris" }] };
      mainSql = sql;
      return { rows: [{ places: [], total: "0" }] };
    },
  };
  const fetcher = async url => {
    const parsed = new URL(url);
    if (parsed.searchParams.get("q") === "Paris") {
      return { ok: true, json: async () => ({ features: [feature("Paris", 48.8566, 2.3522, { type: "city" })] }) };
    }
    return { ok: true, json: async () => ({ features: [] }) };
  };
  registerIntelligentSearchRoutes(app, pool, { fetcher, minIntervalMs: 0, overpassEnabled: false });
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "interim Paris", mode: "smart", limit: "10" },
  }, replyHarness());

  assert.match(mainSql, /o\.tags->>'government'='employment_agency'/);
  assert.match(mainSql, /p\.raw_properties->>'government'='employment_agency'/);
  assert.equal(result.intent.activity, "Emploi & intérim");
});


test("Monaco seul est géocodé comme destination pays et non comme texte de commerce", async () => {
  const app = appHarness();
  const polygon = {
    type: "Polygon",
    coordinates: [[
      [7.42, 43.72],
      [7.44, 43.72],
      [7.44, 43.75],
      [7.42, 43.75],
      [7.42, 43.72],
    ]],
  };

  let mainSql = "";
  let mainValues = [];
  let photonCalls = 0;
  let nominatimCalls = 0;

  const pool = {
    query: async (sql, values = []) => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [] };
      mainSql = sql;
      mainValues = values;
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async url => {
    const parsed = new URL(url);

    if (parsed.hostname === "photon.komoot.io") {
      photonCalls += 1;
      assert.equal(parsed.searchParams.get("q"), "monaco");

      return {
        ok: true,
        json: async () => ({
          features: [{
            type: "Feature",
            geometry: {
              type: "Point",
              coordinates: [7.4276832, 43.7323492],
            },
            properties: {
              name: "Monaco",
              osm_key: "place",
              osm_value: "country",
              osm_type: "R",
              osm_id: 1124039,
              countrycode: "mc",
              country: "Monaco",
            },
          }],
        }),
      };
    }

    if (parsed.hostname === "nominatim.example") {
      nominatimCalls += 1;
      assert.equal(parsed.searchParams.get("q"), "monaco");
      assert.equal(parsed.searchParams.get("format"), "jsonv2");

      return {
        ok: true,
        json: async () => [{
          lat: "43.7323492",
          lon: "7.4276832",
          name: "Monaco",
          type: "administrative",
          addresstype: "country",
          osm_type: "R",
          osm_id: "1124039",
          address: {
            country: "Monaco",
            country_code: "mc",
          },
          geojson: polygon,
        }],
      };
    }

    throw new Error(`Hôte inattendu dans le test : ${parsed.hostname}`);
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    overpassEnabled: false,
    nominatimUrl: "https://nominatim.example/search",
    nominatimMinIntervalMs: 0,
  });

  // Recherche validée : pas de suggest=1, afin de tester la récupération
  // effective de la frontière administrative par Nominatim.
  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Monaco", mode: "global", limit: "10" },
  }, replyHarness());

  assert.equal(photonCalls, 1);
  assert.equal(nominatimCalls, 1);
  assert.equal(result.destinationResolved, true);
  assert.equal(result.destinationGeocoder, "photon");
  assert.equal(result.destinationScope, "country");
  assert.equal(result.destinationCountry, "Monaco");
  assert.equal(result.destinationCountryCode, "mc");
  assert.equal(result.destinationBoundarySource, "nominatim");
  assert.equal(result.destination, "monaco");
  assert.deepEqual(result.intent.freeText, []);

  // Une frontière administrative doit remplacer le simple rayon circulaire.
  assert.ok(mainSql.includes("ST_Covers("), "le SQL doit filtrer sur la frontière du pays");
  assert.equal(mainSql.includes("ST_DWithin("), false, "le SQL ne doit pas limiter Monaco à un cercle de 5 km");
  assert.ok(mainValues.includes("monaco"));
  assert.ok(mainValues.includes(JSON.stringify(polygon)));

  // Chaque paramètre SQL transmis à PostgreSQL doit être utilisé.
  const usedParameterIndexes = new Set(
    [...mainSql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
  );
  for (let index = 1; index <= mainValues.length; index++) {
    assert.ok(
      usedParameterIndexes.has(index),
      `le paramètre SQL $${index} ne doit pas rester inutilisé`,
    );
  }
  assert.equal(
    Math.max(...usedParameterIndexes),
    mainValues.length,
    "les index SQL doivent correspondre exactement aux valeurs transmises",
  );

  // Un commerce portant le nom Monaco ne doit pas être interprété comme un pays.
  const shopOnlyFeature = {
    type: "Feature",
    geometry: { type: "Point", coordinates: [7.4276, 43.7323] },
    properties: {
      name: "Monaco",
      osm_key: "shop",
      osm_value: "convenience",
    },
  };

  assert.equal(
    resolveDestinationFeature("Monaco", [shopOnlyFeature], { requireAdministrative: true }),
    null,
  );
});

test("la frontière administrative d'un pays filtre strictement les résultats", () => {
  const polygon = {
    type: "Polygon",
    coordinates: [[
      [7.42, 43.72],
      [7.44, 43.72],
      [7.44, 43.75],
      [7.42, 43.75],
      [7.42, 43.72],
    ]],
  };

  const destination = resolveDestinationFeature("Monaco", [{
    type: "Feature",
    geometry: { type: "Point", coordinates: [7.4276, 43.7323] },
    properties: {
      name: "Monaco",
      type: "country",
      countryCode: "mc",
      boundaryGeoJSON: polygon,
      osmType: "R",
      osmId: "1124039",
    },
  }], { requireAdministrative: true });

  assert.equal(destination.scope, "country");
  assert.deepEqual(destination.boundaryGeoJSON, polygon);
  assert.equal(matchesDestinationCity({ lat: 43.735, lon: 7.43 }, destination), true);
  assert.equal(matchesDestinationCity({ lat: 43.735, lon: 7.45 }, destination), false);
});


test("les recherches libres ne génèrent aucun paramètre SQL inutilisé", async () => {
  const app = appHarness();
  const observed = [];

  const pool = {
    query: async (sql, values = []) => {
      if (sql.includes("brand catalog")) return { rows: [] };
      if (sql.includes("location catalog")) return { rows: [] };

      observed.push({ sql, values });
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async () => ({
    ok: true,
    json: async () => ({ features: [] }),
  });

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
    cacheEnabled: false,
    overpassEnabled: false,
  });

  for (const [query, expectedTokens] of [
    ["garden", ["garden"]],
    ["garden shed", ["garden", "shed"]],
  ]) {
    const result = await app.routes.get("GET /api/search/intelligent")({
      query: { q: query, mode: "global", limit: "10" },
    }, replyHarness());

    assert.deepEqual(result.intent.freeText, expectedTokens);

    const generated = observed.at(-1);
    assert.ok(generated, `SQL généré pour : ${query}`);

    const usedIndexes = new Set(
      [...generated.sql.matchAll(/\$(\d+)/g)].map(match => Number(match[1]))
    );

    for (let index = 1; index <= generated.values.length; index++) {
      assert.ok(
        usedIndexes.has(index),
        `paramètre SQL $${index} inutilisé pour "${query}"`,
      );
    }

    assert.equal(
      Math.max(0, ...usedIndexes),
      generated.values.length,
      `index SQL incohérent pour "${query}"`,
    );
  }
});
