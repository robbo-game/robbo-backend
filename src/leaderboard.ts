import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Redis } from './redis-store.js';
import type { VerifiedResult } from './verification.js';
export interface Board { campaign: string; planet: number; engine: string; campaignHash: string }
export interface Entry { rank: number; userId: string; displayName: string; elapsedMs: number; deaths: number }
export interface Leaderboards {
  submit(userId: string, replay: unknown): Promise<{ id: string; status: string }>;
  submission(userId: string, id: string): Promise<unknown | undefined>;
  list(board: Board, limit: number, offset: number): Promise<Entry[]>;
}
export class PostgresLeaderboards implements Leaderboards {
  constructor(private readonly pool: Pool, private readonly redis: Redis) {}
  async submit(userId: string, replay: unknown): Promise<{ id: string; status: string }> {
    const json = JSON.stringify(replay), hash = createHash('sha256').update(json).digest('hex');
    const result = await this.pool.query(`INSERT INTO leaderboard_submission(user_id,replay_hash,replay) VALUES($1,$2,$3)
      ON CONFLICT(user_id,replay_hash) DO UPDATE SET replay_hash=EXCLUDED.replay_hash RETURNING id,status`, [userId, hash, json]);
    return result.rows[0];
  }
  async submission(userId: string, id: string): Promise<unknown | undefined> {
    const result = await this.pool.query('SELECT id,status,error,created_at FROM leaderboard_submission WHERE user_id=$1 AND id=$2', [userId,id]); return result.rows[0];
  }
  async list(board: Board, limit: number, offset: number): Promise<Entry[]> {
    const key = `leaderboard:${board.campaign}:${board.planet}:${board.engine}:${board.campaignHash}:${limit}:${offset}`;
    try {
      const pointer = await this.redis.get(key);
      if (pointer) { const rows = await this.redis.zRange(pointer, 0, -1); if (rows.length) return rows.map(value => JSON.parse(value) as Entry); }
    } catch { /* PostgreSQL remains authoritative when the cache is unavailable. */ }
    const result = await this.pool.query(`SELECT row_number() OVER (ORDER BY r.elapsed_ticks,r.deaths,r.user_id) AS rank,
      r.user_id,u.display_name,r.elapsed_ticks,r.deaths FROM leaderboard_result r JOIN app_user u ON u.id=r.user_id
      WHERE campaign=$1 AND planet=$2 AND engine=$3 AND campaign_hash=$4 ORDER BY r.elapsed_ticks,r.deaths,r.user_id LIMIT $5 OFFSET $6`, [board.campaign,board.planet,board.engine,board.campaignHash,limit,offset]);
    const entries: Entry[] = result.rows.map(r => ({ rank: Number(r.rank), userId: r.user_id, displayName: r.display_name, elapsedMs: r.elapsed_ticks * 100, deaths: r.deaths }));
    // Immutable short-lived snapshots avoid interleaving DEL/ZADD from concurrent requests.
    if (entries.length) try {
      const snapshot = `${key}:${randomUUID()}`;
      await this.redis.multi().zAdd(snapshot, entries.map(entry => ({ score: entry.rank, value: JSON.stringify(entry) }))).expire(snapshot, 30).set(key, snapshot, { EX: 15 }).exec();
    } catch { /* A cache failure must not hide verified results. */ }
    return entries;
  }
}
export async function runVerificationJob(pool: Pool, verify: (replay: unknown) => Promise<VerifiedResult>): Promise<boolean> {
  const claimed = await pool.query(`UPDATE leaderboard_submission SET status='processing',locked_at=now(),attempts=attempts+1 WHERE id=(
    SELECT id FROM leaderboard_submission WHERE (status='queued' OR (status='processing' AND locked_at < now()-interval '1 minute')) AND attempts < 3
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,user_id,replay,attempts`);
  const job = claimed.rows[0]; if (!job) return false;
  let verified: VerifiedResult;
  try { verified = await verify(job.replay); }
  catch {
    await pool.query("UPDATE leaderboard_submission SET status='rejected',error='invalid_or_incompatible_replay',replay='null'::jsonb WHERE id=$1 AND attempts=$2", [job.id,job.attempts]); return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query("SELECT id FROM leaderboard_submission WHERE id=$1 AND status='processing' AND attempts=$2 FOR UPDATE", [job.id,job.attempts]);
    if (!current.rowCount) { await client.query('ROLLBACK'); return true; }
    await client.query(`INSERT INTO leaderboard_result(user_id,campaign,planet,engine,campaign_hash,elapsed_ticks,deaths,submission_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(user_id,campaign,planet,engine,campaign_hash) DO UPDATE SET
      elapsed_ticks=EXCLUDED.elapsed_ticks,deaths=EXCLUDED.deaths,submission_id=EXCLUDED.submission_id,updated_at=now()
      WHERE (EXCLUDED.elapsed_ticks,EXCLUDED.deaths) < (leaderboard_result.elapsed_ticks,leaderboard_result.deaths)`,
      [job.user_id,verified.campaign,verified.planet,verified.engine,verified.campaignHash,verified.elapsedTicks,verified.deaths,job.id]);
    await client.query("UPDATE leaderboard_submission SET status='verified' WHERE id=$1", [job.id]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  return true;
}
