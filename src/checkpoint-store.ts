import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { SavedAttempt } from '../vendor/robbo/src/application/saved-attempt';
export interface Checkpoint {
  campaign: string; slot: string; revision: number; deviceId: string;
  attempt: SavedAttempt; updatedAt: string;
}
export type CheckpointDraft = Pick<Checkpoint, 'campaign' | 'slot' | 'deviceId' | 'attempt'>;
export type SaveResult = { status: 'saved'; record: Checkpoint } | { status: 'conflict'; current: Checkpoint | null } | { status: 'key_reused' } | { status: 'slot_limit' };
export interface CheckpointStore {
  get(user: string, campaign: string, slot: string): Promise<Checkpoint | undefined>;
  save(user: string, draft: CheckpointDraft, revision: number, key: string): Promise<SaveResult>;
}
function fingerprint(draft: CheckpointDraft, revision: number): string {
  return createHash('sha256').update(JSON.stringify([draft.campaign,draft.slot,draft.deviceId,revision,draft.attempt])).digest('hex');
}
export class MemoryCheckpointStore implements CheckpointStore {
  private records = new Map<string, Checkpoint>();
  private requests = new Map<string, { fingerprint: string; record: Checkpoint }>();
  async get(user: string, campaign: string, slot: string): Promise<Checkpoint | undefined> { const record = this.records.get(`${user}:${campaign}:${slot}`); return record && structuredClone(record); }
  async save(user: string, draft: CheckpointDraft, revision: number, key: string): Promise<SaveResult> {
    const hash = fingerprint(draft, revision), id = `${user}:${draft.campaign}:${draft.slot}`, request = this.requests.get(`${user}:${key}`);
    if (request) return request.fingerprint === hash ? { status: 'saved', record: structuredClone(request.record) } : { status: 'key_reused' };
    const current = this.records.get(id);
    if ((current?.revision ?? 0) !== revision) return { status: 'conflict', current: current ? structuredClone(current) : null };
    const record = { ...structuredClone(draft), revision: revision + 1, updatedAt: new Date().toISOString() };
    this.records.set(id, record); this.requests.set(`${user}:${key}`, { fingerprint: hash, record });
    return { status: 'saved', record: structuredClone(record) };
  }
}
export class PostgresCheckpointStore implements CheckpointStore {
  constructor(private readonly pool: Pool) {}
  async get(user: string, campaign: string, slot: string): Promise<Checkpoint | undefined> {
    const result = await this.pool.query('SELECT campaign,slot,revision,device_id,attempt,updated_at FROM game_checkpoint WHERE user_id=$1 AND campaign=$2 AND slot=$3', [user,campaign,slot]);
    return result.rows[0] && row(result.rows[0]);
  }
  async save(user: string, draft: CheckpointDraft, revision: number, key: string): Promise<SaveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize account writes, including missing rows and repeated idempotency keys.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [user]);
      const hash = fingerprint(draft, revision);
      await client.query("DELETE FROM checkpoint_request WHERE user_id=$1 AND created_at < now()-interval '7 days'", [user]);
      const prior = await client.query('SELECT fingerprint,response FROM checkpoint_request WHERE user_id=$1 AND key=$2', [user,key]);
      if (prior.rows[0]) { await client.query('COMMIT'); return prior.rows[0].fingerprint === hash ? { status: 'saved', record: prior.rows[0].response } : { status: 'key_reused' }; }
      const existing = await client.query('SELECT campaign,slot,revision,device_id,attempt,updated_at FROM game_checkpoint WHERE user_id=$1 AND campaign=$2 AND slot=$3', [user,draft.campaign,draft.slot]);
      const current = existing.rows[0] && row(existing.rows[0]);
      if ((current?.revision ?? 0) !== revision) { await client.query('COMMIT'); return { status: 'conflict', current: current ?? null }; }
      if (!current) {
        const count = await client.query('SELECT count(*) FROM game_checkpoint WHERE user_id=$1', [user]);
        if (Number(count.rows[0].count) >= 20) { await client.query('COMMIT'); return { status: 'slot_limit' }; }
      }
      const result = await client.query(`INSERT INTO game_checkpoint(user_id,campaign,slot,revision,device_id,attempt) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(user_id,campaign,slot) DO UPDATE SET revision=EXCLUDED.revision,device_id=EXCLUDED.device_id,attempt=EXCLUDED.attempt,updated_at=clock_timestamp()
        RETURNING campaign,slot,revision,device_id,attempt,updated_at`, [user,draft.campaign,draft.slot,revision+1,draft.deviceId,draft.attempt]);
      const record = row(result.rows[0]);
      await client.query(`INSERT INTO checkpoint_history SELECT user_id,campaign,slot,revision,device_id,attempt,updated_at FROM game_checkpoint WHERE user_id=$1 AND campaign=$2 AND slot=$3`, [user,draft.campaign,draft.slot]);
      await client.query('DELETE FROM checkpoint_history WHERE user_id=$1 AND campaign=$2 AND slot=$3 AND revision <= $4', [user,draft.campaign,draft.slot,record.revision-5]);
      await client.query('INSERT INTO checkpoint_request(user_id,key,fingerprint,response) VALUES($1,$2,$3,$4)', [user,key,hash,record]);
      await client.query('DELETE FROM checkpoint_request WHERE user_id=$1 AND key NOT IN (SELECT key FROM checkpoint_request WHERE user_id=$1 ORDER BY created_at DESC,key DESC LIMIT 50)', [user]);
      await client.query('COMMIT'); return { status: 'saved', record };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
function row(value: Record<string, unknown>): Checkpoint { return { campaign: value.campaign as string, slot: value.slot as string, revision: Number(value.revision), deviceId: value.device_id as string, attempt: value.attempt as SavedAttempt, updatedAt: new Date(value.updated_at as string).toISOString() }; }
