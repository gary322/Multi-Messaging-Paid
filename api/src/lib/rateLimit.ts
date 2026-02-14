import { FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { getRedisClient, isRedisEnabled } from './redis';

const RATE_LIMIT_KEY_PREFIX = 'mmp:rl';
const buckets = new Map<string, { count: number; resetAt: number }>();

type BucketResult = {
  ok: boolean;
  remaining: number;
  error?: string;
};

function makeRateLimitKey(req: FastifyRequest) {
  const route = req.routeOptions?.url || req.url || 'unknown-route';
  const ip = req.ip || 'unknown';
  return `${ip}:${route}`;
}

async function checkRateLimitWithRedis(req: FastifyRequest, windowMs: number, max: number): Promise<BucketResult> {
  const redis = getRedisClient();
  if (!redis) {
    throw new Error('redis_unavailable');
  }

  const key = `${RATE_LIMIT_KEY_PREFIX}:${makeRateLimitKey(req)}`;
  const lua = `
    local key = KEYS[1]
    local windowMs = tonumber(ARGV[1])
    local max = tonumber(ARGV[2])

    local value = redis.call('GET', key)
    if not value then
      redis.call('SET', key, '1', 'PX', windowMs)
      return {1, windowMs}
    end

    local count = tonumber(value)
    if count >= max then
      local ttl = redis.call('PTTL', key)
      if ttl < 0 then
        redis.call('SET', key, '1', 'PX', windowMs)
        return {1, windowMs}
      end
      return {-1, ttl}
    end

    local nextCount = redis.call('INCR', key)
    local ttl = redis.call('PTTL', key)
    if ttl < 0 then
      redis.call('PEXPIRE', key, windowMs)
      ttl = windowMs
    end
    return {nextCount, ttl}
  `;

  const [rawCount, rawTtl] = (await redis.eval(lua, 1, key, String(windowMs), String(max))) as [
    number | string,
    number | string,
  ];
  const count = Number(rawCount);
  const ttlMs = Number(rawTtl);

  if (count < 0 || !Number.isFinite(count) || ttlMs <= 0) {
    return { ok: false, remaining: 0 };
  }

  return {
    ok: count <= max,
    remaining: Math.max(0, max - count),
  };
}

function checkRateLimitInMemory(req: FastifyRequest, windowMs: number, max: number): BucketResult {
  const key = makeRateLimitKey(req);
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: max - 1 };
  }

  if (bucket.count >= max) {
    return { ok: false, remaining: 0 };
  }

  bucket.count += 1;
  return { ok: true, remaining: max - bucket.count };
}

export async function resetRateLimitsForTests() {
  buckets.clear();
  const redis = getRedisClient();
  if (!redis) {
    return;
  }
  try {
    const keys = await redis.keys(`${RATE_LIMIT_KEY_PREFIX}:*`);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // ignore reset failures during tests
  }
}

export async function checkRateLimit(req: FastifyRequest) {
  const windowMs = env.RATE_LIMIT_WINDOW_MS;
  const max = env.RATE_LIMIT_MAX;
  const strict = env.PERSISTENCE_STRICT_MODE || env.NODE_ENV === 'production';

  if (isRedisEnabled() && env.WORKER_DISTRIBUTED) {
    try {
      return await checkRateLimitWithRedis(req, windowMs, max);
    } catch (_error) {
      if (strict) {
        return { ok: false, remaining: 0, error: 'rate_limit_backend_unavailable' };
      }
      // Fall back to in-memory behavior if Redis is unavailable so tests can still run.
      return checkRateLimitInMemory(req, windowMs, max);
    }
  }

  return checkRateLimitInMemory(req, windowMs, max);
}
