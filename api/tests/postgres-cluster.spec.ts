import request from 'supertest';
import { env } from '../src/config/env';
import { closeRedisClient } from '../src/lib/redis';
import {
  claimDueDeliveryJobs,
  createMessageDeliveryJob,
  createUser,
  getChainEventCheckpoint,
  getDeliveryJobsForMessage,
  queueNotificationJobsForMessage,
  resetStore,
  saveChainEvent,
  setChainEventCheckpoint,
} from '../src/lib/db';
import { createServer } from '../src/index';
import { syncMessagePaidEvents } from '../src/workers/indexer';
import { closePostgresPool, queryPostgres } from '../src/lib/postgres';
import * as chain from '../src/services/chain';

type MessagePaidEvent = Awaited<ReturnType<typeof chain.fetchMessagePaidEvents>>[number];

const isIntegrationEnabled = process.env.MMP_POSTGRES_STACK === '1';
const POSTGRES_TABLES_REQUIRED = [
  'abuse_counters',
  'abuse_blocks',
  'abuse_events',
  'custodial_wallets',
  'users',
  'verification_codes',
  'pricing_profiles',
  'messages',
  'channel_connections',
  'vault_audit_log',
  'vault_blobs',
  'message_idempotency',
  'delivery_jobs',
  'chain_events',
  'chain_event_checkpoints',
  'identity_bindings',
  'passkey_credentials',
  'schema_migrations',
];

function makeDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

function guardEnabled(testName: string, fn: () => any) {
  if (!isIntegrationEnabled) {
    return it.skip(testName, fn);
  }
  return it(testName, fn);
}

describe('postgres cluster integration', () => {
  beforeEach(() => {
    return resetStore();
  });

  afterEach(async () => {
    if (env.WORKER_DISTRIBUTED && env.REDIS_URL) {
      await closeRedisClient();
    }
  });

  guardEnabled('writes data with postgres schema migrations and checkpoint semantics', async () => {
    const app = await createServer();
    const reg = await request(app.server).post('/v1/auth/register').send({
      walletAddress: '0xAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaAAA',
    });
    expect(reg.status).toBe(200);

    const user = await createUser('0xBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbB');
    await setChainEventCheckpoint('1:0xcccccccccccccccccccccccccccccccccccccccc', 10);
    const checkpoint = await getChainEventCheckpoint('1:0xcccccccccccccccccccccccccccccccccccccccc');
    expect(checkpoint).toBe(10);

    await saveChainEvent({
      chainKey: '1:0xcccccccccccccccccccccccccccccccccccccccc',
      blockNumber: 11,
      blockHash: '0x1111',
      txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
      logIndex: 0,
      messageId: 'msg-one',
      payer: reg.body.user.walletAddress,
      recipient: user.wallet_address,
      amount: 1000000,
      fee: 100,
      contentHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      nonce: 1,
      channel: 1,
      observedAt: Date.now(),
    });

    const result = await syncMessagePaidEvents({
      rpcUrl: 'http://localhost:8545',
      vaultAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      chainId: 1,
      decimals: 6,
      startBlock: 0,
      endBlock: 11,
    });

    expect(result).toEqual({ polled: 0, processed: 0, inserted: 0, checkpoint: 11 });
    await app.close();
  });

  guardEnabled('prevents delivery-job duplication with concurrent claim attempts', async () => {
    const recipient = await createUser('0xdddddddddddddddddddddddddddddddddddddddd');
    await createMessageDeliveryJob({
      messageId: 'message-concurrency-test',
      userId: recipient.id,
      channel: 'telegram',
      destination: '@recipient',
      payload: { subject: 'preexisting delivery test' },
    });

    await queueNotificationJobsForMessage({
      messageId: 'message-concurrency-test',
      recipientId: recipient.id,
      recipientWallet: recipient.wallet_address,
      price: 100,
      txHash: '0x2222',
    });

    const jobs = await getDeliveryJobsForMessage('message-concurrency-test');
    expect(jobs).toHaveLength(1);

    const [resultA, resultB] = await Promise.all([
      claimDueDeliveryJobs('worker-a', 10),
      claimDueDeliveryJobs('worker-b', 10),
    ]);

    const allClaimed = [...resultA, ...resultB].map((job) => job.id);
    const uniqueIds = new Set(allClaimed);
    expect(uniqueIds.size).toBe(allClaimed.length);

    const delivered = await getDeliveryJobsForMessage('message-concurrency-test');
    const claimedCount = delivered.filter((job) => job.status === 'processing').length;
    expect(claimedCount).toBeLessThanOrEqual(1);
  });

  guardEnabled('serializes advisory-lock guarded startup migrations across parallel api servers', async () => {
    const start = await Promise.all([createServer(), createServer(), createServer()]);
    try {
      for (const app of start) {
        const health = await request(app.server).get('/health');
        expect(health.status).toBe(200);
      }

      const rows = await queryPostgres<{ table_name: string }>(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_name = ANY($2::text[])',
        ['public', POSTGRES_TABLES_REQUIRED],
      );
      const foundTables = new Set(rows.map((row) => row.table_name));
      for (const name of POSTGRES_TABLES_REQUIRED) {
        expect(foundTables.has(name)).toBe(true);
      }
    } finally {
      await Promise.all(start.map((app) => app.close()));
    }
  });

  guardEnabled('waits for direct postgres queries to finish when closing pool', async () => {
    const sleepQuery = queryPostgres<{ pg_sleep: string }>('SELECT pg_sleep(0.4) AS pg_sleep');
    await Promise.all([sleepQuery, closePostgresPool()]);
    await expect(sleepQuery).resolves.toHaveLength(1);
    await expect(queryPostgres('SELECT 1 as ping')).resolves.toHaveLength(1);
  });

  guardEnabled('prevents duplicate indexer processing with distributed lock contention', async () => {
    const wasDistributedEnabled = env.WORKER_DISTRIBUTED && Boolean(env.REDIS_URL);
    const recipient = await createUser('0x9999999999999999999999999999999999999999');
    const sender = await createUser('0x8888888888888888888888888888888888888888');

    const started = makeDeferred();
    const proceed = makeDeferred();
    let fetchCount = 0;
    const spy = jest.spyOn(chain, 'fetchMessagePaidEvents');
    spy.mockImplementation(async () => {
      fetchCount += 1;
      started.resolve();
      await proceed.promise;

      const event: MessagePaidEvent = {
        txHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        blockNumber: 11,
        blockHash: '0xdead',
        logIndex: 0,
        chainId: 1,
        payer: sender.wallet_address,
        recipient: recipient.wallet_address,
        messageId: '0x11111111111111111111111111111111',
        amount: 1000,
        fee: 100,
        contentHash: `0x${'22'.repeat(32)}`,
        nonce: 1,
        channel: 1,
      };
      return [
        {
          ...event,
          txHash: event.txHash,
          chainId: event.chainId,
          blockHash: event.blockHash,
          logIndex: event.logIndex,
          payer: event.payer,
          recipient: event.recipient,
          messageId: event.messageId,
          amount: event.amount,
          fee: event.fee,
          contentHash: event.contentHash,
          nonce: event.nonce,
          channel: event.channel,
        } as MessagePaidEvent,
      ];
    });

    const first = syncMessagePaidEvents({
      rpcUrl: 'http://localhost:8545',
      vaultAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      chainId: 1,
      decimals: 6,
      startBlock: 0,
      endBlock: 11,
    });
    const second = (async () => {
      await started.promise;
      return syncMessagePaidEvents({
        rpcUrl: 'http://localhost:8545',
        vaultAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
        chainId: 1,
        decimals: 6,
        startBlock: 0,
        endBlock: 11,
      });
    })();

    await started.promise;
    proceed.resolve();

    const [firstResult, secondResult] = await Promise.all([first, second]);

    proceed.resolve();
    spy.mockRestore();

    expect(fetchCount).toBe(1);
    expect(firstResult.checkpoint).toBe(11);
    if (wasDistributedEnabled) {
      expect(secondResult.checkpoint).toBeNull();
    } else {
      expect(secondResult.checkpoint).toBe(11);
    }
  });

  guardEnabled('indexes jobs and checkpoints without in-memory state', async () => {
    const sender = await createUser('0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee');
    const recipient = await createUser('0xfffffffffffffffffffffffffffffffffffffffe');
    await createMessageDeliveryJob({
      messageId: 'message-db-index',
      userId: recipient.id,
      channel: 'telegram',
      destination: '@recipient',
      payload: { subject: 'paid', amount: 100 },
    });
    const jobs = await getDeliveryJobsForMessage('message-db-index');
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');

    await setChainEventCheckpoint(`${1}:${sender.wallet_address}`, 100);
    const checkpoint = await getChainEventCheckpoint(`${1}:${sender.wallet_address}`);
    expect(checkpoint).toBe(100);
  });
});
