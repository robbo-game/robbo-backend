import type { Pool } from 'pg';
import type { ProgressRecord, ProgressStore } from './types.js';

export class MemoryProgressStore implements ProgressStore {
  #records = new Map<string, ProgressRecord>();
  #keys = new Map<string, ProgressRecord>();
  #key(user: string, campaign: string, slot: string): string { return `${user}:${campaign}:${slot}`; }
  async list(userId: string, since?: string): Promise<ProgressRecord[]> {
    return [...this.#records.entries()].filter(([key, value]) => key.startsWith(`${userId}:`) && (!since || value.updatedAt > since)).map(([, value]) => value);
  }
  async get(userId: string, campaign: string, slot: string): Promise<ProgressRecord | undefined> { return this.#records.get(this.#key(userId, campaign, slot)); }
  async put(userId: string, draft: Omit<ProgressRecord, 'revision' | 'updatedAt'>, expectedRevision: number): Promise<ProgressRecord | 'conflict'> {
    const key = this.#key(userId, draft.campaign, draft.slot); const existing = this.#records.get(key);
    if ((existing?.revision ?? 0) !== expectedRevision) return 'conflict';
    const record = { ...draft, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
    this.#records.set(key, record); return record;
  }
  async getIdempotent(userId: string, key: string): Promise<ProgressRecord | undefined> { return this.#keys.get(`${userId}:${key}`); }
  async saveIdempotent(userId: string, key: string, record: ProgressRecord): Promise<void> { this.#keys.set(`${userId}:${key}`, record); }
}

export class PostgresProgressStore implements ProgressStore {
  constructor(private readonly pool: Pool) {}
  async list(userId: string, since?: string): Promise<ProgressRecord[]> {
    const result = await this.pool.query('SELECT campaign, slot, revision, schema_version, game_version, device_id, payload, updated_at FROM progress_record WHERE user_id = $1 AND ($2::timestamptz IS NULL OR updated_at > $2) ORDER BY updated_at', [userId, since ?? null]);
    return result.rows.map(row);
  }
  async get(userId: string, campaign: string, slot: string): Promise<ProgressRecord | undefined> {
    const result = await this.pool.query('SELECT campaign, slot, revision, schema_version, game_version, device_id, payload, updated_at FROM progress_record WHERE user_id = $1 AND campaign = $2 AND slot = $3', [userId, campaign, slot]); return result.rowCount ? row(result.rows[0]) : undefined;
  }
  async put(userId: string, draft: Omit<ProgressRecord, 'revision' | 'updatedAt'>, expectedRevision: number): Promise<ProgressRecord | 'conflict'> {
    const result = await this.pool.query(`INSERT INTO progress_record (user_id, campaign, slot, revision, schema_version, game_version, device_id, payload) VALUES ($1,$2,$3,1,$4,$5,$6,$7)
      ON CONFLICT (user_id,campaign,slot) DO UPDATE SET revision = progress_record.revision + 1, schema_version = EXCLUDED.schema_version, game_version = EXCLUDED.game_version, device_id = EXCLUDED.device_id, payload = EXCLUDED.payload, updated_at = now()
      WHERE progress_record.revision = $8 RETURNING campaign,slot,revision,schema_version,game_version,device_id,payload,updated_at`, [userId, draft.campaign, draft.slot, draft.schemaVersion, draft.gameVersion, draft.deviceId, draft.payload, expectedRevision]);
    return result.rowCount ? row(result.rows[0]) : 'conflict';
  }
  async getIdempotent(userId: string, key: string): Promise<ProgressRecord | undefined> { const result = await this.pool.query('SELECT response FROM idempotency_key WHERE user_id = $1 AND key = $2', [userId, key]); return result.rowCount ? result.rows[0].response : undefined; }
  async saveIdempotent(userId: string, key: string, record: ProgressRecord): Promise<void> { await this.pool.query('INSERT INTO idempotency_key (user_id,key,response) VALUES ($1,$2,$3) ON CONFLICT (user_id,key) DO NOTHING', [userId, key, record]); }
}
function row(value: Record<string, unknown>): ProgressRecord { return { campaign: value.campaign as string, slot: value.slot as string, revision: Number(value.revision), schemaVersion: Number(value.schema_version), gameVersion: value.game_version as string, deviceId: value.device_id as string, payload: value.payload as Record<string, unknown>, updatedAt: new Date(value.updated_at as string).toISOString() }; }
