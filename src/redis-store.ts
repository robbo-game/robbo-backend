import type { createClient } from 'redis';
import type { AuthStore } from './auth.js';
export type Redis = ReturnType<typeof createClient>;
export class RedisAuthStore implements AuthStore {
  constructor(private readonly redis: Redis) {}
  async put(key: string, value: string, ttl: number): Promise<void> { await this.redis.set(key, value, { EX: ttl }); }
  get(key: string): Promise<string | null> { return this.redis.get(key); }
  take(key: string): Promise<string | null> { return this.redis.getDel(key); }
  async remove(key: string): Promise<void> { await this.redis.del(key); }
  async allow(key: string, limit: number, seconds: number): Promise<boolean> {
    const count = await this.redis.eval(`local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`, { keys: [`limit:${key}`], arguments: [String(seconds)] });
    return Number(count) <= limit;
  }
}
