import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify, { type FastifyRequest } from 'fastify';
import type { ProgressRecord, ProgressStore } from './types.js';
import type { Auth } from './auth.js';
import type { Leaderboards, Board } from './leaderboard.js';
import type { AuthStore } from './auth.js';

const token = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' };
const record = {
  type: 'object', additionalProperties: false, required: ['schemaVersion', 'gameVersion', 'deviceId', 'payload'],
  properties: { schemaVersion: { type: 'integer', minimum: 1 }, gameVersion: { type: 'string', minLength: 1, maxLength: 128 }, deviceId: { type: 'string', minLength: 1, maxLength: 128 }, payload: { type: 'object', maxProperties: 128, additionalProperties: true } }
} as const;

export function buildApp(store: ProgressStore, allowedOrigins: string[] = [], resolveUser: (request: FastifyRequest) => Promise<string | undefined> = async () => undefined, services?: { auth: Auth; leaderboards: Leaderboards; limits: AuthStore; boards: Board[] }) {
  const app = Fastify({ logger: { redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'], serializers: { req: (request) => ({ method: request.method, url: request.url?.split('?')[0] }) } }, bodyLimit: 256 * 1024 });
  app.register(cookie);
  app.register(cors, { origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)), credentials: true });
  if (services) {
    resolveUser = async request => (await services.auth.identity(request))?.id;
    services.auth.register(app);
    app.addHook('onRequest', async (request, reply) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && (!request.headers.origin || !allowedOrigins.includes(request.headers.origin))) return reply.code(403).send({ error: 'origin_not_allowed' });
    });
    app.addHook('onSend', async (request, reply) => { if (!request.url.startsWith('/v1/leaderboards')) reply.header('cache-control', 'no-store'); });
  }
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/v1/me', async request => { const user = services ? await services.auth.identity(request) : undefined; return { user: user ?? null, mode: user ? 'account' : 'guest' }; });
  app.post('/v1/auth/logout', async (request, reply) => { await services?.auth.logout(request); reply.clearCookie('robbo_session', { path: '/' }); return reply.code(204).send(); });
  app.get('/v1/progress', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { since: { type: 'string', format: 'date-time' } } } } }, async (request, reply) => {
    const userId = await resolveUser(request); if (!userId) return reply.code(401).send({ error: 'authentication_required' });
    const { since } = request.query as { since?: string }; const records = await store.list(userId, since); return { records, cursor: records.at(-1)?.updatedAt ?? since ?? null };
  });
  app.put('/v1/progress/:campaign/:slot', { schema: { params: { type: 'object', additionalProperties: false, required: ['campaign', 'slot'], properties: { campaign: token, slot: token } }, headers: { type: 'object', required: ['if-match', 'idempotency-key'], properties: { 'if-match': { type: 'string', pattern: '^\\d+$' }, 'idempotency-key': { type: 'string', minLength: 16, maxLength: 128 } } }, body: record } }, async (request, reply) => {
    const userId = await resolveUser(request); if (!userId) return reply.code(401).send({ error: 'authentication_required' });
    const { campaign, slot } = request.params as { campaign: string; slot: string }; const headers = request.headers as Record<string, string>;
    const replayed = await store.getIdempotent(userId, headers['idempotency-key']); if (replayed) return reply.header('etag', String(replayed.revision)).send(replayed);
    const body = request.body as Omit<ProgressRecord, 'campaign' | 'slot' | 'revision' | 'updatedAt'>;
    const saved = await store.put(userId, { ...body, campaign, slot }, Number(headers['if-match']));
    if (saved === 'conflict') { const current = await store.get(userId, campaign, slot); return reply.code(412).send({ error: 'revision_conflict', current: current ?? null }); }
    await store.saveIdempotent(userId, headers['idempotency-key'], saved); return reply.code(200).header('etag', String(saved.revision)).send(saved);
  });
  app.get('/v1/leaderboards', async () => ({ boards: services?.boards ?? [], ordering: ['elapsedMs:asc', 'deaths:asc', 'userId:asc'], tickMs: 100 }));
  app.get('/v1/leaderboards/:campaign/:planet', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['campaign', 'planet'], properties: { campaign: token, planet: { type: 'integer', minimum: 1, maximum: 9999 } } },
    querystring: { type: 'object', additionalProperties: false, required: ['engine', 'campaignHash'], properties: { engine: token, campaignHash: { type: 'string', pattern: '^[a-f0-9]{8}$' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 }, offset: { type: 'integer', minimum: 0, maximum: 10000, default: 0 } } }
  } }, async (request, reply) => {
    const { campaign, planet } = request.params as { campaign: string; planet: number };
    const query = request.query as { engine: string; campaignHash: string; limit: number; offset: number };
    const board = services?.boards.find(b => b.campaign === campaign && b.planet === planet && b.engine === query.engine && b.campaignHash === query.campaignHash);
    if (!board) return reply.code(404).send({ error: 'unsupported_board' });
    return { board, entries: await services!.leaderboards.list(board, query.limit, query.offset), limit: query.limit, offset: query.offset, cacheMaxAgeSeconds: 15 };
  });
  app.post('/v1/leaderboard/submissions', { bodyLimit: 8 * 1024 * 1024, schema: { body: { type: 'object', additionalProperties: false, required: ['replay'], properties: { replay: { type: 'object', additionalProperties: true } } } } }, async (request, reply) => {
    const userId = await resolveUser(request); if (!userId || !services) return reply.code(401).send({ error: 'authentication_required' });
    if (!await services.limits.allow(`submit:${userId}`, 10, 60)) return reply.code(429).send({ error: 'rate_limited' });
    const submission = await services.leaderboards.submit(userId, (request.body as { replay: unknown }).replay);
    return reply.code(202).send(submission);
  });
  app.get('/v1/leaderboard/submissions/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } } }, async (request, reply) => {
    const userId = await resolveUser(request); if (!userId || !services) return reply.code(401).send({ error: 'authentication_required' });
    const submission = await services.leaderboards.submission(userId, (request.params as { id: string }).id);
    return submission ?? reply.code(404).send({ error: 'submission_not_found' });
  });
  app.setErrorHandler((error: { statusCode?: number }, _request, reply) => reply.code(error.statusCode && error.statusCode < 500 ? error.statusCode : 500).send({ error: error.statusCode === 400 ? 'invalid_request' : 'internal_error' }));
  return app;
}
