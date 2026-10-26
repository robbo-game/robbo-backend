import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { PostgresAccounts } from './auth.js';
import { PostgresLeaderboards, runVerificationJob, type Board } from './leaderboard.js';
import { RedisAuthStore } from './redis-store.js';
const enabled = Boolean(process.env.TEST_DATABASE_URL && process.env.TEST_REDIS_URL);
test('PostgreSQL queue publishes verified personal bests; Redis orders cached time/death results', { skip: !enabled }, async () => {
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const redis = createClient({ url: process.env.TEST_REDIS_URL }); await redis.connect();
  const cache = new PostgresLeaderboards(pool, redis);
  const board: Board = { campaign: randomUUID(), planet: 1, engine: 'test', campaignHash: '12345678' };
  const redisKeys: string[] = [];
  try {
    for (const migration of ['001_initial.sql', '002_auth_leaderboards.sql']) await pool.query(await readFile(new URL(`../sql/${migration}`, import.meta.url), 'utf8'));
    const accounts = new PostgresAccounts(pool);
    const a = await accounts.github('1', 'first'), b = await accounts.github('2', 'second');
    assert.equal((await accounts.github('1', 'renamed')).id, a.id);
    const limits = new RedisAuthStore(redis); const key = `test:${randomUUID()}`; redisKeys.push(key, `limit:${key}`);
    await limits.put(key, a.id, 60); assert.equal(await limits.take(key), a.id); assert.equal(await limits.take(key), null);
    assert.equal(await limits.allow(key, 1, 60), true); assert.equal(await limits.allow(key, 1, 60), false);
    const submit = async (user: string, ticks: number, deaths: number) => {
      const job = await cache.submit(user, { unique: randomUUID(), ticks, deaths });
      await runVerificationJob(pool, async replay => { const r = replay as { ticks: number; deaths: number }; return { ...board, elapsedTicks: r.ticks, deaths: r.deaths }; });
      assert.equal((await cache.submission(user, job.id) as { status: string }).status, 'verified');
    };
    const dedupe = await cache.submit(a.id, { bad: true }); assert.equal((await cache.submit(a.id, { bad: true })).id, dedupe.id);
    await runVerificationJob(pool, async () => { throw Error('invalid'); });
    assert.equal((await cache.submission(a.id, dedupe.id) as { status: string }).status, 'rejected');
    assert.equal(await cache.submission(b.id, dedupe.id), undefined);
    await submit(a.id, 100, 2); await submit(b.id, 100, 1); await submit(a.id, 120, 0);
    const entries = await cache.list(board, 25, 0);
    assert.deepEqual(entries.map(e => [e.userId,e.elapsedMs,e.deaths,e.rank]), [[b.id,10000,1,1], [a.id,10000,2,2]]);
    assert.deepEqual(await cache.list(board, 25, 0), entries);
    const pointer = `leaderboard:${board.campaign}:1:test:12345678:25:0`; redisKeys.push(pointer);
    const snapshot = await redis.get(pointer); assert.ok(snapshot); redisKeys.push(snapshot);
    assert.equal(await redis.zCard(snapshot), 2);
    assert.equal((await cache.list(board, 1, 1))[0].rank, 2);
    const pagePointer = `leaderboard:${board.campaign}:1:test:12345678:1:1`; redisKeys.push(pagePointer); const page = await redis.get(pagePointer); if (page) redisKeys.push(page);
    // PostgreSQL result updates independently; cache expires within 15 seconds.
    await submit(a.id, 99, 5);
    const updated = await pool.query('SELECT elapsed_ticks,deaths FROM leaderboard_result WHERE user_id=$1', [a.id]); assert.equal(updated.rows[0].elapsed_ticks, 99); assert.equal(updated.rows[0].deaths, 5);
  } finally {
    if (redisKeys.length) await redis.del(redisKeys);
    await redis.close(); await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end();
  }
});
