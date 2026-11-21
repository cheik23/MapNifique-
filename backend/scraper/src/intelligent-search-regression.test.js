import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveSearchIntent,
  deduplicate,
  resolveDestinationFeature,
  photonToPlace,
} from "./intelligent-search.js";

const brands = [
  "Zara",
  "Zara Home",
  "Adidas",
  "Adidas Originals",
  "Sephora",
  // Noms de commerces volontairement présents pour tester la protection.
  "Charmanie",
  "Pharmacie Chambrin",
];

test("corrige Zara sans perdre la destination Les Passages", () => {
  const result = resolveSearchIntent(
    "Zarra Les Passages Boulogne",
    brands
  );

  assert.equal(result.brand, "Zara");
  assert.equal(result.destinationQuery, "Les Passages Boulogne");
  assert.deepEqual(result.correction, {
    from: "Zarra",
    to: "Zara",
  });
});

test("corrige Adidas et conserve Paris", () => {
  const result = resolveSearchIntent("Adiddas Paris", brands);

  assert.equal(result.brand, "Adidas");
  assert.equal(result.destinationQuery, "Paris");
  assert.equal(result.correction.to, "Adidas");
});

test("corrige Sephora et conserve La Défense", () => {
  const result = resolveSearchIntent("Sephorra La Défense", brands);

  assert.equal(result.brand, "Sephora");
  assert.equal(result.destinationQuery, "La Défense");
  assert.equal(result.correction.to, "Sephora");
});

test("pharmacie reste une catégorie malgré les noms de commerces ressemblants", () => {
  const result = resolveSearchIntent("pharmacie Lyon", brands);

  assert.equal(result.brand, null);
  assert.equal(result.category, "Pharmacie");
  assert.equal(result.destinationQuery, "Lyon");
  assert.deepEqual(result.locationTokens, ["lyon"]);
  assert.deepEqual(result.searchTokens, []);
});


test("Adiddas Paris ne confond pas la ville avec une marque concurrente", () => {
  const expandedBrands = [...brands, "Pariès"];

  const result = resolveSearchIntent(
    "Adiddas Paris",
    expandedBrands,
    ["Paris"]
  );

  assert.equal(result.brand, "Adidas");
  assert.equal(result.destinationQuery, "Paris");
  assert.deepEqual(result.correction, {
    from: "Adiddas",
    to: "Adidas",
  });
});

test("Paris seul reste une destination et ne devient pas Pariès", () => {
  const result = resolveSearchIntent(
    "Paris",
    [...brands, "Pariès"],
    ["Paris"]
  );

  assert.equal(result.brand, null);
  assert.equal(result.destinationQuery, "Paris");
});

test("la déduplication conserve l'adresse la plus complète", () => {
  const local = {
    id: "osm-N-123",
    name: "Zara",
    brand: "Zara",
    lat: 48.8370015,
    lon: 2.2400844,
    address: {},
    city: "",
    street: "",
    postcode: "",
  };

  const photon = {
    id: "osm-N-123",
    name: "Zara",
    brand: "Zara",
    lat: 48.8370015,
    lon: 2.2400844,
    address: {
      road: "Centre commercial Les Passages",
      street: "Centre commercial Les Passages",
      postcode: "92100",
      city: "Boulogne-Billancourt",
      country: "France",
    },
  };

  const result = deduplicate([local, photon]);

  assert.equal(result.length, 1);
  assert.equal(result[0].city, "Boulogne-Billancourt");
  assert.equal(result[0].postcode, "92100");
  assert.equal(result[0].address.country, "France");
});

test("un quartier utilise un rayon plus réduit qu'une grande ville", () => {
  const district = resolveDestinationFeature("La Défense", [{
    properties: {
      name: "La Défense",
      type: "locality",
    },
    geometry: {
      coordinates: [2.239, 48.892],
    },
  }]);

  const city = resolveDestinationFeature("Lyon", [{
    properties: {
      name: "Lyon",
      type: "city",
    },
    geometry: {
      coordinates: [4.8357, 45.764],
    },
  }]);

  assert.equal(district.radiusM, 3000);
  assert.equal(city.radiusM, 18000);
});


test("une recherche magasin de sport est reconnue comme catégorie Sport", () => {
  const result = resolveSearchIntent("magasin de sport Paris", []);

  assert.equal(result.category, "Sport");
  assert.equal(result.destinationQuery, "Paris");
});

test("shop=sports est classé Sport tandis que shop=clothes reste Mode", () => {
  const makeFeature = (id, value) => ({
    properties: {
      name: "Adidas",
      osm_type: "N",
      osm_id: id,
      osm_key: "shop",
      osm_value: value,
    },
    geometry: {
      coordinates: [2.36, 48.85],
    },
  });

  const sports = photonToPlace(makeFeature(501, "sports"));
  const clothes = photonToPlace(makeFeature(502, "clothes"));

  assert.equal(sports.category, "Sport");
  assert.equal(clothes.category, "Mode");
});
