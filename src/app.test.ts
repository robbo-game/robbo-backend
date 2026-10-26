import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from './app.js';
import { MemoryProgressStore } from './store.js';

test('progress writes are versioned, idempotent and detect conflicts', async () => {
  const app = buildApp(new MemoryProgressStore());
  const headers = { 'if-match': '0', 'idempotency-key': 'a-very-long-idempotency-key' };
  const body = { schemaVersion: 1, gameVersion: 'robbo-java-1', deviceId: 'device-a', payload: { reached: 4 } };
  const first = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers, payload: body });
  assert.equal(first.statusCode, 200); assert.equal(first.headers.etag, '1');
  const retry = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers, payload: body });
  assert.equal(retry.statusCode, 200); assert.equal(JSON.parse(retry.body).revision, 1);
  const stale = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers: { ...headers, 'idempotency-key': 'another-long-idempotency-key' }, payload: body });
  assert.equal(stale.statusCode, 412); await app.close();
});

test('guest mode never requires an account and returns a cursor', async () => {
  const app = buildApp(new MemoryProgressStore());
  assert.deepEqual(JSON.parse((await app.inject('/v1/me')).body), { user: null, mode: 'guest' });
  assert.deepEqual(JSON.parse((await app.inject('/v1/progress')).body), { records: [], cursor: null }); await app.close();
});
