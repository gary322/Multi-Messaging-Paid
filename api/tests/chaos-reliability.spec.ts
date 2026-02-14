import request from 'supertest';
import * as notifications from '../src/services/notifications';
import { createMessageDeliveryJob, createUser, getDeliveryJobsForMessage, resetStore } from '../src/lib/db';
import { createServer } from '../src/index';
import { runDeliveryWorkerOnce } from '../src/workers/delivery.worker';
import { closeRedisClient } from '../src/lib/redis';
import { env } from '../src/config/env';

describe('chaos and reliability hardening', () => {
  beforeEach(() => resetStore());

  afterEach(async () => {
    if (env.WORKER_DISTRIBUTED && env.REDIS_URL) {
      await closeRedisClient();
    }
  });

  it('recovers from transient delivery failures by retrying then completing', async () => {
    const app = await createServer();
    const recipient = await createUser('0x1111111111111111111111111111111111111111');

    await createMessageDeliveryJob({
      messageId: 'chaos-retry-1',
      userId: recipient.id,
      channel: 'in_app',
      destination: '@recipient',
      payload: { subject: 'paid message' },
      nextAttemptAt: Date.now() - 1,
    });

    const sendNotification = jest.spyOn(notifications, 'sendNotification');
    sendNotification.mockResolvedValueOnce({ ok: false, reason: 'provider_unreachable' });
    sendNotification.mockResolvedValueOnce({ ok: true });

    const firstAttempt = await runDeliveryWorkerOnce('chaos-worker', 10);
    expect(firstAttempt).toEqual({ claimed: 1, done: 0, failed: 1, deferred: 1 });

    const deferredJobs = await getDeliveryJobsForMessage('chaos-retry-1');
    expect(deferredJobs).toHaveLength(1);
    expect(deferredJobs[0].status).toBe('pending');
    expect(deferredJobs[0].error_text).toBe('provider_unreachable');

    const timeTravel = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 2_000);
    const secondAttempt = await runDeliveryWorkerOnce('chaos-worker', 10);
    expect(secondAttempt).toEqual({ claimed: 1, done: 1, failed: 0, deferred: 0 });
    timeTravel.mockRestore();

    const completed = await getDeliveryJobsForMessage('chaos-retry-1');
    expect(completed).toHaveLength(1);
    expect(completed[0].status).toBe('done');
    expect(completed[0].attempts).toBe(2);

    sendNotification.mockRestore();
    await app.close();
  });

  it('dead-letters jobs after max retries', async () => {
    const app = await createServer();
    const recipient = await createUser('0x2222222222222222222222222222222222222222');

    await createMessageDeliveryJob({
      messageId: 'chaos-dead-letter-1',
      userId: recipient.id,
      channel: 'email',
      destination: 'alice@example.com',
      payload: { subject: 'paid message' },
      maxAttempts: 1,
      nextAttemptAt: Date.now() - 1,
    });

    const sendNotification = jest.spyOn(notifications, 'sendNotification');
    sendNotification.mockResolvedValue({ ok: false, reason: 'provider_down' });

    const result = await runDeliveryWorkerOnce('chaos-worker-dead-letter', 10);
    expect(result).toEqual({ claimed: 1, done: 0, failed: 1, deferred: 0 });

    const jobs = await getDeliveryJobsForMessage('chaos-dead-letter-1');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('failed');
    expect(jobs[0].error_text).toContain('max_retries_reached:provider_down');

    sendNotification.mockRestore();
    await app.close();
  });

  it('keeps message delivery state even when notification dispatch fails', async () => {
    const app = await createServer();
    const sender = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0x3333333333333333333333333333333333333333',
      handle: 'chaos-sender',
    });
    const recipient = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0x4444444444444444444444444444444444444444',
      handle: 'chaos-recipient',
    });

    const sendNotification = jest.spyOn(notifications, 'sendNotification');
    sendNotification.mockResolvedValue({ ok: false, reason: 'provider_unreachable' });

    await request(app.server)
      .post('/v1/payments/topup')
      .set('Authorization', `Bearer ${sender.body.token}`)
      .send({ userId: sender.body.user.id, amount: 10000 });

    const connect = await request(app.server)
      .post('/v1/channels/telegram/connect')
      .set('Authorization', `Bearer ${recipient.body.token}`)
      .send({
        userId: recipient.body.user.id,
        externalHandle: '@chaos-recipient-bot',
      });
    expect(connect.status).toBe(200);

    const message = await request(app.server)
      .post('/v1/messages/send')
      .set('Authorization', `Bearer ${sender.body.token}`)
      .send({
        senderId: sender.body.user.id,
        recipientSelector: 'chaos-recipient',
        plaintext: 'chaos message',
      });

    expect(message.status).toBe(200);
    expect(message.body.status).toBe('delivered');

    const worker = await runDeliveryWorkerOnce('chaos-notification-worker', 10);
    expect(worker).toMatchObject({ claimed: 1, failed: 1, deferred: 1 });

    const inbox = await request(app.server)
      .get(`/v1/messages/inbox/${recipient.body.user.id}`)
      .set('Authorization', `Bearer ${recipient.body.token}`);
    expect(inbox.status).toBe(200);
    expect(Array.isArray(inbox.body.messages)).toBe(true);
    expect(inbox.body.messages.length).toBe(1);

    sendNotification.mockRestore();
    await app.close();
  });
});
