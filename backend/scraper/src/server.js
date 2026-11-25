import { buildApp } from './app.js';
import { pool, REQUIRED_SCHEMA_VERSION, getSchemaVersion, initDb } from './db.js';
import { assertPlacesSchemaReady } from './places-api.js';
import { config } from './config.js';

async function main() {
  await initDb();
  await assertPlacesSchemaReady(pool);
  const app = await buildApp({ logger: true });
  await app.listen({ host: config.host, port: config.port });
  console.log(`[api] MapNifique Scraper API prête sur http://127.0.0.1:${config.port}`);

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      await app.close().catch(() => {});
      await pool.end().catch(() => {});
      process.exit(0);
    });
  }
}

main().catch(async (error) => {
  console.error(`[api] Démarrage refusé (schéma requis ${REQUIRED_SCHEMA_VERSION}, détecté ${await getSchemaVersion().catch(() => 'indisponible')}): ${error.message}`);
  await pool.end().catch(() => {});
  process.exitCode = 78;
});
