import { ethers } from 'ethers';
import request from 'supertest';
import { createServer } from '../src/index';
import { resetStore } from '../src/lib/db';
import { env } from '../src/config/env';
import { closeRedisClient } from '../src/lib/redis';

describe('local chain integration', () => {
  beforeEach(async () => {
    await resetStore();
  });

  afterEach(async () => {
    if (env.WORKER_DISTRIBUTED && env.REDIS_URL) {
      await closeRedisClient();
    }
  });

  it('processes topup, send, and withdraw via on-chain vault', async () => {
    const rpcUrl = process.env.CHAIN_RPC_URL;
    const vault = process.env.CHAIN_VAULT_ADDRESS;
    const token = process.env.CHAIN_USDC_ADDRESS;
    const topupKey = process.env.CHAIN_SENDER_PRIVATE_KEY;
    const recipientKey = process.env.CHAIN_RECIPIENT_PRIVATE_KEY;

    if (!rpcUrl || !vault || !token || !topupKey || !recipientKey) {
      return;
    }

    const sender = new ethers.Wallet(topupKey);
    const recipient = new ethers.Wallet(recipientKey);

    const app = await createServer();
    const topupAmount = 1000;
    const withdrawAmount = 100;

    const alice = await request(app.server).post('/v1/auth/register').send({
      walletAddress: sender.address,
      handle: 'chain_alice',
      phone: '+15550101010',
    });
    expect(alice.status).toBe(200);

    const bob = await request(app.server).post('/v1/auth/register').send({
      walletAddress: recipient.address,
      handle: 'chain_bob',
      phone: '+15550101011',
    });
    expect(bob.status).toBe(200);

    const topup = await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({ userId: alice.body.user.id, amount: topupAmount, privateKey: topupKey });
    expect(topup.status).toBe(200);
    expect(topup.body.balance).toBeGreaterThanOrEqual(topupAmount);

    const send = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${alice.body.token}`)
      .send({
        senderId: alice.body.user.id,
        recipientSelector: 'chain_bob',
        plaintext: 'chain hello',
        senderPrivateKey: topupKey,
      });
    expect(send.status).toBe(200);
    expect(send.body.txHash).toBeTruthy();

    const inbox = await request(app.server)
      .get(`/v1/messages/inbox/${bob.body.user.id}`)
      .set('Authorization', `Bearer ${bob.body.token}`);
    expect(inbox.status).toBe(200);
    expect(Array.isArray(inbox.body.messages)).toBe(true);
    const recipientMessages = inbox.body.messages.filter((message: any) => message.tx_hash === send.body.txHash);
    expect(recipientMessages.length).toBe(1);
    expect(recipientMessages[0].tx_hash).toBe(send.body.txHash);

    const withdraw = await request(app.server)
      .post('/v1/payments/withdraw')
      .set('Authorization', `Bearer ${bob.body.token}`)
      .send({ userId: bob.body.user.id, amount: withdrawAmount, privateKey: recipientKey });
    expect(withdraw.status).toBe(200);
    expect(withdraw.body.balance).toBeLessThanOrEqual(topupAmount);

    await app.close();
  });
});
