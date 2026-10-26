import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuth, type AuthStore, type Accounts, type Identity } from './auth.js';
import { buildApp } from './app.js';
import { MemoryProgressStore } from './store.js';
import type { Leaderboards } from './leaderboard.js';
class MemoryAuthStore implements AuthStore {
  values = new Map<string, string>();
  async put(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async take(key: string): Promise<string | null> { const value = await this.get(key); this.values.delete(key); return value; }
  async remove(key: string): Promise<void> { this.values.delete(key); }
  async allow(): Promise<boolean> { return true; }
}
test('GitHub flow binds one-time state, uses PKCE, rotates sessions, exposes no provider token', async () => {
  const limits = new MemoryAuthStore(); const user: Identity = { id: '00000000-0000-4000-8000-000000000001', displayName: 'player' };
  const accounts: Accounts = { github: async (id, login) => { assert.equal(id, '42'); assert.equal(login, 'player'); return user; }, find: async id => id === user.id ? user : undefined };
  let exchanges = 0;
  const request: typeof fetch = async (url, options) => {
    if (String(url).includes('access_token')) { exchanges++; assert.ok(String(options?.body).includes('code_verifier=')); return Response.json({ access_token: 'test-provider-value' }); }
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-provider-value'); return Response.json({ id: 42, login: 'player' });
  };
  const auth = createAuth(limits, accounts, { clientId: 'test-id', clientSecret: 'test-value', publicUrl: 'http://127.0.0.1:3000', frontendUrl: 'http://127.0.0.1:8080/', secure: false }, request);
  const leaderboards: Leaderboards = { submit: async () => ({ id: '00000000-0000-4000-8000-000000000002', status: 'queued' }), submission: async () => undefined, list: async () => [{ rank: 1, userId: user.id, displayName: user.displayName, elapsedMs: 1200, deaths: 2 }] };
  const app = buildApp(new MemoryProgressStore(), ['http://127.0.0.1:8080'], undefined, { auth, limits, leaderboards, boards: [{ campaign: '01', planet: 1, engine: 'robbo-java-3', campaignHash: '12345678' }] });
  const start = await app.inject('/auth/github'); assert.equal(start.statusCode, 302);
  const location = new URL(start.headers.location!); assert.equal(location.searchParams.get('code_challenge_method'), 'S256'); assert.equal(location.searchParams.get('scope'), 'read:user');
  const state = location.searchParams.get('state')!;
  assert.equal((await app.inject(`/auth/github/callback?code=test&state=${state}`)).statusCode, 400);
  assert.equal(exchanges, 0);
  const callback = await app.inject({ url: `/auth/github/callback?code=test&state=${state}`, cookies: { robbo_oauth: state } });
  assert.equal(callback.statusCode, 302); assert.equal(callback.headers.location, 'http://127.0.0.1:8080/');
  const session = callback.cookies.find(c => c.name === 'robbo_session')!; assert.ok(session.httpOnly);
  assert.equal(JSON.stringify([...limits.values]).includes('test-provider-value'), false);
  assert.equal((await app.inject({ url: `/auth/github/callback?code=test&state=${state}`, cookies: { robbo_oauth: state } })).statusCode, 400); assert.equal(exchanges, 1);
  const cookies = { robbo_session: session.value };
  const me = await app.inject({ url: '/v1/me', cookies }); assert.deepEqual(me.json(), { user, mode: 'account' });
  const payload = { replay: {} };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/leaderboard/submissions', cookies, payload })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/leaderboard/submissions', headers: { origin: 'http://127.0.0.1:8080' }, payload })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/leaderboard/submissions', cookies, headers: { origin: 'http://127.0.0.1:8080' }, payload })).statusCode, 202);
  const board = await app.inject('/v1/leaderboards/01/1?engine=robbo-java-3&campaignHash=12345678'); assert.equal(board.json().entries[0].deaths, 2);
  assert.equal((await app.inject('/v1/leaderboards/01/1?engine=old&campaignHash=12345678')).statusCode, 404);
  await app.inject({ method: 'POST', url: '/v1/auth/logout', cookies, headers: { origin: 'http://127.0.0.1:8080' } });
  assert.equal((await app.inject({ url: '/v1/me', cookies })).json().mode, 'guest');
  await app.close();
});
