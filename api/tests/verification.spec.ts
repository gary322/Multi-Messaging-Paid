import request from 'supertest';
import { createServer } from '../src/index';

describe('verification', () => {
  it('confirms and verifies phone/email', async () => {
    const app = await createServer();
    const reg = await request(app.server).post('/v1/auth/register').send({ walletAddress: '0xcccc11111111111111111111111111111111111111' });
    const userId = reg.body.user.id;
    const token = reg.body.token;

    const reqPhone = await request(app.server)
      .post('/v1/verify/request')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId,
        channel: 'phone',
        target: '+19998887777',
      });
    expect(reqPhone.status).toBe(200);
    const code = reqPhone.body.code;

    const reqPhoneAuthed = await request(app.server)
      .post('/v1/verify/request')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId,
        channel: 'phone',
        target: '+19998887778',
      });
    expect(reqPhoneAuthed.status).toBe(200);

    const confirm = await request(app.server)
      .post('/v1/verify/confirm')
      .set('Authorization', `Bearer ${token}`)
      .send({
        userId,
        channel: 'phone',
        target: '+19998887777',
        code,
      });
    expect(confirm.status).toBe(200);
    expect(confirm.body.ok).toBe(true);

    const confirmAuthed = await request(app.server).post('/v1/verify/confirm').set('Authorization', `Bearer ${token}`).send({
      userId,
      channel: 'phone',
      target: '+19998887777',
      code,
    });
    expect(confirmAuthed.status).toBe(400);

    const badAuth = await request(app.server).post('/v1/verify/request').send({
      userId,
      channel: 'phone',
      target: '+19998887777',
    });
    expect(badAuth.status).toBe(401);

    await app.close();
  });
});
