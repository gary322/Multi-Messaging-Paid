import request from 'supertest';
import { createServer } from '../src/index';

describe('payments and messages', () => {
  it('topup and send flow', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xaaaa11111111111111111111111111111111111111',
      handle: 'alice',
    });
    const bob = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xbbbb11111111111111111111111111111111111111',
      handle: 'bob',
      phone: '+15550003333',
    });

    const aliceToken = alice.body.token;
    const bobToken = bob.body.token;
    const aliceId = alice.body.user.id;
    const bobId = bob.body.user.id;

    const topup = await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: aliceId, amount: 1000 });
    expect(topup.status).toBe(200);
    expect(topup.body.balance).toBeGreaterThan(500);

    const send = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        senderId: aliceId,
        recipientSelector: 'bob',
        plaintext: 'Hi Bob',
      });
    expect(send.status).toBe(200);
    expect(send.body.paid).toBe(500);

    const inbox = await request(app.server)
      .get(`/v1/messages/inbox/${bobId}`)
      .set('Authorization', `Bearer ${bobToken}`);
    expect(inbox.status).toBe(200);
    expect(Array.isArray(inbox.body.messages)).toBe(true);
    expect(inbox.body.messages.length).toBe(1);

    const tokenMismatch = await request(app.server)
      .get(`/v1/messages/inbox/${bobId}`)
      .set('Authorization', `Bearer ${aliceToken}`);
    expect(tokenMismatch.status).toBe(403);

    const sendUnauth = await request(app.server).post('/v1/messages/send').send({
      senderId: aliceId,
      recipientSelector: 'bob',
      plaintext: 'Hi Bob',
    });
    expect(sendUnauth.status).toBe(401);

    const badSend = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        senderId: aliceId,
        recipientSelector: 'nobody',
        plaintext: 'bad',
      });
    expect(badSend.status).toBe(404);

    const withdraw = await request(app.server)
      .post('/v1/payments/withdraw')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: aliceId, amount: 200 });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.balance).toBe(300);

    const badWithdraw = await request(app.server)
      .post('/v1/payments/withdraw')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: aliceId, amount: 1000000 });
    expect(badWithdraw.status).toBe(409);

    await app.close();
  });

  it('supports idempotent retries when idempotency_key is provided', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xaaaa11111111111111111111111111111111111113',
      handle: 'alice3',
    });
    const bob = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xbbbb11111111111111111111111111111111111113',
      handle: 'bob3',
      phone: '+15550004444',
    });

    const aliceId = alice.body.user.id;
    const bobToken = bob.body.token;
    const bobId = bob.body.user.id;

    await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ userId: aliceId, amount: 1000 });

    const payload = {
      senderId: aliceId,
      recipientSelector: 'bob3',
      plaintext: 'Hello again',
      idempotencyKey: 'retry-key-001',
    };

    const sendFirst = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send(payload);
    expect(sendFirst.status).toBe(200);

    const sendSecond = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send(payload);
    expect(sendSecond.status).toBe(200);
    expect(sendSecond.body.messageId).toBe(sendFirst.body.messageId);
    expect(sendSecond.body.paid).toBe(sendFirst.body.paid);

    const inbox = await request(app.server)
      .get(`/v1/messages/inbox/${bobId}`)
      .set('Authorization', `Bearer ${bobToken}`);
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages.length).toBe(1);

    await app.close();
  });

  it('rejects self-messaging', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xaaaa11111111111111111111111111111111111114',
      handle: 'alice4',
    });

    await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ userId: alice.body.user.id, amount: 1000 });

    const sendToSelf = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ senderId: alice.body.user.id, recipientSelector: 'alice4', plaintext: 'nope' });

    expect(sendToSelf.status).toBe(409);
    expect(sendToSelf.body.error).toBe('self_send_not_allowed');

    await app.close();
  });

  it('applies first-contact and return discount pricing', async () => {
    const app = await createServer();

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xaaaa11111111111111111111111111111111111112',
      handle: 'alice2',
    });
    const bob = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xbbbb11111111111111111111111111111111111112',
      handle: 'bob2',
    });
    const aliceToken = alice.body.token;
    const bobToken = bob.body.token;

    await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ userId: alice.body.user.id, amount: 1000 });
    await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ userId: bob.body.user.id, amount: 1000 });

    await request(app.server)
      .put('/v1/pricing')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({
        userId: bob.body.user.id,
        defaultPrice: 100,
        firstContactPrice: 500,
        returnDiscountBps: 5000,
        acceptsAll: true,
      });

    const firstSend = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        senderId: alice.body.user.id,
        recipientSelector: 'bob2',
        plaintext: 'first message to Bob',
      });
    expect(firstSend.status).toBe(200);
    expect(firstSend.body.paid).toBe(500);

    const bobReply = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({
        senderId: bob.body.user.id,
        recipientSelector: 'alice2',
        plaintext: 'reply message',
      });
    expect(bobReply.status).toBe(200);
    expect(bobReply.body.paid).toBe(500);

    const secondSend = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        senderId: alice.body.user.id,
        recipientSelector: 'bob2',
        plaintext: 'second message to Bob',
      });
    expect(secondSend.status).toBe(200);
    expect(secondSend.body.paid).toBe(50);

    await app.close();
  });
});
