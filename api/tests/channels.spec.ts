import request from 'supertest';
import { createServer } from '../src/index';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('channels', () => {
  it('connects and disconnects channels', async () => {
    const app = await createServer();
    const reg = await request(app.server).post('/v1/auth/register').send({ walletAddress: '0xdddd11111111111111111111111111111111111111' });
    const userId = reg.body.user.id;
    const token = reg.body.token;

    const connect = await request(app.server)
      .post('/v1/channels/telegram/connect')
      .set('Authorization', `Bearer ${token}`)
      .send({
      userId,
      externalHandle: '@alice_bot',
      });
    expect(connect.status).toBe(200);

    const statusReq = await request(app.server)
      .get('/v1/channels/telegram/status')
      .set('Authorization', `Bearer ${token}`)
      .query({ userId });
    expect(statusReq.status).toBe(200);
    expect(statusReq.body.connected).toBe(true);

    const disconnect = await request(app.server)
      .post('/v1/channels/telegram/disconnect')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId });
    expect(disconnect.status).toBe(200);
    expect(disconnect.body.connected).toBe(false);

    const badReq = await request(app.server).get('/v1/channels/telegram/status').query({ userId });
    expect(badReq.status).toBe(401);

    await app.close();
  });

  it('rejects plaintext channel secrets (expects client-encrypted envelope or vault reference)', async () => {
    const app = await createServer();
    const reg = await request(app.server).post('/v1/auth/register').send({ walletAddress: '0xdddd11111111111111111111111111111111111112' });
    const userId = reg.body.user.id;
    const token = reg.body.token;

    const connect = await request(app.server)
      .post('/v1/channels/telegram/connect')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId,
        externalHandle: '@alice_bot',
        secret: 'plaintext-token',
      });
    expect(connect.status).toBe(400);
    expect(connect.body.error).toBe('invalid_secret_format');

    await app.close();
  });

  it('rejects social channel connect when legal terms are required but missing', async () => {
    await withEnv({ REQUIRE_SOCIAL_TOS_ACCEPTED: true, LEGAL_TOS_VERSION: 'v2', LEGAL_TOS_APPROVED_AT: '2026-02-13T00:00:00Z' }, async () => {
      const app = await createServer();
      const reg = await request(app.server)
        .post('/v1/auth/register')
        .send({ walletAddress: '0xdddd22222222222222222222222222222222222222' });
      const token = reg.body.token;
      const userId = reg.body.user.id;

      const connect = await request(app.server)
        .post('/v1/channels/whatsapp/connect')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId,
          externalHandle: '+15550002222',
          termsAccepted: true,
          termsVersion: 'v2',
        });

      expect(connect.status).toBe(403);
      expect(connect.body.error).toBe('compliance_required');
      expect(connect.body.message).toMatch(/termsAcceptedAt/i);
      await app.close();
    });
  });

  it('stores consent evidence for social channel connect and clears it on disconnect', async () => {
    await withEnv({ REQUIRE_SOCIAL_TOS_ACCEPTED: true, LEGAL_TOS_VERSION: 'v2', LEGAL_TOS_APPROVED_AT: '2026-02-13T00:00:00Z' }, async () => {
      const app = await createServer();
      const reg = await request(app.server)
        .post('/v1/auth/register')
        .send({ walletAddress: '0xdddd33333333333333333333333333333333333333' });
      const userId = reg.body.user.id;
      const token = reg.body.token;
      const acceptedAt = 1700000000000;

      const connect = await request(app.server)
        .post('/v1/channels/x/connect')
        .set('Authorization', `Bearer ${token}`)
        .send({
          userId,
          externalHandle: '@recipient_x',
          termsAccepted: true,
          termsVersion: 'v2',
          termsAcceptedAt: acceptedAt,
        });
      expect(connect.status).toBe(200);
      expect(connect.body.consentVersion).toBe('v2');
      expect(connect.body.consentAcceptedAt).toBe(acceptedAt);

      const statusBefore = await request(app.server)
        .get('/v1/channels/x/status')
        .set('Authorization', `Bearer ${token}`)
        .query({ userId });
      expect(statusBefore.status).toBe(200);
      expect(statusBefore.body.consentVersion).toBe('v2');
      expect(statusBefore.body.consentAcceptedAt).toBe(acceptedAt);

      const disconnect = await request(app.server)
        .post('/v1/channels/x/disconnect')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId });
      expect(disconnect.status).toBe(200);
      expect(disconnect.body.connected).toBe(false);

      const statusAfter = await request(app.server)
        .get('/v1/channels/x/status')
        .set('Authorization', `Bearer ${token}`)
        .query({ userId });
      expect(statusAfter.status).toBe(200);
      expect(statusAfter.body.connected).toBe(false);
      expect(statusAfter.body.consentVersion).toBeNull();
      expect(statusAfter.body.consentAcceptedAt).toBeNull();
      await app.close();
    });
  });

  it('blocks social/channel connect when strict provider checks fail', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: true,
      },
      async () => {
        const app = await createServer();
        const reg = await request(app.server)
          .post('/v1/auth/register')
          .send({ walletAddress: '0x4444444444444444444444444444444444444444' });
        const token = reg.body.token;

        const connect = await request(app.server)
          .post('/v1/channels/telegram/connect')
          .set('Authorization', `Bearer ${token}`)
          .send({
            userId: reg.body.user.id,
            externalHandle: '@blocked_bot',
          });

        expect(connect.status).toBe(503);
        expect(connect.body.error).toBe('notification_provider_unavailable');
        expect(connect.body.reason).toBe('provider_not_configured');
        await app.close();
      },
    );
  });

  it('requires auth token for whatsapp social connect when strict mode lacks provider auth', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: true,
        WHATSAPP_WEBHOOK_URL: 'https://whatsapp.example/callback',
        WHATSAPP_WEBHOOK_TOKEN: '',
      },
      async () => {
        const app = await createServer();
        const reg = await request(app.server)
          .post('/v1/auth/register')
          .send({ walletAddress: '0x5555555555555555555555555555555555555555' });
        const token = reg.body.token;

        const connect = await request(app.server)
          .post('/v1/channels/whatsapp/connect')
          .set('Authorization', `Bearer ${token}`)
          .send({
            userId: reg.body.user.id,
            externalHandle: '+15550003333',
            termsAccepted: true,
            termsVersion: 'v1',
            termsAcceptedAt: Date.now(),
          });

        expect(connect.status).toBe(503);
        expect(connect.body.error).toBe('notification_provider_unavailable');
        expect(connect.body.reason).toBe('provider_auth_missing');
        await app.close();
      },
    );
  });

  it('requires auth token for x social connect when strict mode lacks provider auth', async () => {
    await withEnv(
      {
        NOTIFICATION_PROVIDERS_STRICT: true,
        X_WEBHOOK_URL: 'https://x.example/callback',
        X_WEBHOOK_TOKEN: '',
      },
      async () => {
        const app = await createServer();
        const reg = await request(app.server)
          .post('/v1/auth/register')
          .send({ walletAddress: '0x6666666666666666666666666666666666666666' });
        const token = reg.body.token;

        const connect = await request(app.server)
          .post('/v1/channels/x/connect')
          .set('Authorization', `Bearer ${token}`)
          .send({
            userId: reg.body.user.id,
            externalHandle: '@xrecipient',
            termsAccepted: true,
            termsVersion: 'v1',
            termsAcceptedAt: Date.now(),
          });

        expect(connect.status).toBe(503);
        expect(connect.body.error).toBe('notification_provider_unavailable');
        expect(connect.body.reason).toBe('provider_auth_missing');
        await app.close();
      },
    );
  });
});
