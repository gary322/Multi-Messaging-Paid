import {
  createMessage,
  findUserByWallet,
  getMessageByMessageId,
  getChainEventCheckpoint,
  indexerLockKey,
  setChainEventCheckpoint,
  saveChainEvent,
  updateMessageStatus,
  queueNotificationJobsForMessage,
} from '../lib/db';
import { fetchMessagePaidEvents, getLatestBlockNumber } from '../services/chain';
import { incrementCounter, observeDuration, setGauge } from '../lib/metrics';
import {
  assertRedisForDistributedWorkersOrThrow,
  isRedisEnabled,
  releaseDistributedLock,
  tryAcquireDistributedLock,
} from '../lib/redis';
import { withSpan } from '../lib/tracing';
import { env } from '../config/env';

function normalizeMessageId(messageId: string) {
  return messageId.startsWith('0x') ? messageId.slice(2) : messageId;
}

function chainKey(chainId: number, vaultAddress: string) {
  return `${chainId}:${vaultAddress.toLowerCase()}`;
}

type IndexerConfig = {
  rpcUrl: string;
  vaultAddress: string;
  chainId: number;
  startBlock?: number;
  endBlock?: number;
  decimals: number;
};

export async function syncMessagePaidEvents(config: IndexerConfig) {
  const start = Date.now();
  const vaultAddress = config.vaultAddress.toLowerCase();
  const chainId = config.chainId;
  const key = chainKey(chainId, vaultAddress);
  const traceId = `idx:${key}`;

  return withSpan(
    'indexer.syncMessagePaidEvents',
    traceId,
    { chainId: String(chainId), vaultAddress },
    async () => {
      if (env.WORKER_DISTRIBUTED) {
        assertRedisForDistributedWorkersOrThrow('indexer worker');
      }

      let lockToken: string | null = null;
      if (env.WORKER_DISTRIBUTED && isRedisEnabled()) {
        lockToken = await tryAcquireDistributedLock(indexerLockKey(key), env.INDEXER_WORKER_LOCK_TTL_MS);
        if (!lockToken) {
          incrementCounter('mmp_indexer_runs_total', { status: 'locked_skipped' });
          return { polled: 0, processed: 0, inserted: 0, checkpoint: null };
        }
      }

      try {
        const toBlock = config.endBlock ?? (await getLatestBlockNumber(config.rpcUrl));
        if (!toBlock) {
          incrementCounter('mmp_indexer_runs_total', { status: 'no-blocks' });
          return { polled: 0, processed: 0, inserted: 0, checkpoint: null };
        }
        setGauge('mmp_indexer_latest_block', { chain_key: key }, toBlock);

        const startFrom = await getChainEventCheckpoint(key);
        const fromBlock = Math.max(
          config.startBlock ?? 0,
          startFrom !== null ? startFrom + 1 : 0,
        );

        if (fromBlock > toBlock) {
          incrementCounter('mmp_indexer_runs_total', { status: 'ahead' });
          observeDuration('mmp_indexer_cycle_ms', { status: 'idle' }, Date.now() - start);
          setGauge('mmp_indexer_checkpoint_block', { chain_key: key }, toBlock);
          setGauge('mmp_indexer_lag_blocks', { chain_key: key }, 0);
          return { polled: 0, processed: 0, inserted: 0, checkpoint: toBlock };
        }

        const events = await fetchMessagePaidEvents({
          rpcUrl: config.rpcUrl,
          vaultAddress,
          fromBlock,
          toBlock,
          chainIdHint: chainId,
        });

        let processed = 0;
        let inserted = 0;
        for (const event of events) {
          await saveChainEvent({
            chainKey: key,
            blockNumber: event.blockNumber,
            blockHash: event.blockHash,
            txHash: event.txHash,
            logIndex: event.logIndex,
            messageId: normalizeMessageId(event.messageId),
            payer: event.payer,
            recipient: event.recipient,
            amount: Number(event.amount),
            fee: Number(event.fee),
            contentHash: event.contentHash,
            nonce: event.nonce,
            channel: event.channel,
            observedAt: Date.now(),
          });

          const payer = await findUserByWallet(event.payer);
          const recipient = await findUserByWallet(event.recipient);
          if (!payer || !recipient) {
            continue;
          }

          const messageId = normalizeMessageId(event.messageId);
          const existing = await getMessageByMessageId(messageId);
          const normalizedAmount = Number(event.amount / Math.pow(10, config.decimals));
          const dbAmount = normalizedAmount > 0 ? Math.floor(normalizedAmount) : 0;

          if (!existing) {
            await createMessage({
              messageId,
              senderId: payer.id,
              recipientId: recipient.id,
              ciphertext: 'encrypted:indexed',
              contentHash: event.contentHash,
              price: dbAmount,
              status: 'delivered',
              txHash: event.txHash,
            });
            inserted += 1;
            incrementCounter('mmp_indexer_events_inserted_total', { action: 'message_created' });
            await queueNotificationJobsForMessage({
              messageId,
              recipientId: recipient.id,
              recipientWallet: event.recipient,
              price: dbAmount,
              txHash: event.txHash,
            });
          } else {
            await updateMessageStatus(messageId, 'delivered', event.txHash);
            await queueNotificationJobsForMessage({
              messageId,
              recipientId: recipient.id,
              recipientWallet: event.recipient,
              price: dbAmount,
              txHash: event.txHash,
            });
          }
          processed += 1;
          incrementCounter('mmp_indexer_events_processed_total', { action: 'message_seen' });
        }

        await setChainEventCheckpoint(key, toBlock);
        setGauge('mmp_indexer_checkpoint_block', { chain_key: key }, toBlock);
        setGauge('mmp_indexer_lag_blocks', { chain_key: key }, 0);

        incrementCounter('mmp_indexer_runs_total', {
          status: 'success',
        });
        observeDuration('mmp_indexer_cycle_ms', { status: 'success' }, Date.now() - start);

        return {
          polled: events.length,
          processed,
          inserted,
          checkpoint: toBlock,
        };
      } finally {
        if (lockToken) {
          await releaseDistributedLock(indexerLockKey(key), lockToken);
        }
      }
    },
  );
}

export function createIndexerWorker(opts: {
  enabled?: boolean;
  rpcUrl: string;
  vaultAddress: string;
  chainId: number;
  decimals: number;
  pollIntervalMs?: number;
  startBlock?: number;
}) {
  const enabled = opts.enabled !== false;
  if (!enabled) {
    return { stop: async () => {} };
  }

  const pollIntervalMs = opts.pollIntervalMs || 10_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const run = async () => {
    if (stopped) {
      return;
    }

    const current = (async () => {
      try {
        await syncMessagePaidEvents({
          rpcUrl: opts.rpcUrl,
          vaultAddress: opts.vaultAddress,
          chainId: opts.chainId,
          decimals: opts.decimals,
          startBlock: opts.startBlock,
        });
      } catch {
        // Keep worker alive and retry in next cycle.
      }
    })();

    inFlight = current;
    try {
      await current;
    } finally {
      if (inFlight === current) {
        inFlight = null;
      }
    }

    if (!stopped) {
      timer = setTimeout(() => {
        void run();
      }, pollIntervalMs);
      // Tests often construct the server without binding a listening socket.
      // If a worker timer is still pending, we don't want it to keep the process alive.
      timer.unref();
    }
  };

  void run();

  return {
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
      }
      timer = null;
      if (inFlight) {
        await inFlight;
      }
    },
  };
}
