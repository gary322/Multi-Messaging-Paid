import { createHmac } from 'node:crypto';
import { Wallet } from 'ethers';
import request from 'supertest';
import { createServer } from '../src/index';
import { closeRedisClient } from '../src/lib/redis';
import { env } from '../src/config/env';
import { resetStore } from '../src/lib/db';
import { resetRateLimitsForTests } from '../src/lib/rateLimit';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

async function pause(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('security hardening', () => {
  beforeEach(async () => {
    await resetStore();
    await resetRateLimitsForTests();
  });

  afterEach(async () => {
    if (env.WORKER_DISTRIBUTED && env.REDIS_URL) {
      await closeRedisClient();
    }
  });

  it('rejects auth challenge replay when challenge has been consumed', async () => {
    const app = await createServer();
    const wallet = Wallet.createRandom();
    const challenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'wallet',
    });
    expect(challenge.status).toBe(200);

    const signature = await wallet.signMessage(challenge.body.challenge);

    const verifyRequest = {
      challengeId: challenge.body.challengeId,
      method: 'wallet',
      walletAddress: wallet.address,
      proof: signature,
    };

    const firstVerify = await request(app.server).post('/v1/auth/verify').send(verifyRequest);
    expect(firstVerify.status).toBe(200);

    const replayVerify = await request(app.server).post('/v1/auth/verify').send(verifyRequest);
    expect(replayVerify.status).toBe(400);
    expect(replayVerify.body.error).toBe('invalid_or_expired_challenge');

    await app.close();
  });

  it('enforces challenge expiry for social and passkey auth', async () => {
    await withEnv(
      {
        AUTH_CHALLENGE_TTL_MS: 20,
      },
      async () => {
        const app = await createServer();
        const challenge = await request(app.server).post('/v1/auth/challenge').send({
          method: 'social',
          provider: 'google',
        });
        expect(challenge.status).toBe(200);

        await pause(40);

        const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
          .update(`v1:social:google:expired-subject:${challenge.body.challenge}`)
          .digest('hex');

        const verify = await request(app.server).post('/v1/auth/verify').send({
          challengeId: challenge.body.challengeId,
          method: 'social',
          provider: 'google',
          subject: 'expired-subject',
          proof,
        });

        expect(verify.status).toBe(400);
        expect(verify.body.error).toBe('invalid_or_expired_challenge');

        await app.close();
      },
    );
  });

  it('rejects provider mismatch for social/passkey verify attempts', async () => {
    const app = await createServer();
    const challenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    expect(challenge.status).toBe(200);

    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:social:google:wrong-provider:${challenge.body.challenge}`)
      .digest('hex');

    const wrongProvider = await request(app.server).post('/v1/auth/verify').send({
      challengeId: challenge.body.challengeId,
      method: 'social',
      provider: 'github',
      subject: 'wrong-provider',
      proof,
    });

    const passkeyChallenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });

    const wrongMethod = await request(app.server).post('/v1/auth/verify').send({
      challengeId: passkeyChallenge.body.challengeId,
      method: 'passkey',
      provider: 'google',
      subject: 'wrong-method',
      proof,
    });

    expect(wrongProvider.status).toBe(400);
    expect(wrongProvider.body.error).toBe('challenge_provider_mismatch');
    expect(wrongMethod.status).toBe(400);
    expect(wrongMethod.body.error).toBe('challenge_method_mismatch');

    await app.close();
  });

  it('prevents idempotency-key conflict across different recipients', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xa1111111111111111111111111111111111111111',
      handle: 'alice-sec',
    });
    await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xbb1111111111111111111111111111111111111111',
      handle: 'bob-sec',
    });
    await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xcc1111111111111111111111111111111111111111',
      handle: 'carol-sec',
    });

    await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ userId: alice.body.user.id, amount: 10000 });

    const payload = {
      senderId: alice.body.user.id,
      recipientSelector: 'bob-sec',
      plaintext: 'security test first send',
      idempotencyKey: 'idem-conflict-key',
    };

    const first = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send(payload);
    expect(first.status).toBe(200);

    const conflict = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({
        ...payload,
        recipientSelector: 'carol-sec',
      });

    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');
    expect(conflict.body.reason).toBe('Different recipient for idempotency key');

    await app.close();
  });

  it('enforces auth boundaries on protected state-changing operations', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xa222222222222222222222222222222222222222',
      handle: 'alice-sec-2',
    });
    const bob = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xbb22222222222222222222222222222222222222',
      handle: 'bob-sec-2',
    });

    const profile = await request(app.server)
      .put('/v1/profile')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({
        userId: bob.body.user.id,
        handle: 'owned-by-bob',
      });
    expect(profile.status).toBe(403);
    expect(profile.body.error).toBe('auth_mismatch');

    const bobInbox = await request(app.server)
      .get(`/v1/messages/inbox/${bob.body.user.id}`)
      .set('Authorization', `Bearer ${alice.body.token}`);
    expect(bobInbox.status).toBe(403);
    expect(bobInbox.body.error).toBe('auth_mismatch');

    const send = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({
        senderId: bob.body.user.id,
        recipientSelector: 'alice-sec-2',
        plaintext: 'attack',
      });
    expect(send.status).toBe(403);
    expect(send.body.error).toBe('auth_mismatch');

    await app.close();
  });

  it('enforces route rate limits at abusive boundaries', async () => {
    await withEnv(
      {
        RATE_LIMIT_MAX: 1,
        RATE_LIMIT_WINDOW_MS: 60_000,
      },
      async () => {
        const app = await createServer();
        const alice = await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xa333333333333333333333333333333333333333',
          handle: 'alice-sec-3',
        });
        await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0xbb33333333333333333333333333333333333333',
          handle: 'bob-sec-3',
        });

        await request(app.server)
          .post('/v1/payments/topup')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            userId: alice.body.user.id,
            amount: 10000,
          });

        const firstSend = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'bob-sec-3',
            plaintext: 'first',
          });
        expect(firstSend.status).toBe(200);

        const secondSend = await request(app.server)
          .post('/v1/messages/send')
          .set('Authorization', `Bearer ${alice.body.token}`)
          .send({
            senderId: alice.body.user.id,
            recipientSelector: 'bob-sec-3',
            plaintext: 'second',
          });
        expect(secondSend.status).toBe(429);
        expect(secondSend.body.error).toBe('rate_limited');

        await app.close();
      },
    );
  });
});
