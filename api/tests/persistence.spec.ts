import { createUser, resetStore } from '../src/lib/db';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('persistence strict mode', () => {
  beforeEach(async () => {
    await resetStore();
  });

  it('rejects sqlite backend when strict mode is enabled', async () => {
    await withEnv(
      {
        PERSISTENCE_STRICT_MODE: true,
        DATABASE_BACKEND: 'sqlite',
        DATABASE_URL: '',
        WORKER_DISTRIBUTED: false,
        REDIS_URL: '',
      },
      async () => {
        await expect(createUser('0x1111111111111111111111111111111111111111')).rejects.toMatchObject({
          message: expect.stringContaining('persistence strict mode violation'),
        });
      },
    );
  });

  it('requires redis when strict mode enables distributed workers', async () => {
    await withEnv(
      {
        PERSISTENCE_STRICT_MODE: true,
        DATABASE_BACKEND: 'postgres',
        DATABASE_URL: 'postgresql://mmp:mmp@127.0.0.1:5432/mmp',
        WORKER_DISTRIBUTED: true,
        REDIS_URL: '',
      },
      async () => {
        await expect(createUser('0x2222222222222222222222222222222222222222')).rejects.toMatchObject({
          message: expect.stringContaining('REDIS_URL is required'),
        });
      },
    );
  });

  it('allows sqlite backend when strict mode is disabled', async () => {
    await withEnv(
      {
        PERSISTENCE_STRICT_MODE: false,
        DATABASE_BACKEND: 'sqlite',
        DATABASE_URL: '',
      },
      async () => {
        const user = await createUser('0x3333333333333333333333333333333333333333');
        expect(user).toBeTruthy();
        expect(user.wallet_address).toBe('0x3333333333333333333333333333333333333333');
      },
    );
  });
});
