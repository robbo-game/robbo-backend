import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import type { ProgressRecord, ProgressStore } from './types.js';

const userId = '00000000-0000-4000-8000-000000000001'; // Replaced by authenticated session once OAuth is configured.
const token = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' };
const record = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'gameVersion', 'deviceId', 'payload'],
  properties: { schemaVersion: { type: 'integer', minimum: 1 }, gameVersion: { type: 'string', minLength: 1, maxLength: 128 }, deviceId: { type: 'string', minLength: 1, maxLength: 128 }, payload: { type: 'object', maxProperties: 128, additionalProperties: true } }
} as const;

export function buildApp(store: ProgressStore, allowedOrigins: string[] = []) {
  const app = Fastify({ logger: true, bodyLimit: 256 * 1024 });
  app.register(cookie);
  app.register(cors, { origin: (origin, callback) => callback(null, !origin || allowedOrigins.length === 0 ? true : allowedOrigins.includes(origin)), credentials: true });
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/v1/me', async () => ({ user: null, mode: 'guest' }));
  app.post('/v1/auth/logout', async (_request, reply) => { reply.clearCookie('robbo_session', { path: '/' }); return reply.code(204).send(); });
  app.get('/v1/progress', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', format: 'date-time' } } } } }, async (request) => {
    const { since } = request.query as { since?: string }; const records = await store.list(userId, since); return { records, cursor: records.at(-1)?.updatedAt ?? since ?? null };
  });
  app.put('/v1/progress/:campaign/:slot', { schema: { params: { type: 'object', additionalProperties: false, required: ['campaign', 'slot'], properties: { campaign: token, slot: token } }, headers: { type: 'object', required: ['if-match', 'idempotency-key'], properties: { 'if-match': { type: 'string', pattern: '^\\d+$' }, 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128 } } }, body: record } }, async (request, reply) => {
    const { campaign, slot } = request.params as { campaign: string; slot: string }; const headers = request.headers as Record<string, string>;
    const replayed = await store.getIdempotent(userId, headers['idempotency-key']); if (replayed) return reply.header('etag', String(replayed.revision)).send(replayed);
    const body = request.body as Omit<ProgressRecord, 'campaign' | 'slot' | 'revision' | 'updatedAt'>;
    const saved = await store.put(userId, { ...body, campaign, slot }, Number(headers['if-match']));
    if (saved === 'conflict') { const current = await store.get(userId, campaign, slot); return reply.code(412).send({ error: 'revision_conflict', current: current ?? null }); }
    await store.saveIdempotent(userId, headers['idempotency-key'], saved); return reply.code(200).header('etag', String(saved.revision)).send(saved);
  });
  app.get('/v1/leaderboards/:campaign/:planet', { schema: { params: { type: 'object', additionalProperties: false, required: ['campaign', 'planet'], properties: { campaign: token, planet: { type: 'integer', minimum: 1, maximum: 9999 } } } } }, async () => ({ entries: [] }));
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({ error: error.statusCode === 400 ? 'invalid_request' : 'internal_error' }));
  return app;
}
