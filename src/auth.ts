import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

export interface Identity { id: string; displayName: string }
export interface AuthStore {
  put(key: string, value: string, ttl: number): Promise<void>;
  get(key: string): Promise<string | null>;
  take(key: string): Promise<string | null>;
  remove(key: string): Promise<void>;
  allow(key: string, limit: number, seconds: number): Promise<boolean>;
}
export interface Accounts {
  github(id: string, login: string): Promise<Identity>;
  find(id: string): Promise<Identity | undefined>;
}
export class PostgresAccounts implements Accounts {
  constructor(private readonly pool: Pool) {}
  async github(id: string, login: string): Promise<Identity> {
    const result = await this.pool.query(`INSERT INTO app_user(id, display_name, github_id) VALUES(gen_random_uuid(), $2, $1)
      ON CONFLICT (github_id) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id, display_name`, [id, login]);
    return { id: result.rows[0].id, displayName: result.rows[0].display_name };
  }
  async find(id: string): Promise<Identity | undefined> {
    const result = await this.pool.query('SELECT id, display_name FROM app_user WHERE id=$1', [id]);
    return result.rows[0] && { id: result.rows[0].id, displayName: result.rows[0].display_name };
  }
}
export interface AuthConfig { clientId: string; clientSecret: string; publicUrl: string; frontendUrl: string; secure: boolean }
export const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
const random = (): string => randomBytes(32).toString('base64url');
const sessionKey = (value: string): string => `session:${hash(value)}`;
export function createAuth(store: AuthStore, accounts: Accounts, config: AuthConfig, request: typeof fetch = fetch) {
  const publicUrl = new URL(config.publicUrl);
  const frontend = new URL(config.frontendUrl);
  if ((!config.secure && !['localhost', '127.0.0.1'].includes(publicUrl.hostname)) ||
      (config.secure && (publicUrl.protocol !== 'https:' || frontend.protocol !== 'https:'))) throw Error('OAuth requires HTTPS outside local development');
  const callback = new URL('/auth/github/callback', publicUrl).href;
  const sessionCookie = { path: '/', httpOnly: true, secure: config.secure, sameSite: config.secure ? 'none' as const : 'lax' as const };
  async function identity(req: FastifyRequest): Promise<Identity | undefined> {
    const cookie = req.cookies.robbo_session;
    if (!cookie || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return undefined;
    const id = await store.get(sessionKey(cookie)); return id ? accounts.find(id) : undefined;
  }
  async function logout(req: FastifyRequest): Promise<void> {
    if (req.cookies.robbo_session) await store.remove(sessionKey(req.cookies.robbo_session));
  }
  function register(app: FastifyInstance): void {
    app.get('/auth/github', async (req, reply) => {
      if (!config.clientId || !config.clientSecret) return reply.code(503).send({ error: 'github_login_not_configured' });
      if (!await store.allow(`oauth:start:${hash(req.ip)}`, 20, 60)) return reply.code(429).send({ error: 'rate_limited' });
      const state = random(), verifier = random();
      await store.put(`oauth:${hash(state)}`, verifier, 600);
      reply.setCookie('robbo_oauth', state, { path: '/auth/github', httpOnly: true, secure: config.secure, sameSite: 'lax', maxAge: 600 });
      const url = new URL('https://github.com/login/oauth/authorize');
      url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: callback, scope: 'read:user', state,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
      return reply.header('cache-control', 'no-store').redirect(url.href);
    });
    app.get('/auth/github/callback', { schema: { querystring: { type: 'object', properties: { code: { type: 'string', maxLength: 1024 }, state: { type: 'string', maxLength: 128 }, error: { type: 'string', maxLength: 128 } } } } }, async (req, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      const { state, code, error } = req.query as { state?: string; code?: string; error?: string };
      reply.clearCookie('robbo_oauth', { path: '/auth/github', secure: config.secure, sameSite: 'lax' });
      if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || state !== req.cookies.robbo_oauth) return reply.code(400).send({ error: 'invalid_oauth_state' });
      const verifier = await store.take(`oauth:${hash(state)}`);
      if (!verifier || error || !code) return reply.code(400).send({ error: 'github_login_cancelled_or_expired' });
      if (!await store.allow(`oauth:callback:${hash(req.ip)}`, 20, 60)) return reply.code(429).send({ error: 'rate_limited' });
      try {
        const exchange = await request('https://github.com/login/oauth/access_token', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: callback, code_verifier: verifier }), signal: AbortSignal.timeout(10000) });
        const token = await exchange.json() as { access_token?: string; error?: string };
        if (!exchange.ok || token.error || typeof token.access_token !== 'string') throw Error('OAuth exchange failed');
        const response = await request('https://api.github.com/user', { headers: { authorization: `Bearer ${token.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'robbo-backend', 'x-github-api-version': '2022-11-28' }, signal: AbortSignal.timeout(10000) });
        const profile = await response.json() as { id?: number; login?: string };
        if (!response.ok || !Number.isSafeInteger(profile.id) || !profile.login || !/^[a-zA-Z0-9-]{1,39}$/.test(profile.login)) throw Error('GitHub identity unavailable');
        const user = await accounts.github(String(profile.id), profile.login);
        await logout(req);
        const session = random(); await store.put(sessionKey(session), user.id, 7 * 86400);
        reply.setCookie('robbo_session', session, { ...sessionCookie, maxAge: 7 * 86400 });
        return reply.redirect(frontend.href);
      } catch { return reply.code(502).send({ error: 'github_login_failed' }); }
    });
  }
  return { identity, logout, register };
}
export type Auth = ReturnType<typeof createAuth>;
