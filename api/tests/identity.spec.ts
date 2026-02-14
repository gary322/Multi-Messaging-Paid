import { createHmac } from 'node:crypto';
import request from 'supertest';
import { createServer } from '../src/index';
import { env } from '../src/config/env';
import { deriveSmartWalletAddress } from '../src/lib/smartAccount';
import { resolveIdentityWallet } from '../src/lib/identity';

jest.mock('../src/services/chain', () => {
  const actual = jest.requireActual('../src/services/chain');
  return {
    ...actual,
    getLatestBlockNumber: jest.fn(),
    readChainBalance: jest.fn(),
  };
});

describe('identity verification', () => {
  afterEach(() => {
    delete (global as any).fetch;
    env.IDENTITY_VERIFICATION_STRICT = false;
  env.IDENTITY_ALLOWED_PROVIDERS = [];
  env.SOCIAL_VERIFY_URL = '';
  env.PASSKEY_VERIFY_URL = '';
  env.REQUIRE_SOCIAL_TOS_ACCEPTED = false;
    env.LEGAL_TOS_VERSION = 'v1';
    env.LEGAL_TOS_APPROVED_AT = '';
  });

  function localProof(method: 'social' | 'passkey', provider: string, challenge: string, subject: string) {
    const audience = method === 'social' ? (env.SOCIAL_AUDIENCE || '') : env.PASSKEY_AUDIENCE || '';
    const payload = audience ? `${method}:${provider}:${subject}:${challenge}:aud=${audience}` : `${method}:${provider}:${subject}:${challenge}`;
    return createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:${payload}`)
      .digest('hex');
  }

  it('derives distinct wallets for social identity providers with the same subject', async () => {
    const app = await createServer();

    const subject = 'social-abstraction-user';
    const googleChallenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    const githubChallenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'github',
    });

    expect(googleChallenge.status).toBe(200);
    expect(githubChallenge.status).toBe(200);

    const googleProof = localProof(
      'social',
      'google',
      googleChallenge.body.challenge,
      subject,
    );
    const githubProof = localProof(
      'social',
      'github',
      githubChallenge.body.challenge,
      subject,
    );

    const googleVerify = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: googleChallenge.body.challengeId,
        method: 'social',
        provider: 'google',
        subject,
        proof: googleProof,
      });

    const githubVerify = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: githubChallenge.body.challengeId,
        method: 'social',
        provider: 'github',
        subject,
        proof: githubProof,
      });

    const googleWallet = googleVerify.body.walletAddress;
    const githubWallet = githubVerify.body.walletAddress;

    expect(googleWallet).toBe(deriveSmartWalletAddress({ provider: 'social:google', subject }));
    expect(githubWallet).toBe(deriveSmartWalletAddress({ provider: 'social:github', subject }));
    expect(googleWallet).not.toBe(githubWallet);
    await app.close();
  });

  it('derives distinct wallets for passkey providers with the same subject', async () => {
    const app = await createServer();

    const subject = 'passkey-abstraction-user';
    const appleChallenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'passkey',
      provider: 'apple',
    });
    const googleChallenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'passkey',
      provider: 'google',
    });

    expect(appleChallenge.status).toBe(200);
    expect(googleChallenge.status).toBe(200);

    const appleProof = localProof(
      'passkey',
      'apple',
      appleChallenge.body.challenge,
      subject,
    );
    const googleProof = localProof(
      'passkey',
      'google',
      googleChallenge.body.challenge,
      subject,
    );

    const appleVerify = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: appleChallenge.body.challengeId,
        method: 'passkey',
        provider: 'apple',
        subject,
        proof: appleProof,
      });

    const googleVerify = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: googleChallenge.body.challengeId,
        method: 'passkey',
        provider: 'google',
        subject,
        proof: googleProof,
      });

    const appleWallet = appleVerify.body.walletAddress;
    const googleWallet = googleVerify.body.walletAddress;
    expect(appleWallet).toBe(deriveSmartWalletAddress({ provider: 'passkey:apple', subject }));
    expect(googleWallet).toBe(deriveSmartWalletAddress({ provider: 'passkey:google', subject }));
    expect(appleWallet).not.toBe(googleWallet);
    await app.close();
  });

  it('accepts local social proof when no remote verifier is configured', async () => {
    const app = await createServer();
    const challengeResponse = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    expect(challengeResponse.status).toBe(200);

    const subject = 'social-user-123';
    const provider = 'google';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:social:${provider}:${subject}:${challengeResponse.body.challenge}`)
      .digest('hex');

    const verifyResponse = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        method: 'social',
        provider,
        subject,
        proof,
      });

    const expectedWallet = deriveSmartWalletAddress({ provider: 'social:google', subject });
    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.walletAddress).toBe(expectedWallet);
    expect(verifyResponse.body.token).toMatch(/^mmp\./);
    await app.close();
  });

  it('uses remote verifier when configured', async () => {
    const app = await createServer();
    env.SOCIAL_VERIFY_URL = 'https://id.test/social-verify';
    const challenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    const subject = 'social-user-456';
    const proof = 'sig-abc';
    const expectedWallet = '0x1111111111111111111111111111111111111111';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        walletAddress: expectedWallet,
        subject,
        provider: 'google',
      }),
    } as any);
    (global as any).fetch = mockFetch;

    const response = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challenge.body.challengeId,
        method: 'social',
        provider: 'google',
        subject,
        proof,
      });

    expect(response.status).toBe(200);
    expect(response.body.walletAddress).toBe(expectedWallet);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://id.test/social-verify',
      expect.objectContaining({ method: 'POST' }),
    );
    await app.close();
  });

  it('falls back when remote verifier fails and strict mode is disabled', async () => {
    const app = await createServer();
    env.IDENTITY_VERIFICATION_STRICT = false;
    env.SOCIAL_VERIFY_URL = 'https://id.test/social-verify';
    const challenge = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    const subject = 'social-user-789';

    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false }),
    } as any);
    (global as any).fetch = mockFetch;

    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:social:google:${subject}:${challenge.body.challenge}`)
      .digest('hex');

    const response = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challenge.body.challengeId,
        method: 'social',
        provider: 'google',
        subject,
        proof,
      });

    const expectedWallet = deriveSmartWalletAddress({ provider: 'social:google', subject });
    expect(response.status).toBe(200);
    expect(response.body.walletAddress).toBe(expectedWallet);
    await app.close();
  });

  it('enforces strict mode by rejecting local passkey proof when remote verifier is configured', async () => {
    const app = await createServer();
    env.IDENTITY_VERIFICATION_STRICT = true;
    env.PASSKEY_VERIFY_URL = 'https://passkey.test/verify';
    const challengeResponse = await request(app.server).post('/v1/auth/challenge').send({
      method: 'passkey',
      provider: 'apple',
    });
    expect(challengeResponse.status).toBe(200);

    const subject = 'passkey-strict-user';
    const provider = 'apple';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:passkey:${provider}:${subject}:${challengeResponse.body.challenge}`)
      .digest('hex');

    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ ok: false }),
    } as any);
    (global as any).fetch = mockFetch;

    const response = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        method: 'passkey',
        provider,
        subject,
        proof,
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('identity_verification_failed');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('falls back to local proof when remote verifier response payload is invalid and strict mode is disabled', async () => {
    const app = await createServer();
    env.SOCIAL_VERIFY_URL = 'https://id.test/social-verify-invalid';
    env.IDENTITY_VERIFICATION_STRICT = false;

    const challengeResponse = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    expect(challengeResponse.status).toBe(200);

    const subject = 'social-invalid-response';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:social:google:${subject}:${challengeResponse.body.challenge}`)
      .digest('hex');

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        walletAddress: 'not-a-valid-wallet',
        subject,
        provider: 'google',
      }),
    } as any);
    (global as any).fetch = mockFetch;

    const response = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        method: 'social',
        provider: 'google',
        subject,
        proof,
      });

    const expectedWallet = deriveSmartWalletAddress({ provider: 'social:google', subject });
    expect(response.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(response.body.walletAddress).toBe(expectedWallet);
    await app.close();
  });

  it('enforces strict mode for malformed remote social verifier response', async () => {
    const app = await createServer();
    env.SOCIAL_VERIFY_URL = 'https://id.test/social-verify';
    env.IDENTITY_VERIFICATION_STRICT = true;

    const challengeResponse = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    expect(challengeResponse.status).toBe(200);

    const subject = 'social-strict-malformed';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:social:google:${subject}:${challengeResponse.body.challenge}`)
      .digest('hex');

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        walletAddress: 'not-a-valid-wallet',
        subject,
        provider: 'google',
      }),
    } as any);
    (global as any).fetch = mockFetch;

    const response = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        method: 'social',
        provider: 'google',
        subject,
        proof,
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('identity_verification_failed');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('surfaces identity verification failures when remote verifier times out and strict mode is enabled', async () => {
    const app = await createServer();
    env.PASSKEY_VERIFY_URL = 'https://passkey.test/passkey-timeout';
    env.IDENTITY_VERIFICATION_STRICT = true;

    const challengeResponse = await request(app.server).post('/v1/auth/challenge').send({
      method: 'passkey',
      provider: 'apple',
    });
    expect(challengeResponse.status).toBe(200);

    const subject = 'passkey-timeout-user';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:passkey:apple:${subject}:${challengeResponse.body.challenge}`)
      .digest('hex');

    const mockFetch = jest.fn().mockRejectedValue(new Error('timeout')); // mimics network timeout
    (global as any).fetch = mockFetch;

    const response = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        method: 'passkey',
        provider: 'apple',
        subject,
        proof,
      });

    expect(response.status).toBe(401);
    expect(response.body.error).toBe('identity_verification_failed');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('supports passkey local proof with abstraction wallet derivation', async () => {
    const app = await createServer();
    const challengeResponse = await request(app.server).post('/v1/auth/challenge').send({
      method: 'passkey',
      provider: 'apple',
    });
    expect(challengeResponse.status).toBe(200);

    const subject = 'passkey-user-001';
    const provider = 'apple';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:passkey:${provider}:${subject}:${challengeResponse.body.challenge}`)
      .digest('hex');

    const verifyResponse = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: challengeResponse.body.challengeId,
        method: 'passkey',
        provider,
        subject,
        proof,
      });

    const expectedWallet = deriveSmartWalletAddress({ provider: 'passkey:apple', subject });
    expect(verifyResponse.status).toBe(200);
    expect(verifyResponse.body.walletAddress).toBe(expectedWallet);
    expect(verifyResponse.body.token).toMatch(/^mmp\./);
    await app.close();
  });

  it('requires social tos version when strict social gating is enabled', async () => {
    const app = await createServer();
    env.REQUIRE_SOCIAL_TOS_ACCEPTED = true;
    env.LEGAL_TOS_VERSION = 'v2026-02';
    env.LEGAL_TOS_APPROVED_AT = '';

    const response = await request(app.server).post('/v1/auth/challenge').send({
      method: 'social',
      provider: 'google',
    });
    expect(response.status).toBe(200);
    const subject = 'social-tos-missing';
    const proof = createHmac('sha256', env.SOCIAL_AUTH_SECRET || env.SESSION_SECRET)
      .update(`v1:social:google:${subject}:${response.body.challenge}`)
      .digest('hex');

    const verify = await request(app.server)
      .post('/v1/auth/verify')
      .send({
        challengeId: response.body.challengeId,
        method: 'social',
        provider: 'google',
        subject,
        proof,
        termsVersion: 'wrong-version',
      });

    expect(verify.status).toBe(403);
    expect(verify.body.error).toBe('compliance_required');
    await app.close();
  });

  it('rejects disallowed providers when allow-list is enabled', () => {
    env.IDENTITY_ALLOWED_PROVIDERS = ['github', 'apple'];
    return resolveIdentityWallet({
      method: 'social',
      challenge: 'test-challenge',
      provider: 'google',
      subject: 'u1',
      proof: 'abcd',
    }).then((resolved) => {
      expect(resolved).toBeNull();
    });
  });
});
