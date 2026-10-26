import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { GameSession } from '../vendor/robbo/src/application/game-session';
import { saveAttempt, restoreAttempt } from '../vendor/robbo/src/application/saved-attempt';
import { checkpoint } from '../vendor/robbo/src/application/replay';
import { packs } from '../vendor/robbo/src/generated/packs';
import { MemoryCheckpointStore } from './checkpoint-store.js';
import { checkpointRoutes } from './checkpoint-routes.js';
import { validateCheckpointInWorker } from './verifier.js';

test('phone pause checkpoint restores on desktop, preserves RNG and resumes identically', async () => {
  const phone = new GameSession(packs[0], 42); phone.selectPlanet(1); phone.step(); phone.togglePause();
  const app = Fastify(); const store = new MemoryCheckpointStore();
  checkpointRoutes(app,store,async request => request.headers['x-test-user'] as string | undefined,async () => true);
  const url = `/v1/checkpoints/${phone.pack.id}/current`;
  const payload = { deviceId: 'phone',attempt: saveAttempt(phone,1000) };
  const headers = { 'x-test-user': 'alice','if-match': '0','idempotency-key': 'phone-save-request-0001' };
  assert.equal((await app.inject(url)).statusCode,401);
  assert.equal((await app.inject({ url,headers: { 'x-test-user': 'alice' } })).statusCode,404);
  const saved = await app.inject({ method: 'PUT',url,headers,payload }); assert.equal(saved.statusCode,200); assert.equal(saved.headers.etag,'"1"');
  const retried = await app.inject({ method: 'PUT',url,headers,payload }); assert.equal(retried.json().revision,1);
  const cloud = await app.inject({ url,headers: { 'x-test-user': 'alice' } });
  const desktop = restoreAttempt(cloud.json().attempt,packs);
  assert.equal(desktop.paused,true); assert.equal(desktop.randomState,phone.randomState); assert.equal(checkpoint(desktop),checkpoint(phone));
  desktop.togglePause(); phone.togglePause(); desktop.step(); phone.step(); assert.equal(checkpoint(desktop),checkpoint(phone));
  const desktopSave = await app.inject({ method: 'PUT',url,headers: { ...headers,'if-match': '"1"','idempotency-key': 'desktop-save-request-002' },payload: { deviceId: 'desktop',attempt: saveAttempt(desktop,2000) } }); assert.equal(desktopSave.json().revision,2);
  const stale = await app.inject({ method: 'PUT',url,headers: { ...headers,'if-match': '1','idempotency-key': 'stale-phone-request-003' },payload }); assert.equal(stale.statusCode,412); assert.equal(stale.json().current.deviceId,'desktop');
  const reused = await app.inject({ method: 'PUT',url,headers,payload: { ...payload,deviceId: 'other-device' } }); assert.equal(reused.statusCode,409);
  assert.equal((await app.inject({ url,headers: { 'x-test-user': 'bob' } })).statusCode,404);
  const invalid = structuredClone(payload); invalid.attempt.world.robot.x = -10;
  assert.equal((await app.inject({ method: 'PUT',url,headers: { ...headers,'idempotency-key': 'invalid-state-request004' },payload: invalid })).statusCode,422);
  assert.equal((await app.inject({ method: 'PUT',url:'/v1/checkpoints/wrong/current',headers,payload })).statusCode,422);
  const tooLarge = { ...payload,padding: 'x'.repeat(1024*1024) };
  assert.equal((await app.inject({ method: 'PUT',url,headers,payload: tooLarge })).statusCode,413);
  await app.close();
});

test('checkpoint worker rejects unsupported engine and corrupted entity references', async () => {
  const session = new GameSession(packs[0],7); session.start();
  const state = saveAttempt(session);
  await assert.rejects(validateCheckpointInWorker({ ...state,engine: 'unsupported' }));
  const corrupt = structuredClone(state); corrupt.world.entities.push(corrupt.world.entities[0]);
  await assert.rejects(validateCheckpointInWorker(corrupt));
});
