/**
 * Health contract: never report database=connected unless a real query succeeded.
 * Schema readiness is reported independently from database connectivity.
 */
export function createHealthHandler({ pool, getSchemaVersion, requiredSchemaVersion }) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('pool.query requis');
  if (typeof getSchemaVersion !== 'function') throw new TypeError('getSchemaVersion requis');
  if (!Number.isInteger(requiredSchemaVersion)) throw new TypeError('requiredSchemaVersion invalide');

  return async function healthHandler(_request, reply) {
    let ping;
    try {
      ping = await pool.query('SELECT NOW() AS database_time');
    } catch {
      return reply.code(503).send({
        status: 'unavailable',
        database: 'disconnected',
        schema: { version: null, required: requiredSchemaVersion },
      });
    }

    let version;
    try {
      version = await getSchemaVersion();
    } catch {
      return reply.code(503).send({
        status: 'unavailable',
        database: 'connected',
        schema: { version: null, required: requiredSchemaVersion, state: 'unreadable' },
      });
    }

    if (version !== requiredSchemaVersion) {
      return reply.code(503).send({
        status: 'unavailable',
        database: 'connected',
        schema: { version, required: requiredSchemaVersion },
      });
    }

    return reply.code(200).send({
      status: 'ok',
      database: 'connected',
      schema: { version },
      databaseTime: ping.rows?.[0]?.database_time ?? null,
    });
  };
}
