import {
  createUser,
  createMessageDeliveryJob,
  claimDueDeliveryJobs,
  getDeliveryJobsForMessage,
  resetStore,
} from '../src/lib/db';
import { runDeliveryWorkerOnce } from '../src/workers/delivery.worker';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

async function getLatestJob(messageId: string) {
  const jobs = await getDeliveryJobsForMessage(messageId);
  expect(jobs.length).toBeGreaterThan(0);
  return jobs[0];
}

describe('delivery worker', () => {
  beforeEach(() => {
    return resetStore();
  });

  it('requires redis when distributed mode is enabled', async () => {
    await withEnv({ WORKER_DISTRIBUTED: true, REDIS_URL: '' }, async () => {
      await createUser('0x3333333333333333333333333333333333333333');
      await expect(claimDueDeliveryJobs('delivery-worker-no-redis')).rejects.toThrow(
        'distributed worker mode requires REDIS_URL for delivery worker',
      );
    });
  });

  it('marks queued jobs as done when notification succeeds', async () => {
    const recipient = await createUser('0x1111111111111111111111111111111111111111');

    const job = await createMessageDeliveryJob({
      messageId: 'message-success-1',
      userId: recipient.id,
      channel: 'in_app',
      destination: '@recipient',
      payload: { subject: 'New paid message' },
    });

    const result = await runDeliveryWorkerOnce('delivery-worker-test', 10);

    const processed = await getLatestJob(job.message_id);
    expect(result).toEqual({ claimed: 1, done: 1, failed: 0, deferred: 0 });
    expect(processed.status).toBe('done');
    expect(processed.error_text).toBeNull();
    expect(processed.attempts).toBe(1);
  });

  it('defers failed jobs with retry information', async () => {
    const recipient = await createUser('0x2222222222222222222222222222222222222222');

    const job = await createMessageDeliveryJob({
      messageId: 'message-fail-defer',
      userId: recipient.id,
      channel: 'email',
      destination: 'alice@example.com',
      payload: { subject: 'New paid message' },
    });

    const nowBefore = Date.now();
    const result = await runDeliveryWorkerOnce('delivery-worker-test', 10);

    const processed = await getLatestJob(job.message_id);
    expect(result).toEqual({ claimed: 1, done: 0, failed: 1, deferred: 1 });
    expect(processed.status).toBe('pending');
    expect(processed.error_text).toBe('unsupported_channel:email');
    expect(processed.attempts).toBe(1);
    expect(processed.next_attempt_at).toBeGreaterThan(nowBefore);
    expect(processed.locked_by).toBeNull();
  });

  it('moves jobs to failed after attempts exceed max retries', async () => {
    const recipient = await createUser('0x3333333333333333333333333333333333333333');

    const job = await createMessageDeliveryJob({
      messageId: 'message-fail-terminal',
      userId: recipient.id,
      channel: 'email',
      destination: 'alice@example.com',
      payload: { subject: 'New paid message' },
      maxAttempts: 1,
    });

    const result = await runDeliveryWorkerOnce('delivery-worker-test', 10);

    const processed = await getLatestJob(job.message_id);
    expect(result).toEqual({ claimed: 1, done: 0, failed: 1, deferred: 0 });
    expect(processed.status).toBe('failed');
    expect(processed.error_text).toContain('max_retries_reached:unsupported_channel:email');
    expect(processed.attempts).toBe(1);
    expect(processed.locked_by).toBeNull();
  });
});
