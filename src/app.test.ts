import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from './app.js';
import { MemoryProgressStore } from './store.js';

test('progress writes are versioned, idempotent and detect conflicts', async () => {
  const app = buildApp(new MemoryProgressStore(), [], async () => '00000000-0000-4000-8000-000000000001');
  const headers = { 'if-match': '0', 'idempotency-key': 'a-very-long-idempotency-key' };
  const body = { schemaVersion: 1, gameVersion: 'robbo-java-1', deviceId: 'device-a', payload: { reached: 4 } };
  const first = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers, payload: body });
  assert.equal(first.statusCode, 200); assert.equal(first.headers.etag, '1');
  const retry = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers, payload: body });
  assert.equal(retry.statusCode, 200); assert.equal(JSON.parse(retry.body).revision, 1);
  const stale = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers: { ...headers, 'idempotency-key': 'another-long-idempotency-key' }, payload: body });
  assert.equal(stale.statusCode, 412); await app.close();
});

test('guest mode cannot access cloud progress without authentication', async () => {
  const app = buildApp(new MemoryProgressStore());
  assert.deepEqual(JSON.parse((await app.inject('/v1/me')).body), { user: null, mode: 'guest' });
  assert.equal((await app.inject('/v1/progress')).statusCode, 401);
  const write = await app.inject({ method: 'PUT', url: '/v1/progress/01/main', headers: { 'if-match': '0', 'idempotency-key': 'unauthenticated-write-key' }, payload: { schemaVersion: 1, gameVersion: 'test', deviceId: 'test', payload: {} } });
  assert.equal(write.statusCode, 401);
  const crossOrigin = await app.inject({ url: '/healthz', headers: { origin: 'https://untrusted.example' } });
  assert.equal(crossOrigin.headers['access-control-allow-origin'], undefined);
  await app.close();
});
