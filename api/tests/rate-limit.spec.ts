import { env } from '../src/config/env';
import { checkRateLimit, resetRateLimitsForTests } from '../src/lib/rateLimit';
import * as redis from '../src/lib/redis';

type RedisEval = (
  lua: string,
  numKeys: number,
  key: string,
  windowMs: string,
  max: string,
) => Promise<readonly [number, number]>;

describe('rate limit', () => {
  const redisState = new Map<string, { count: number; expiresAt: number }>();

  const originalRedisEnabled = env.REDIS_URL;
  const originalDistributed = env.WORKER_DISTRIBUTED;
  const originalWindowMs = env.RATE_LIMIT_WINDOW_MS;
  const originalRateLimitMax = env.RATE_LIMIT_MAX;

  function withEnv<T>(overrides: Partial<typeof env>, fn: () => Promise<T> | T) {
    const snapshot = {
      REDIS_URL: env.REDIS_URL,
      WORKER_DISTRIBUTED: env.WORKER_DISTRIBUTED,
      RATE_LIMIT_WINDOW_MS: env.RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX: env.RATE_LIMIT_MAX,
    };
    Object.assign(env, overrides);
    return Promise.resolve(fn()).finally(() => {
      env.REDIS_URL = snapshot.REDIS_URL;
      env.WORKER_DISTRIBUTED = snapshot.WORKER_DISTRIBUTED;
      env.RATE_LIMIT_WINDOW_MS = snapshot.RATE_LIMIT_WINDOW_MS;
      env.RATE_LIMIT_MAX = snapshot.RATE_LIMIT_MAX;
    });
  }

  beforeEach(async () => {
    await resetRateLimitsForTests();
    redisState.clear();
    jest.clearAllMocks();
  });

  afterAll(() => {
    env.REDIS_URL = originalRedisEnabled;
    env.WORKER_DISTRIBUTED = originalDistributed;
    env.RATE_LIMIT_WINDOW_MS = originalWindowMs;
    env.RATE_LIMIT_MAX = originalRateLimitMax;
  });

  it('falls back to in-memory limit when redis is unavailable', async () => {
    await withEnv(
      {
        REDIS_URL: '',
        WORKER_DISTRIBUTED: true,
        RATE_LIMIT_WINDOW_MS: 60_000,
        RATE_LIMIT_MAX: 1,
      },
      async () => {
        const req = { ip: '127.0.0.1', routeOptions: { url: '/v1/messages/send' }, url: '/v1/messages/send' };
        const first = await checkRateLimit(req as any);
        const second = await checkRateLimit(req as any);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(false);
        expect(second.remaining).toBe(0);
      },
    );
  });

  it('enforces rate cap consistently with redis-backed limits', async () => {
    const evalMock = (async (_lua: string, _numKeys: number, key: string) => {
      const windowMs = 60_000;
      const max = env.RATE_LIMIT_MAX;
      const now = Date.now();
      const row = redisState.get(key);

      if (!row || row.expiresAt <= now) {
        const next = { count: 1, expiresAt: now + windowMs };
        redisState.set(key, next);
        return [1, windowMs];
      }

      if (row.count >= max) {
        const ttl = Math.max(0, row.expiresAt - now);
        return [-1, ttl];
      }

      row.count += 1;
      const ttl = Math.max(0, row.expiresAt - now);
      return [row.count, ttl];
    }) as RedisEval;

    const getRedisClient = jest.spyOn(redis, 'getRedisClient').mockReturnValue({
      eval: evalMock,
    } as any);

    jest.spyOn(redis, 'isRedisEnabled').mockReturnValue(true);

    await withEnv(
      {
        REDIS_URL: 'redis://127.0.0.1:6379',
        WORKER_DISTRIBUTED: true,
        RATE_LIMIT_WINDOW_MS: 60_000,
        RATE_LIMIT_MAX: 2,
      },
      async () => {
        const req = {
          ip: '127.0.0.1',
          routeOptions: { url: '/v1/messages/send' },
          url: '/v1/messages/send',
        };

        const first = await checkRateLimit(req as any);
        const second = await checkRateLimit(req as any);
        const third = await checkRateLimit(req as any);

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(third.ok).toBe(false);
      },
    );

    expect(getRedisClient).toHaveBeenCalledTimes(3);
  });
});
