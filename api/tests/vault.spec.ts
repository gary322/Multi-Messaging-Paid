import request from 'supertest';
import { createServer } from '../src/index';

describe('vault blob', () => {
  it('stores, fetches, and deletes a vault blob with auth enforcement', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xaaaa22222222222222222222222222222222222222',
      handle: 'alice-vault',
    });
    const bob = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xbbbb22222222222222222222222222222222222222',
      handle: 'bob-vault',
    });

    const aliceId = alice.body.user.id;
    const aliceToken = alice.body.token;
    const bobToken = bob.body.token;

    const initial = await request(app.server)
      .get('/v1/vault/blob')
      .set('Authorization', `Bearer ${aliceToken}`)
      .query({ userId: aliceId });
    expect(initial.status).toBe(404);

    const blob = JSON.stringify({
      v: 1,
      alg: 'aes-256-gcm',
      ciphertext: 'base64:ciphertext',
      iv: 'base64:iv',
      tag: 'base64:tag',
    });

    const put = await request(app.server)
      .put('/v1/vault/blob')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: aliceId, blob, version: 1 });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);

    const get = await request(app.server)
      .get('/v1/vault/blob')
      .set('Authorization', `Bearer ${aliceToken}`)
      .query({ userId: aliceId });
    expect(get.status).toBe(200);
    expect(get.body.blob).toBe(blob);

    const forbidden = await request(app.server)
      .get('/v1/vault/blob')
      .set('Authorization', `Bearer ${bobToken}`)
      .query({ userId: aliceId });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toBe('auth_mismatch');

    const del = await request(app.server)
      .delete('/v1/vault/blob')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: aliceId });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const after = await request(app.server)
      .get('/v1/vault/blob')
      .set('Authorization', `Bearer ${aliceToken}`)
      .query({ userId: aliceId });
    expect(after.status).toBe(404);

    await app.close();
  });
});

