import {
  getDeliveryJobStats,
  markDeliveryJobDone,
  markDeliveryJobFailed,
  claimDueDeliveryJobs,
  type DeliveryJobRecord,
} from '../lib/db';
import { sendNotification } from '../services/notifications';
import { incrementCounter, observeDuration, setGauge } from '../lib/metrics';
import { withSpan } from '../lib/tracing';

type DeliveryWorkerOptions = {
  workerId: string;
  enabled?: boolean;
  pollIntervalMs?: number;
  batchSize?: number;
  stopAfterTicks?: number;
};

const BASE_RETRY_BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000, 60_000];
const NOOP_LOG = () => {};

function computeNextRetry(attempt: number) {
  const index = Math.min(attempt - 1, BASE_RETRY_BACKOFF_MS.length - 1);
  return BASE_RETRY_BACKOFF_MS[index];
}

export async function runDeliveryWorkerOnce(workerId: string, batchSize = 20) {
  const stats = await getDeliveryJobStats();
  setGauge('mmp_delivery_jobs_pending_total', {}, stats.pending);
  setGauge('mmp_delivery_jobs_processing_total', {}, stats.processing);
  setGauge('mmp_delivery_jobs_done_total', {}, stats.done);
  setGauge('mmp_delivery_jobs_failed_total', {}, stats.failed);
  setGauge('mmp_delivery_jobs_dead_letter_total', {}, stats.deadLetter);

  return withSpan(
    'delivery.runWorkerOnce',
    `delivery:${workerId}`,
    { workerId: workerId, batchSize },
    async () => {
      const start = Date.now();
      const jobs = await claimDueDeliveryJobs(workerId, batchSize);
      incrementCounter('mmp_delivery_worker_runs_total', { worker_id: workerId, action: 'start' });
      if (!jobs.length) {
        observeDuration('mmp_delivery_worker_cycle_ms', { worker_id: workerId }, Date.now() - start);
        return { claimed: 0, done: 0, failed: 0, deferred: 0 };
      }

      let done = 0;
      let failed = 0;
      let deferred = 0;

      for (const job of jobs as DeliveryJobRecord[]) {
        try {
          const payload = JSON.parse(job.payload_json || '{}');
          incrementCounter('mmp_delivery_jobs_claimed_total', { worker_id: workerId, channel: job.channel });
          const ok = await sendNotification(
            job.channel,
            job.destination,
            payload,
            () => NOOP_LOG(),
          );
          if (!ok?.ok) {
            failed += 1;
            incrementCounter('mmp_delivery_jobs_failed_total', {
              worker_id: workerId,
              channel: job.channel,
              reason: ok?.reason ? 'provider' : 'unknown',
            });
            const message = ok?.reason || 'delivery_failed';
            if (job.attempts >= job.max_attempts) {
              await markDeliveryJobFailed(job.id, `max_retries_reached:${message}`, null);
              incrementCounter('mmp_delivery_jobs_deadletter_total', { worker_id: workerId, channel: job.channel });
              continue;
            }
            const retryAfterMs = computeNextRetry(job.attempts);
            await markDeliveryJobFailed(job.id, message, Date.now() + retryAfterMs);
            deferred += 1;
            incrementCounter('mmp_delivery_jobs_retried_total', { worker_id: workerId, channel: job.channel });
            continue;
          }
          await markDeliveryJobDone(job.id);
          done += 1;
          incrementCounter('mmp_delivery_jobs_completed_total', { worker_id: workerId, channel: job.channel });
        } catch (error) {
          failed += 1;
          const message = error instanceof Error ? error.message : 'delivery_exception';
          if (job.attempts >= job.max_attempts) {
            await markDeliveryJobFailed(job.id, `max_retries_reached:${message}`, null);
            incrementCounter('mmp_delivery_jobs_failed_total', { worker_id: workerId, channel: job.channel, reason: 'max_retries' });
            continue;
          }
          const retryAfterMs = computeNextRetry(job.attempts);
          await markDeliveryJobFailed(job.id, message, Date.now() + retryAfterMs);
          incrementCounter('mmp_delivery_jobs_retried_total', { worker_id: workerId, channel: job.channel });
          deferred += 1;
        }
      }
      observeDuration('mmp_delivery_worker_cycle_ms', { worker_id: workerId }, Date.now() - start);

      return {
        claimed: jobs.length,
        done,
        failed,
        deferred,
      };
    },
  );
}

export function createDeliveryWorker(options: DeliveryWorkerOptions) {
  const enabled = options.enabled !== false;
  if (!enabled) {
    return { stop: async () => {} };
  }

  const workerId = options.workerId || 'delivery-worker-default';
  const batchSize = options.batchSize || 20;
  const pollIntervalMs = options.pollIntervalMs || 5_000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let tick = 0;
  let inFlight: Promise<void> | null = null;

  const loop = async () => {
    if (!running) return;

    const current = (async () => {
      try {
        await runDeliveryWorkerOnce(workerId, batchSize);
        tick += 1;
      } catch {
        // Keep worker alive; job failures are handled in runDeliveryWorkerOnce.
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

    if (running && (options.stopAfterTicks === undefined || tick < options.stopAfterTicks)) {
      timer = setTimeout(() => {
        void loop();
      }, pollIntervalMs);
      // In test environments (or when the API is constructed but not .listen()'d),
      // ensure background worker timers do not keep the Node process alive.
      timer.unref();
    }
  };

  void loop();

  return {
    async stop() {
      running = false;
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
