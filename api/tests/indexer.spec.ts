jest.mock('../src/services/chain', () => {
  const actual = jest.requireActual('../src/services/chain');
  return {
    ...actual,
    fetchMessagePaidEvents: jest.fn(),
  };
});

import { syncMessagePaidEvents } from '../src/workers/indexer';
import * as chain from '../src/services/chain';
import { closeRedisClient } from '../src/lib/redis';
import {
  createMessage,
  createUser,
  saveChannelConnection,
  getChainEventCheckpoint,
  getDeliveryJobsForMessage,
  getMessageByMessageId,
  resetStore,
  setChainEventCheckpoint,
} from '../src/lib/db';
import { env } from '../src/config/env';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

const fetchMessagePaidEvents = chain.fetchMessagePaidEvents as jest.MockedFunction<
  typeof chain.fetchMessagePaidEvents
>;

const CHAIN_ID = 1;
const VAULT_ADDRESS = '0x00000000000000000000000000000000000000aA';
const CHAIN_KEY = `${CHAIN_ID}:${VAULT_ADDRESS.toLowerCase()}`;

type ChainMessagePaidEvent = Awaited<ReturnType<typeof chain.fetchMessagePaidEvents>>[number];

function chainEvent(overrides: Partial<ChainMessagePaidEvent> = {}) {
  return {
    txHash: '0x1111111111111111111111111111111111111111111111111111111111111111',
    blockNumber: 10,
    blockHash: '0x2222222222222222222222222222222222222222222222222222222222222222',
    logIndex: 0,
    chainId: CHAIN_ID,
    payer: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    messageId: `0x${'ab'.repeat(32)}`,
    amount: 1500000,
    fee: 500,
    contentHash: `0x${'cc'.repeat(32)}`,
    nonce: 1,
    channel: 1,
    ...overrides,
  };
}

describe('chain indexer', () => {
  beforeEach(async () => {
    await resetStore();
    fetchMessagePaidEvents.mockReset();
  });

  afterEach(async () => {
    if (env.WORKER_DISTRIBUTED && env.REDIS_URL) {
      await closeRedisClient();
    }
  });

  it('requires redis when distributed mode is enabled', async () => {
    await withEnv({ WORKER_DISTRIBUTED: true, REDIS_URL: '' }, async () => {
      await expect(
        syncMessagePaidEvents({
          rpcUrl: 'http://localhost:8545',
          vaultAddress: VAULT_ADDRESS,
          chainId: CHAIN_ID,
          decimals: 6,
          startBlock: 0,
          endBlock: 10,
        }),
      ).rejects.toThrow('distributed worker mode requires REDIS_URL for indexer worker');
    });
  });

  it('creates delivered messages and checkpoints after processing MessagePaid events', async () => {
    const payer = await createUser('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const recipient = await createUser('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await saveChannelConnection(recipient.id, 'telegram', {
      externalHandle: '@recipient',
      secretRef: null,
      consentVersion: 'v1',
      status: 'connected',
    });
    const messageEvent = chainEvent({
      payer: payer.wallet_address,
      recipient: recipient.wallet_address,
      txHash: '0x4444444444444444444444444444444444444444444444444444444444444444',
    });

    fetchMessagePaidEvents.mockResolvedValue([messageEvent]);

    const result = await syncMessagePaidEvents({
      rpcUrl: 'http://localhost:8545',
      vaultAddress: VAULT_ADDRESS,
      chainId: CHAIN_ID,
      decimals: 6,
      startBlock: 0,
      endBlock: 10,
    });

    const normalizedId = messageEvent.messageId.slice(2);
    const storedMessage = await getMessageByMessageId(normalizedId);
    expect(result).toEqual({ polled: 1, processed: 1, inserted: 1, checkpoint: 10 });
    expect(storedMessage).not.toBeNull();
    expect(storedMessage?.status).toBe('delivered');
    expect(storedMessage?.sender_id).toBe(payer.id);
    expect(storedMessage?.recipient_id).toBe(recipient.id);

    const jobs = await getDeliveryJobsForMessage(normalizedId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending');
    expect(jobs[0].channel).toBe('telegram');
    expect(jobs[0].destination).toBe('@recipient');

    expect(await getChainEventCheckpoint(CHAIN_KEY)).toBe(10);
  });

  it('normalizes existing paid messages to delivered and keeps notification jobs idempotent', async () => {
    const payer = await createUser('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const recipient = await createUser('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    await saveChannelConnection(recipient.id, 'telegram', {
      externalHandle: '@recipient',
      secretRef: null,
      consentVersion: 'v1',
      status: 'connected',
    });
    const messageId = `${'de'.repeat(16)}`;

    await createMessage({
      messageId,
      senderId: payer.id,
      recipientId: recipient.id,
      ciphertext: 'encrypted:local',
      contentHash: `0x${'dd'.repeat(32)}`,
      price: 42,
      status: 'paid',
      txHash: null,
    });

    const messageEvent = chainEvent({
      payer: payer.wallet_address,
      recipient: recipient.wallet_address,
      messageId: `0x${messageId}`,
      blockNumber: 20,
    });

    await setChainEventCheckpoint(CHAIN_KEY, 19);
    fetchMessagePaidEvents.mockResolvedValue([messageEvent]);

    const result = await syncMessagePaidEvents({
      rpcUrl: 'http://localhost:8545',
      vaultAddress: VAULT_ADDRESS,
      chainId: CHAIN_ID,
      decimals: 6,
      startBlock: 0,
      endBlock: 20,
    });

    const storedMessage = await getMessageByMessageId(messageId);
    expect(result).toEqual({ polled: 1, processed: 1, inserted: 0, checkpoint: 20 });
    expect(storedMessage?.status).toBe('delivered');

    const jobs = await getDeliveryJobsForMessage(messageId);
    expect(jobs).toHaveLength(1);

    await setChainEventCheckpoint(CHAIN_KEY, 19);
    fetchMessagePaidEvents.mockResolvedValue([messageEvent]);
    const secondRun = await syncMessagePaidEvents({
      rpcUrl: 'http://localhost:8545',
      vaultAddress: VAULT_ADDRESS,
      chainId: CHAIN_ID,
      decimals: 6,
      startBlock: 0,
      endBlock: 20,
    });

    expect(secondRun).toEqual({ polled: 1, processed: 1, inserted: 0, checkpoint: 20 });
    expect(await getDeliveryJobsForMessage(messageId)).toHaveLength(1);
  });

  it('skips notification jobs when channel consent is stale', async () => {
    await withEnv({ REQUIRE_SOCIAL_TOS_ACCEPTED: true, LEGAL_TOS_VERSION: 'v2', LEGAL_TOS_APPROVED_AT: '2026-02-13T00:00:00Z' }, async () => {
      const payer = await createUser('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      const recipient = await createUser('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

      await saveChannelConnection(recipient.id, 'whatsapp', {
        externalHandle: '+15550000000',
        secretRef: null,
        consentVersion: 'v1',
        consentAcceptedAt: 0,
        status: 'connected',
      });
      const messageId = `${'fb'.repeat(16)}`;

      const messageEvent = chainEvent({
        payer: payer.wallet_address,
        recipient: recipient.wallet_address,
        messageId: `0x${messageId}`,
        blockNumber: 25,
        txHash: '0x5555555555555555555555555555555555555555555555555555555555555555',
      });

      fetchMessagePaidEvents.mockResolvedValue([messageEvent]);

      const result = await syncMessagePaidEvents({
        rpcUrl: 'http://localhost:8545',
        vaultAddress: VAULT_ADDRESS,
        chainId: CHAIN_ID,
        decimals: 6,
        startBlock: 0,
        endBlock: 25,
      });

      expect(result).toEqual({ polled: 1, processed: 1, inserted: 1, checkpoint: 25 });
      const jobs = await getDeliveryJobsForMessage(messageId);
      expect(jobs).toHaveLength(0);
    });
  });

  it('processes notification jobs after consent version is updated to current', async () => {
    await withEnv({ REQUIRE_SOCIAL_TOS_ACCEPTED: true, LEGAL_TOS_VERSION: 'v2', LEGAL_TOS_APPROVED_AT: '2026-02-13T00:00:00Z' }, async () => {
      const payer = await createUser('0xcccccccccccccccccccccccccccccccccccccccc');
      const recipient = await createUser('0xdddddddddddddddddddddddddddddddddddddddd');

      await saveChannelConnection(recipient.id, 'whatsapp', {
        externalHandle: '+15550000001',
        secretRef: null,
        consentVersion: 'v1',
        consentAcceptedAt: 0,
        status: 'connected',
      });

      const messageId = `${'fc'.repeat(16)}`;

      const createEvent = () =>
        chainEvent({
          payer: payer.wallet_address,
          recipient: recipient.wallet_address,
          messageId: `0x${messageId}`,
          blockNumber: 40,
          txHash: '0x6666666666666666666666666666666666666666666666666666666666666666',
        });

      fetchMessagePaidEvents.mockResolvedValue([createEvent()]);

      let result = await syncMessagePaidEvents({
        rpcUrl: 'http://localhost:8545',
        vaultAddress: VAULT_ADDRESS,
        chainId: CHAIN_ID,
        decimals: 6,
        startBlock: 0,
        endBlock: 40,
      });
      expect(result).toEqual({ polled: 1, processed: 1, inserted: 1, checkpoint: 40 });
      let jobs = await getDeliveryJobsForMessage(messageId);
      expect(jobs).toHaveLength(0);

      await setChainEventCheckpoint(CHAIN_KEY, 39);
      await saveChannelConnection(recipient.id, 'whatsapp', {
        externalHandle: '+15550000001',
        secretRef: null,
        consentVersion: env.LEGAL_TOS_VERSION,
        consentAcceptedAt: 1700000000000,
        status: 'connected',
      });

      fetchMessagePaidEvents.mockResolvedValue([createEvent()]);
      result = await syncMessagePaidEvents({
        rpcUrl: 'http://localhost:8545',
        vaultAddress: VAULT_ADDRESS,
        chainId: CHAIN_ID,
        decimals: 6,
        startBlock: 0,
        endBlock: 40,
      });
      expect(result).toEqual({ polled: 1, processed: 1, inserted: 0, checkpoint: 40 });
      jobs = await getDeliveryJobsForMessage(messageId);
      expect(jobs).toHaveLength(1);
    });
  });
});
