import request from 'supertest';
import { createHmac } from 'node:crypto';
import { Wallet } from 'ethers';
import { createServer } from '../src/index';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('auth', () => {
  it('exposes identity provider metadata', async () => {
    const app = await createServer();
    const response = await request(app.server).get('/v1/auth/providers');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.providers)).toBe(true);
    expect(Array.isArray(response.body.providersByMethod?.social)).toBe(true);
    expect(response.body.providersByMethod.social[0]?.method).toBe('social');
    await app.close();
  });

  it('registers a user and issues session', async () => {
    const app = await createServer();
    const register = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0x1111111111111111111111111111111111111111',
      email: 'alice@example.com',
      phone: '+15550001111',
      handle: 'alice',
    });
    expect(register.status).toBe(200);
    const body = register.body;
    expect(body.user.walletAddress).toBe('0x1111111111111111111111111111111111111111');
    expect(body.token).toMatch(/^mmp\./);

    const session = await request(app.server).post('/v1/auth/issue-session').send({
      walletAddress: '0x1111111111111111111111111111111111111111',
    });
    expect(session.status).toBe(200);
    expect(session.body.token.startsWith('mmp.')).toBe(true);
    await app.close();
  });

  it('supports challenge-based wallet auth with signature verification', async () => {
    const app = await createServer();
    const wallet = Wallet.createRandom();
    const challenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'wallet',
      subjectHint: wallet.address,
    });
    expect(challenge.status).toBe(200);
    const signature = await wallet.signMessage(challenge.body.challenge);

    const verify = await request(app.server).post('/v1/auth/verify').send({
      challengeId: challenge.body.challengeId,
      method: 'wallet',
      proof: signature,
      walletAddress: wallet.address,
    });

    expect(verify.status).toBe(200);
    expect(verify.body.walletAddress).toBe(wallet.address.toLowerCase());
    expect(verify.body.token).toMatch(/^mmp\./);
    await app.close();
  });

  it('supports social/passkey style auth via signed challenge secret', async () => {
    const app = await createServer();
    const subject = 'social-user-123';
    const provider = 'google';
    const challenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider,
    });
    expect(challenge.status).toBe(200);
    const hmacKey = env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET;
    const proof = createHmac('sha256', hmacKey)
      .update(`v1:social:${provider}:${subject}:${challenge.body.challenge}`)
      .digest('hex');

    const verify = await request(app.server).post('/v1/auth/verify').send({
      challengeId: challenge.body.challengeId,
      method: 'social',
      provider,
      subject,
      proof,
    });
    expect(verify.status).toBe(200);
    expect(verify.body.walletAddress).toBeTruthy();
    expect(verify.body.token).toMatch(/^mmp\./);
    await app.close();
  });

  it('returns a 409 when a different identity tries to reuse an existing wallet binding', async () => {
    const fixedWallet = '0x1111111111111111111111111111111111111111';
    const previousFetch = (global as any).fetch;
    await withEnv({ SOCIAL_VERIFY_URL: 'https://id.test/social-verify' }, async () => {
      const mockFetch = jest
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            walletAddress: fixedWallet,
            provider: 'google',
            subject: 'social-user',
          }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            ok: true,
            walletAddress: fixedWallet,
            provider: 'google',
            subject: 'social-user-alt',
          }),
        });
      (global as any).fetch = mockFetch;

      const app = await createServer();
      try {
        const firstChallenge = await request(app.server).post('/v1/auth/challenge').send({
          method: 'social',
          provider: 'google',
        });
        const firstVerify = await request(app.server)
          .post('/v1/auth/verify')
          .send({
            challengeId: firstChallenge.body.challengeId,
            method: 'social',
            provider: 'google',
            subject: 'social-user',
            proof: 'proof-a',
          });
        expect(firstVerify.status).toBe(200);
        expect(firstVerify.body.walletAddress).toBe(fixedWallet);

        const secondChallenge = await request(app.server).post('/v1/auth/challenge').send({
          method: 'social',
          provider: 'google',
        });
        const secondVerify = await request(app.server)
          .post('/v1/auth/verify')
          .send({
            challengeId: secondChallenge.body.challengeId,
            method: 'social',
            provider: 'google',
            subject: 'social-user-alt',
            proof: 'proof-b',
          });

        expect(secondVerify.status).toBe(409);
        expect(secondVerify.body.error).toBe('identity_wallet_collision');
      } finally {
        await app.close();
        (global as any).fetch = previousFetch;
      }
    });
  });

  it('requires accepted legal terms for social auth when enforcement is enabled', async () => {
    await withEnv(
      {
        REQUIRE_SOCIAL_TOS_ACCEPTED: true,
        LEGAL_TOS_VERSION: 'v2',
        LEGAL_TOS_APPROVED_AT: '2026-02-13T00:00:00Z',
      },
      async () => {
        const app = await createServer();
        const challenge = await request(app.server).post('/v1/auth/challenge').send({
          method: 'social',
          provider: 'google',
        });
        expect(challenge.status).toBe(200);

        const hmacKey = env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET;
        const proof = createHmac('sha256', hmacKey)
          .update(`v1:social:google:subject:${challenge.body.challenge}`)
          .digest('hex');

        const verify = await request(app.server).post('/v1/auth/verify').send({
          challengeId: challenge.body.challengeId,
          method: 'social',
          provider: 'google',
          subject: 'social-user-legal',
          proof,
          termsVersion: 'v2',
          termsAcceptedAt: 0,
        });

        expect(verify.status).toBe(403);
        expect(verify.body.error).toBe('compliance_required');
        await app.close();
      },
    );
  });
});
