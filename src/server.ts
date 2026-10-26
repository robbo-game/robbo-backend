import { Pool } from 'pg';
import { createClient } from 'redis';
import { buildApp } from './app.js';
import { PostgresProgressStore } from './store.js';

const databaseUrl = required('DATABASE_URL');
const redisUrl = required('REDIS_URL');
const pool = new Pool({ connectionString: databaseUrl });
const redis = createClient({ url: redisUrl });
await redis.connect();
await pool.query('SELECT 1');
const app = buildApp(new PostgresProgressStore(pool), (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean));
app.addHook('onClose', async () => { await redis.close(); await pool.end(); });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} must be set`); return value; }
