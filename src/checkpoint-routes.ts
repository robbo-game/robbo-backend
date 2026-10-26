import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SavedAttempt } from '../vendor/robbo/src/application/saved-attempt';
import type { CheckpointStore } from './checkpoint-store.js';
import { validateCheckpointInWorker } from './verifier.js';
const token = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._-]+$' };
const params = { type: 'object', required: ['campaign','slot'], additionalProperties: false, properties: { campaign: token, slot: token } };
export function checkpointRoutes(app: FastifyInstance, store: CheckpointStore, user: (request: FastifyRequest) => Promise<string | undefined>, allow: (user: string) => Promise<boolean>) {
  app.get('/v1/checkpoints/:campaign/:slot', { schema: { params } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const id = await user(request); if (!id) return reply.code(401).send({ error: 'authentication_required' });
    const { campaign,slot } = request.params as { campaign: string; slot: string };
    const record = await store.get(id,campaign,slot);
    if (!record) return reply.code(404).send({ error: 'checkpoint_not_found', revision: 0 });
    return reply.header('etag', `"${record.revision}"`).send(record);
  });
  app.put('/v1/checkpoints/:campaign/:slot', { bodyLimit: 1024*1024, schema: {
    params, headers: { type: 'object', required: ['if-match','idempotency-key'], properties: {
      'if-match': { type: 'string', pattern: '^(0|[1-9][0-9]{0,8}|"(0|[1-9][0-9]{0,8})")$' },
      'idempotency-key': { type: 'string', minLength: 16, maxLength: 128 }
    } }, body: { type: 'object', required: ['deviceId','attempt'], additionalProperties: false, properties: {
      deviceId: { type: 'string', minLength: 1, maxLength: 128 }, attempt: { type: 'object', additionalProperties: true }
    } }
  } }, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const id = await user(request); if (!id) return reply.code(401).send({ error: 'authentication_required' });
    if (!await allow(id)) return reply.code(429).send({ error: 'rate_limited' });
    const { campaign,slot } = request.params as { campaign: string; slot: string };
    const body = request.body as { deviceId: string; attempt: unknown };
    let attempt: SavedAttempt;
    try { attempt = await validateCheckpointInWorker(body.attempt); }
    catch (error) {
      if (error instanceof Error && error.message === 'verification_busy') return reply.code(503).send({ error: 'verification_busy' });
      return reply.code(422).send({ error: 'invalid_or_incompatible_checkpoint' });
    }
    if (attempt.pack !== campaign) return reply.code(422).send({ error: 'campaign_mismatch' });
    const result = await store.save(id,{ campaign,slot,deviceId: body.deviceId,attempt }, Number(String(request.headers['if-match']).replaceAll('"','')), String(request.headers['idempotency-key']));
    if (result.status === 'conflict') return reply.code(412).send({ error: 'revision_conflict', current: result.current });
    if (result.status === 'key_reused') return reply.code(409).send({ error: 'idempotency_key_reused' });
    if (result.status === 'slot_limit') return reply.code(409).send({ error: 'checkpoint_slot_limit' });
    return reply.header('etag', `"${result.record.revision}"`).send(result.record);
  });
}
