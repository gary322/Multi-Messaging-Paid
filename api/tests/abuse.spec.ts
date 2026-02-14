import request from 'supertest';
import { createServer } from '../src/index';
import { env } from '../src/config/env';
import { resetStore } from '../src/lib/db';
import { closeRedisClient } from '../src/lib/redis';

function withEnv<T>(overrides: Partial<typeof env>, fn: () => Promise<T> | T) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('abuse controls', () => {
  beforeEach(async () => {
    await resetStore();
  });

  afterEach(async () => {
    if (env.WORKER_DISTRIBUTED && env.REDIS_URL) {
      await closeRedisClient();
    }
  });

  it('blocks message send after abuse thresholds exceeded', async () => {
    await withEnv(
      {
        ABUSE_CONTROL_ENABLED: true,
        ABUSE_WINDOW_MS: 1_000,
        ABUSE_BLOCK_DURATION_MS: 5_000,
        ABUSE_SCORE_LIMIT: 10,
        ABUSE_SENDER_SCORE_WEIGHT: 10,
        ABUSE_SENDER_MAX_PER_WINDOW: 1,
        // Keep other dimensions effectively disabled for this test.
        ABUSE_RECIPIENT_SCORE_WEIGHT: 0,
        ABUSE_IP_SCORE_WEIGHT: 0,
        ABUSE_DEVICE_SCORE_WEIGHT: 0,
        ABUSE_DEVICE_MISSING_UA_PENALTY: 0,
      },
      async () => {
        const app = await createServer();
        const alice = await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xaaabbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          handle: 'abuse-alice',
        });
        await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xbbbaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          handle: 'abuse-bob',
        });

        await request(app.server)
          .post('/v1/payments/topup')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({ userId: alice.body.user.id, amount: 10000 });

        const first = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob',
            plaintext: 'first',
          });
        expect(first.status).toBe(200);

        const second = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob',
            plaintext: 'second',
          });
        expect(second.status).toBe(429);
        expect(second.body.error).toBe('abuse_blocked');
        expect(typeof second.body.blockedUntil).toBe('number');
        expect(typeof second.body.retryAfterMs).toBe('number');

        await app.close();
      },
    );
  });

  it('unblocks after block duration and a new scoring window', async () => {
    await withEnv(
      {
        ABUSE_CONTROL_ENABLED: true,
        ABUSE_WINDOW_MS: 1_000,
        ABUSE_BLOCK_DURATION_MS: 5_000,
        ABUSE_SCORE_LIMIT: 10,
        ABUSE_SENDER_SCORE_WEIGHT: 10,
        ABUSE_SENDER_MAX_PER_WINDOW: 1,
        ABUSE_RECIPIENT_SCORE_WEIGHT: 0,
        ABUSE_IP_SCORE_WEIGHT: 0,
        ABUSE_DEVICE_SCORE_WEIGHT: 0,
        ABUSE_DEVICE_MISSING_UA_PENALTY: 0,
      },
      async () => {
        const baseNow = 1_700_000_000_000;
        const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseNow);
        const app = await createServer();

        const alice = await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xaaa0000000000000000000000000000000000001',
          handle: 'abuse-alice-2',
        });
        await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xbbb0000000000000000000000000000000000002',
          handle: 'abuse-bob-2',
        });

        await request(app.server)
          .post('/v1/payments/topup')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({ userId: alice.body.user.id, amount: 10000 });

        const first = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob-2',
            plaintext: 'first',
          });
        expect(first.status).toBe(200);

        const blocked = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob-2',
            plaintext: 'second',
          });
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toBe('abuse_blocked');

        // Move past the block and into a new window.
        nowSpy.mockReturnValue(baseNow + 6_000);

        const after = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob-2',
            plaintext: 'third',
          });
        expect(after.status).toBe(200);

        nowSpy.mockRestore();
        await app.close();
      },
    );
  });

  it('returns idempotent responses even if new sends are blocked', async () => {
    await withEnv(
      {
        ABUSE_CONTROL_ENABLED: true,
        ABUSE_WINDOW_MS: 1_000,
        ABUSE_BLOCK_DURATION_MS: 5_000,
        ABUSE_SCORE_LIMIT: 10,
        ABUSE_SENDER_SCORE_WEIGHT: 10,
        ABUSE_SENDER_MAX_PER_WINDOW: 1,
        ABUSE_RECIPIENT_SCORE_WEIGHT: 0,
        ABUSE_IP_SCORE_WEIGHT: 0,
        ABUSE_DEVICE_SCORE_WEIGHT: 0,
        ABUSE_DEVICE_MISSING_UA_PENALTY: 0,
      },
      async () => {
        const app = await createServer();
        const alice = await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xaaa0000000000000000000000000000000000101',
          handle: 'abuse-alice-3',
        });
        await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xbbb0000000000000000000000000000000000102',
          handle: 'abuse-bob-3',
        });

        await request(app.server)
          .post('/v1/payments/topup')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({ userId: alice.body.user.id, amount: 10000 });

        const first = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob-3',
            plaintext: 'first',
            idempotencyKey: 'idem-abuse-1',
          });
        expect(first.status).toBe(200);

        const retry = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob-3',
            plaintext: 'first',
            idempotencyKey: 'idem-abuse-1',
          });
        expect(retry.status).toBe(200);
        expect(retry.body.messageId).toBe(first.body.messageId);

        const blocked = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'abuse-bob-3',
            plaintext: 'new send should be blocked',
          });
        expect(blocked.status).toBe(429);
        expect(blocked.body.error).toBe('abuse_blocked');

        await app.close();
      },
    );
  });
});

