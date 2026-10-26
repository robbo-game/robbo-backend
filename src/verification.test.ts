import assert from 'node:assert/strict';
import test from 'node:test';
import { GameSession } from '../vendor/robbo/src/application/game-session';
import { ReplayRecorder } from '../vendor/robbo/src/application/replay';
import type { Pack } from '../vendor/robbo/src/engine/model';
import { verifyReplay } from './verification.js';
import { verifyInWorker } from './verifier.js';
const pack: Pack = { id: 'fixture', name: 'Verifier test', lastLevel: 1, levels: [{ number: 1, width: 6, height: 3, colour: '#000', author: 'test', notes: '', offset: '', rows: ['ssssss', 'sR.T!s', 'ssssss'], options: {} }] };
function fixture(retry = false): ReplayRecorder {
  const session = new GameSession(pack, 7); session.start(); const recorder = new ReplayRecorder(session);
  if (retry) { recorder.action({ type: 'retry' }); for (let i = 0; i < 12; i++) recorder.step(); }
  for (let i = 0; i < 20 && session.world.status !== 'won'; i++) { recorder.action({ type: 'command', direction: 0, fire: false }); recorder.step(); }
  assert.equal(session.world.status, 'won'); return recorder;
}
test('verifier derives time/deaths, includes retries and rejects forged checkpoints', () => {
  const normal = fixture(); const score = verifyReplay(normal.data, [pack]);
  assert.equal(score.elapsedTicks, normal.data.frames.length); assert.equal(score.deaths, 0);
  const retry = verifyReplay(fixture(true).data, [pack]); assert.equal(retry.deaths, 1); assert.equal(retry.elapsedTicks, score.elapsedTicks + 12);
  const forged = structuredClone(normal.data); forged.frames[0].checkpoint = 'forged'; assert.throws(() => verifyReplay(forged, [pack]), /diverged/);
  const unfinished = structuredClone(normal.data); unfinished.frames.pop(); assert.throws(() => verifyReplay(unfinished, [pack]), /not_completed/);
  const extended = structuredClone(normal.data); extended.frames.push({ ...extended.frames.at(-1)!, tick: extended.frames.length }); assert.throws(() => verifyReplay(extended, [pack]), /diverged/);
  const incompatible = structuredClone(normal.data); incompatible.engine = 'old'; assert.throws(() => verifyReplay(incompatible, [pack]), /unsupported/);
});
test('normal recordings can continue after completion without changing the score', () => {
  const recording = fixture(); const score = verifyReplay(recording.data, [pack]);
  for (let i = 0; i < 8; i++) recording.step();
  assert.deepEqual(verifyReplay(recording.data, [pack]), score);
});
test('manual restarts cannot reset recorded time or avoid lost-attempt penalty', () => {
  const normal = fixture(); const session = new GameSession(pack, 7); session.start(); const recorder = new ReplayRecorder(session);
  recorder.action({ type: 'restart' }); recorder.step();
  for (let i = 0; i < 20 && session.world.status !== 'won'; i++) { recorder.action({ type: 'command', direction: 0, fire: false }); recorder.step(); }
  const result = verifyReplay(recorder.data, [pack]); assert.equal(result.deaths, 1); assert.equal(result.elapsedTicks, normal.data.frames.length + 1);
});
test('isolated production worker rejects custom campaigns', async () => { await assert.rejects(verifyInWorker(fixture().data), /invalid/); });
