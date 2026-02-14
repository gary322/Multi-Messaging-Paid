import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { env } from '../config/env';

let client: Redis | null = null;
const REDIS_CLOSE_TIMEOUT_MS = 2_000;

function createRedisClient() {
  if (!env.REDIS_URL) {
    return null;
  }

  return new Redis(env.REDIS_URL, {
    connectTimeout: env.REDIS_CONNECT_TIMEOUT_MS,
    lazyConnect: false,
  });
}

export function getRedisClient(): Redis | null {
  if (client) return client;
  client = createRedisClient();
  return client;
}

export async function closeRedisClient() {
  if (!client) return;
  const c = client;
  client = null;
  await new Promise<void>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      c.disconnect(true);
      resolve();
    }, REDIS_CLOSE_TIMEOUT_MS);

    c.quit()
      .then(() => resolve())
      .catch(() => c.disconnect(true))
      .finally(() => clearTimeout(timeoutHandle))
      .catch(() => {});
  });
  if (c.status !== 'end' && c.status !== 'wait') {
    c.disconnect(true);
  }
}

export function isRedisEnabled() {
  return Boolean(env.REDIS_URL);
}

export function assertRedisForDistributedWorkersOrThrow(context = 'distributed worker') {
  if (env.WORKER_DISTRIBUTED && !env.REDIS_URL) {
    throw new Error(`distributed worker mode requires REDIS_URL for ${context}`);
  }
}

export async function tryAcquireDistributedLock(lockKey: string, ttlMs: number) {
  const redis = getRedisClient();
  if (!redis) return null;
  const token = randomUUID();
  const response = await redis.set(lockKey, token, 'PX', ttlMs, 'NX');
  if (response !== 'OK') return null;
  return token;
}

export async function releaseDistributedLock(lockKey: string, token: string | null) {
  const redis = getRedisClient();
  if (!redis || !token) return false;
  const lua = `
    if redis.call('get', KEYS[1]) == ARGV[1] then
      return redis.call('del', KEYS[1])
    end
    return 0
  `;
  return Number(await redis.eval(lua, 1, lockKey, token)) > 0;
}

export function distributedLockTokenPrefix(prefix: string) {
  return `${prefix}:${Date.now()}-${randomUUID()}`;
}
