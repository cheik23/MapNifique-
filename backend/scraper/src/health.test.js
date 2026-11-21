import test from 'node:test';
import assert from 'node:assert/strict';
import { createHealthHandler } from './health.js';

function makeReply() {
  return {
    statusCode: 200,
    payload: null,
    code(value) { this.statusCode = value; return this; },
    send(value) { this.payload = value; return value; },
  };
}

test('health reports disconnected when the database ping fails', async () => {
  const handler = createHealthHandler({
    pool: { query: async () => { throw new Error('connection refused'); } },
    getSchemaVersion: async () => 2,
    requiredSchemaVersion: 2,
  });
  const reply = makeReply();
  await handler({}, reply);
  assert.equal(reply.statusCode, 503);
  assert.equal(reply.payload.database, 'disconnected');
});

test('health reports connected but schema unavailable when version cannot be read', async () => {
  const handler = createHealthHandler({
    pool: { query: async () => ({ rows: [{ database_time: '2026-11-20T00:00:00Z' }] }) },
    getSchemaVersion: async () => { throw new Error('permission denied'); },
    requiredSchemaVersion: 2,
  });
  const reply = makeReply();
  await handler({}, reply);
  assert.equal(reply.statusCode, 503);
  assert.equal(reply.payload.database, 'connected');
  assert.equal(reply.payload.schema.state, 'unreadable');
  assert.equal(JSON.stringify(reply.payload).includes('permission denied'), false);
});

test('health reports connected but schema not ready when migration is pending', async () => {
  const handler = createHealthHandler({
    pool: { query: async () => ({ rows: [{ database_time: 'db-time' }] }) },
    getSchemaVersion: async () => 1,
    requiredSchemaVersion: 2,
  });
  const reply = makeReply();
  await handler({}, reply);
  assert.equal(reply.statusCode, 503);
  assert.equal(reply.payload.database, 'connected');
  assert.deepEqual(reply.payload.schema, { version: 1, required: 2 });
});

test('health returns 200 only when database is reachable and schema version matches', async () => {
  const handler = createHealthHandler({
    pool: { query: async () => ({ rows: [{ database_time: 'db-time' }] }) },
    getSchemaVersion: async () => 2,
    requiredSchemaVersion: 2,
  });
  const reply = makeReply();
  await handler({}, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.payload.status, 'ok');
  assert.equal(reply.payload.database, 'connected');
  assert.equal(reply.payload.databaseTime, 'db-time');
});
