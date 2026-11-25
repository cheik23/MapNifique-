
import test from "node:test";
import assert from "node:assert/strict";
import {
  registerIntelligentSearchRoutes,
  resolveSearchIntent,
} from "./intelligent-search.js";

function makeApp() {
  const routes = new Map();
  return {
    routes,
    get(path, handler) {
      routes.set(`GET ${path}`, handler);
    },
  };
}

function makeReply() {
  return {
    statusCode: 200,
    payload: null,
    code(code) { this.statusCode = code; return this; },
    send(payload) { this.payload = payload; return payload; },
  };
}

function feature(name, lat, lon, properties = {}) {
  return {
    type: "Feature",
    geometry: { coordinates: [lon, lat] },
    properties: { name, ...properties },
  };
}

test("corrige Zara et conserve Les Passages Boulogne", () => {
  const result = resolveSearchIntent(
    "Zarra Les Passages Boulogne",
    ["Zara", "Zara Home"],
  );

  assert.equal(result.brand, "Zara");
  assert.equal(result.correctedQuery, "Zara Les Passages Boulogne");
  assert.equal(result.destinationQuery, "Les Passages Boulogne");
});

test("corrige Adidas malgré la variante Adidas Originals", () => {
  const result = resolveSearchIntent(
    "Adiddas Paris",
    ["Adidas", "Adidas Originals"],
  );

  assert.equal(result.brand, "Adidas");
  assert.equal(result.destinationQuery, "Paris");
});

test("reconnaît Sephora et préserve La Défense", () => {
  const result = resolveSearchIntent(
    "Sephorra La Défense",
    ["Sephora"],
  );

  assert.equal(result.brand, "Sephora");
  assert.equal(result.destinationQuery, "La Défense");
});

test("sépare la catégorie pharmacie de la ville Lyon", () => {
  const result = resolveSearchIntent("pharmacie Lyon", ["Zara"]);

  assert.equal(result.category, "Pharmacie");
  assert.equal(result.destinationQuery, "Lyon");
  assert.deepEqual(result.locationTokens, ["lyon"]);
});

test("le mode intelligent recherche Zara près de la destination sans filtre GPS", async () => {
  const app = makeApp();
  let businessQuery = "";
  let sql = "";

  const pool = {
    query: async statement => {
      if (statement.includes("catalog")) {
        return { rows: [{ brand: "Zara" }] };
      }

      sql = statement;
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async url => {
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q");

    if (q === "Les Passages Boulogne") {
      return {
        ok: true,
        json: async () => ({
          features: [
            feature("Les Passages", 48.8372, 2.2399, {
              city: "Boulogne-Billancourt",
              type: "district",
            }),
          ],
        }),
      };
    }

    businessQuery = q;

    return {
      ok: true,
      json: async () => ({
        features: [
          feature("Zara", 48.8370757, 2.2398373, {
            osm_type: "N",
            osm_id: 123,
            osm_key: "shop",
            osm_value: "clothes",
            street: "Les Passages",
            postcode: "92100",
            city: "Boulogne-Billancourt",
            extra: { brand: "Zara" },
          }),
        ],
      }),
    };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
  });

  const result = await app.routes.get("GET /api/search/intelligent")({
    query: {
      q: "Zarra Les Passages Boulogne",
      mode: "smart",
      lat: "48.85",
      lon: "2.35",
      radiusM: "3000",
      limit: "10",
    },
  }, makeReply());

  assert.equal(result.mode, "global");
  assert.equal(result.destinationResolved, true);
  assert.equal(result.destinationRadiusM, 3000);
  assert.equal(result.correction.to, "Zara");
  assert.equal(businessQuery, "Zara");
  assert.match(sql, /ST_DWithin/);
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].name, "Zara");
  assert.equal(result.places[0].address.city, "Boulogne-Billancourt");
});

test("pharmacie Lyon filtre les lieux qui ne sont pas des pharmacies", async () => {
  const app = makeApp();
  let photonUrl = "";

  const pool = {
    query: async statement => {
      if (statement.includes("catalog")) return { rows: [] };
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async url => {
    const parsed = new URL(url);
    const q = parsed.searchParams.get("q");

    if (q === "Lyon") {
      return {
        ok: true,
        json: async () => ({
          features: [
            feature("Lyon", 45.7578, 4.832, {
              type: "city",
              city: "Lyon",
            }),
          ],
        }),
      };
    }

    photonUrl = url;

    return {
      ok: true,
      json: async () => ({
        features: [
          feature("Pharmacie Lyon Saxe", 45.76, 4.84, {
            osm_key: "amenity",
            osm_value: "pharmacy",
            osm_type: "N",
            osm_id: 456,
            city: "Lyon",
            extra: {},
          }),
          feature("Musée de la Pharmacie de Lyon", 45.76, 4.84, {
            osm_key: "tourism",
            osm_value: "museum",
            city: "Lyon",
            extra: {},
          }),
        ],
      }),
    };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    minIntervalMs: 0,
  });

  const result = await app.routes.get("GET /api/search/intelligent")({
    query: { q: "pharmacie Lyon", mode: "smart", limit: "10" },
  }, makeReply());

  assert.equal(result.mode, "global");
  assert.equal(result.destinationResolved, true);
  assert.ok(photonUrl.includes("osm_tag=amenity%3Apharmacy"));
  assert.equal(result.places.length, 1);
  assert.equal(result.places[0].category, "Pharmacie");
});

test("la proximité conserve son filtre GPS strict", async () => {
  const app = makeApp();
  let sql = "";

  const pool = {
    query: async statement => {
      if (statement.includes("catalog")) {
        return { rows: [{ brand: "Zara" }] };
      }
      sql = statement;
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher: async () => ({
      ok: true,
      json: async () => ({ features: [] }),
    }),
    minIntervalMs: 0,
  });

  const result = await app.routes.get("GET /api/search/intelligent")({
    query: {
      q: "Zara",
      mode: "nearby",
      lat: "48.85",
      lon: "2.35",
      radiusM: "3000",
    },
  }, makeReply());

  assert.equal(result.mode, "nearby");
  assert.match(sql, /ST_DWithin/);
});

test("la route intelligente utilise le PHOTON_URL configuré", async () => {
  const app = makeApp();
  const requestedUrls = [];

  const pool = {
    query: async statement => {
      if (statement.includes("catalog")) return { rows: [] };
      return { rows: [{ places: [], total: "0" }] };
    },
  };

  const fetcher = async url => {
    requestedUrls.push(new URL(url));
    return {
      ok: true,
      json: async () => ({ features: [] }),
    };
  };

  registerIntelligentSearchRoutes(app, pool, {
    fetcher,
    photonUrl: "http://photon-test:2322",
    minIntervalMs: 0,
    overpassEnabled: false,
    nominatimEnabled: false,
  });

  await app.routes.get("GET /api/search/intelligent")({
    query: { q: "Adidas", mode: "global", limit: "10" },
  }, makeReply());

  assert.ok(requestedUrls.length > 0, "la recherche doit appeler Photon");
  assert.ok(
    requestedUrls.every(url => url.origin === "http://photon-test:2322"),
    "toutes les requêtes doivent utiliser le serveur Photon configuré",
  );
  assert.ok(
    requestedUrls.every(url => url.pathname === "/api/"),
    "les requêtes doivent utiliser l'endpoint /api/ de Photon",
  );
});
