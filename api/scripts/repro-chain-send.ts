import request from 'supertest';
import { createServer } from '../src/index';
import { resetStore, findUserByHandle } from '../src/lib/db';

(async () => {
  await resetStore();
  const app = await createServer();
  const { Wallet } = await import('ethers');

  const topupKey = process.env.CHAIN_SENDER_PRIVATE_KEY as string;
  const recipientKey = process.env.CHAIN_RECIPIENT_PRIVATE_KEY as string;
  const sender = new Wallet(topupKey);
  const recipient = new Wallet(recipientKey);

  const alice = await request(app.server).post('/v1/auth/register').send({ walletAddress: sender.address, handle: 'chain_alice', phone: '+15550101010' });
  const bob = await request(app.server).post('/v1/auth/register').send({ walletAddress: recipient.address, handle: 'chain_bob', phone: '+15550101011' });

  console.log('alice', alice.status, alice.body.user?.handle, alice.body.user?.id);
  console.log('bob', bob.status, bob.body.user?.handle, bob.body.user?.id);

  const found = await findUserByHandle('chain_bob', true);
  console.log('foundByHandle', found);

  const topup = await request(app.server)
    .post('/v1/payments/topup')
    .set('Authorization', `Bearer ${alice.body.token}`)
    .send({ userId: alice.body.user.id, amount: 1000, privateKey: topupKey });
  console.log('topup', topup.status, topup.body);

  const send = await request(app.server)
    .post('/v1/messages/send')
    .set('Authorization', `Bearer ${alice.body.token}`)
    .send({ senderId: alice.body.user.id, recipientSelector: 'chain_bob', plaintext: 'hello', senderPrivateKey: topupKey });
  console.log('send', send.status, send.body);

  await app.close();
})();
