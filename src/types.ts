export interface ProgressRecord {
  campaign: string;
  slot: string;
  revision: number;
  schemaVersion: number;
  gameVersion: string;
  deviceId: string;
  payload: Record<string, unknown>;
  updatedAt: string;
}

export interface ProgressStore {
  list(userId: string, since?: string): Promise<ProgressRecord[]>;
  get(userId: string, campaign: string, slot: string): Promise<ProgressRecord | undefined>;
  put(userId: string, record: Omit<ProgressRecord, 'revision' | 'updatedAt'>, expectedRevision: number): Promise<ProgressRecord | 'conflict'>;
  getIdempotent(userId: string, key: string): Promise<ProgressRecord | undefined>;
  saveIdempotent(userId: string, key: string, record: ProgressRecord): Promise<void>;
}
