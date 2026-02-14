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

async function pause(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('profile and identity', () => {
  it('normalizes handles, enforces reserved names, and blocks handle rotation within cooldown', async () => {
    await withEnv({ HANDLE_ROTATION_COOLDOWN_MS: 60 }, async () => {
      const app = await createServer();
      const reg = await request(app.server).post('/v1/auth/register').send({
        walletAddress: '0xaaaa33333333333333333333333333333333333333',
        handle: 'Alice_Cool',
      });
      expect(reg.status).toBe(200);
      const userId = reg.body.user.id;
      const token = reg.body.token;

      // reserved handle
      const reserved = await request(app.server)
        .put('/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId, handle: 'admin' });
      expect(reserved.status).toBe(400);
      expect(reserved.body.error).toBe('invalid_handle');

      // rotation cooldown (immediate change after register)
      const tooSoon = await request(app.server)
        .put('/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId, handle: 'alice_cool_2' });
      expect(tooSoon.status).toBe(409);
      expect(tooSoon.body.error).toBe('handle_rotation_cooldown');

      await pause(80);
      const ok = await request(app.server)
        .put('/v1/profile')
        .set('Authorization', `Bearer ${token}`)
        .send({ userId, handle: 'alice_cool_2' });
      expect(ok.status).toBe(200);
      expect(ok.body.user.handle).toBe('alice_cool_2');

      await app.close();
    });
  });

  it('respects discoverability for identity lookups', async () => {
    const app = await createServer();
    const reg = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xaaaa44444444444444444444444444444444444444',
      handle: 'alice_identity',
    });
    const userId = reg.body.user.id;
    const token = reg.body.token;

    const ok = await request(app.server).get('/v1/identity/alice_identity');
    expect(ok.status).toBe(200);
    expect(ok.body.walletAddress).toBeTruthy();

    const update = await request(app.server)
      .put('/v1/profile')
      .set('Authorization', `Bearer ${token}`)
      .send({ userId, discoverableByHandle: 0 });
    expect(update.status).toBe(200);

    const hidden = await request(app.server).get('/v1/identity/alice_identity');
    expect(hidden.status).toBe(404);
    expect(hidden.body.error).toBe('identity_not_found');

    await app.close();
  });
});

