import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;
const spider = String(process.argv[2] || '').trim().toLowerCase();
if (!/^[a-z0-9_]{2,80}$/.test(spider)) {
  console.error('Usage: node src/import-alltheplaces.js <spider_name>');
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL absent.');
const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 10000 });

const clean = (value, max = 500) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
const brandKey = (value) => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 100);
const first = (...values) => values.find((value) => value !== undefined && value !== null && String(value).trim() !== '') ?? null;

function addressFrom(properties) {
  const keys = ['addr:full','addr:street_address','addr:housenumber','addr:street','addr:postcode','addr:city','addr:country'];
  return Object.fromEntries(keys.filter((key) => properties[key]).map((key) => [key, properties[key]]));
}

function categoryFrom(properties) {
  for (const key of ['shop','amenity','tourism','leisure','healthcare','office','craft']) {
    if (properties[key]) return `${key}=${properties[key]}`;
  }
  return null;
}

function toPlace(feature) {
  const properties = feature?.properties || {};
  const coordinates = feature?.geometry?.type === 'Point' ? feature.geometry.coordinates : null;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const lon = Number(coordinates[0]);
  const lat = Number(coordinates[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = clean(first(properties.name, properties.brand, properties.operator), 180);
  const externalId = clean(first(feature.id, properties.ref), 180);
  if (!name || !externalId) return null;
  const brand = clean(first(properties.brand, properties.operator), 150);
  return {
    externalId,
    spider: clean(properties['@spider'], 100) || spider,
    name,
    brand,
    brandKey: brandKey(brand || name),
    category: categoryFrom(properties),
    lat,
    lon,
    address: addressFrom(properties),
    phone: clean(first(properties.phone, properties['contact:phone']), 80),
    website: clean(first(properties.website, properties['contact:website']), 500),
    imageUrl: clean(first(properties.image, properties['contact:image']), 1000),
    openingHours: clean(first(properties.opening_hours, properties['opening_hours']), 500),
    sourceUrl: clean(first(properties['@source_uri'], properties.website), 1000),
    properties: Object.fromEntries(['branch','brand:wikidata','operator','operator:wikidata','addr:unit','addr:floor','addr:state','addr:city','addr:postcode','addr:country','shop','amenity','tourism','leisure','healthcare','office','wheelchair','cuisine','email','contact:email'].filter((key) => properties[key] !== undefined).map((key) => [key, properties[key]])),
  };
}

async function main() {
  const url = `https://data.alltheplaces.xyz/runs/latest/output/${encodeURIComponent(spider)}.geojson`;
  console.log(`[AllThePlaces] téléchargement : ${url}`);
  const response = await fetch(url, { headers: { Accept: 'application/geo+json, application/json' }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`AllThePlaces HTTP ${response.status}. Vérifie le nom du spider et son dernier run réussi.`);
  const geojson = await response.json();
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  if (!features.length) throw new Error('Aucune feature GeoJSON. Import annulé, aucune donnée modifiée.');

  await pool.query('BEGIN');
  let imported = 0;
  let skipped = 0;
  try {
    for (const feature of features) {
      const place = toPlace(feature);
      if (!place) { skipped += 1; continue; }
      await pool.query(`
        INSERT INTO places (source_id,external_id,spider,name,brand,brand_key,category,lat,lon,address,
          phone,website,image_url,opening_hours,source_url,source_license,raw_properties,last_seen_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,'CC0',$16::jsonb,NOW(),NOW())
        ON CONFLICT (source_id,external_id) DO UPDATE SET
          spider=EXCLUDED.spider,name=EXCLUDED.name,brand=COALESCE(EXCLUDED.brand,places.brand),
          brand_key=EXCLUDED.brand_key,category=COALESCE(EXCLUDED.category,places.category),
          lat=EXCLUDED.lat,lon=EXCLUDED.lon,address=EXCLUDED.address,
          phone=COALESCE(EXCLUDED.phone,places.phone),website=COALESCE(EXCLUDED.website,places.website),
          image_url=COALESCE(EXCLUDED.image_url,places.image_url),
          opening_hours=COALESCE(EXCLUDED.opening_hours,places.opening_hours),
          source_url=COALESCE(EXCLUDED.source_url,places.source_url),raw_properties=EXCLUDED.raw_properties,
          last_seen_at=NOW(),updated_at=NOW()
      `, [`alltheplaces:${spider}`, place.externalId, place.spider, place.name, place.brand,
        place.brandKey, place.category, place.lat, place.lon, JSON.stringify(place.address),
        place.phone, place.website, place.imageUrl, place.openingHours, place.sourceUrl,
        JSON.stringify(place.properties)]);
      imported += 1;
    }
    await pool.query('COMMIT');
  } catch (error) {
    await pool.query('ROLLBACK');
    throw error;
  }
  console.log(JSON.stringify({ spider, source: url, received: features.length, imported, skipped, result: 'ok' }, null, 2));
}

main().catch((error) => {
  console.error('[AllThePlaces] échec :', error.message);
  process.exitCode = 1;
}).finally(async () => {
  await pool.end().catch(() => {});
});
