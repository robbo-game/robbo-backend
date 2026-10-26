import { Pool } from 'pg';
import { createClient } from 'redis';
import { buildApp } from './app.js';
import { PostgresProgressStore } from './store.js';
import { createAuth, PostgresAccounts } from './auth.js';
import { RedisAuthStore } from './redis-store.js';
import { PostgresLeaderboards } from './leaderboard.js';
import { packs } from '../vendor/robbo/src/generated/packs';
import { digest, REPLAY_ENGINE } from '../vendor/robbo/src/application/replay';

const databaseUrl = required('DATABASE_URL');
const redisUrl = required('REDIS_URL');
const pool = new Pool({ connectionString: databaseUrl });
const redis = createClient({ url: redisUrl });
await redis.connect();
await pool.query('SELECT 1');
const publicUrl = required('PUBLIC_URL'), frontendUrl = required('FRONTEND_URL');
const limits = new RedisAuthStore(redis);
const auth = createAuth(limits, new PostgresAccounts(pool), { clientId: process.env.GITHUB_CLIENT_ID ?? '', clientSecret: process.env.GITHUB_CLIENT_SECRET ?? '', publicUrl, frontendUrl, secure: new URL(publicUrl).protocol === 'https:' });
const origins = [...new Set([new URL(publicUrl).origin, new URL(frontendUrl).origin, ...(process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)])];
const boards = packs.flatMap(pack => pack.levels.map(level => ({ campaign: pack.id, planet: level.number, engine: REPLAY_ENGINE, campaignHash: digest(pack) })));
const app = buildApp(new PostgresProgressStore(pool), origins, undefined, { auth, limits, leaderboards: new PostgresLeaderboards(pool, redis), boards });
app.addHook('onClose', async () => { await redis.close(); await pool.end(); });
await app.listen({ port: Number(process.env.PORT ?? 3000), host: process.env.HOST ?? '127.0.0.1' });
function required(name: string): string { const value = process.env[name]; if (!value) throw new Error(`${name} must be set`); return value; }
