import {
  getChainEventCheckpoints,
  getDeliveryJobStats,
  getOldestPendingDeliveryJob,
  getPendingDeliveryJobs,
} from './db';
import { env } from '../config/env';
import { getTraces } from './tracing';
import { getLatestBlockNumber } from '../services/chain';

export type ObservabilityLevel = 'ok' | 'warn' | 'alert';

export type ObservabilityAlert = {
  level: ObservabilityLevel;
  code: string;
  metric: string;
  value: number;
  threshold: number;
  summary: string;
};

export type ObservabilitySnapshot = {
  generatedAt: string;
  traces: {
    enabled: boolean;
    sampleCount: number;
    lastTrace: string | null;
  };
  deliveryJobs: {
    pending: number;
    processing: number;
    done: number;
    failed: number;
    deadLetter: number;
  };
  alerts: {
    total: number;
    warn: number;
    alert: number;
  };
  thresholds: {
    pendingDeliveryJobs: number;
    failedDeliveryJobs: number;
    pendingDeliveryAgeMs: number;
    indexerLagBlocks: number;
  };
  pendingDeliveryAgeMs: number | null;
  indexerLagMax: number | null;
  indexerLag: Array<{
    chainKey: string;
    latestBlock: number | null;
    checkpoint: number;
    lag: number | null;
  }>;
};

export type ObservabilityDeliveryChecks = {
  pendingDeliveryJobs: number;
  failedDeliveryJobs: number;
  pendingDeliveryAgeMs: number | null;
  indexerLagMax: number | null;
  failedDeliveryJobsThreshold: number;
  pendingDeliveryJobsThreshold: number;
  pendingDeliveryAgeMsThreshold: number;
  indexerLagBlocksThreshold: number;
};

type WebhookPayload = {
  generatedAt: string;
  alerts: ObservabilityAlert[];
  snapshot: ObservabilitySnapshot;
};

export async function evaluateDeliveryAlerts() {
  const stats = await getDeliveryJobStats();
  const pendingJobs = await getPendingDeliveryJobs(1);
  const oldestPendingJob = pendingJobs[0] ?? (await getOldestPendingDeliveryJob());
  const pendingDeliveryAgeMs = oldestPendingJob ? Math.max(0, Date.now() - Number(oldestPendingJob.created_at)) : null;
  const indexerLagMax = await evaluateIndexerLag();
  const alerts: ObservabilityAlert[] = [];

  if (stats.pending > env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD) {
    alerts.push({
      level: 'warn',
      code: 'delivery_backlog',
      metric: 'mmp_delivery_jobs_pending_total',
      value: stats.pending,
      threshold: env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD,
      summary: `Pending delivery jobs (${stats.pending}) exceed threshold (${env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD}).`,
    });
  }

  if (stats.failed > env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD) {
    alerts.push({
      level: 'alert',
      code: 'delivery_failures',
      metric: 'mmp_delivery_jobs_failed_total',
      value: stats.failed,
      threshold: env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD,
      summary: `Failed delivery jobs (${stats.failed}) exceed threshold (${env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD}).`,
    });
  }

  const deadLetterThreshold = 1;
  if (stats.deadLetter >= deadLetterThreshold) {
    alerts.push({
      level: 'alert',
      code: 'delivery_dead_letter',
      metric: 'mmp_delivery_jobs_failed_total',
      value: stats.deadLetter,
      threshold: deadLetterThreshold,
      summary: `Dead-letter delivery jobs are present (${stats.deadLetter}).`,
    });
  }

  if (pendingDeliveryAgeMs !== null && pendingDeliveryAgeMs > env.ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD) {
    alerts.push({
      level: 'alert',
      code: 'delivery_pending_age',
      metric: 'mmp_delivery_jobs_oldest_pending_age_ms',
      value: pendingDeliveryAgeMs,
      threshold: env.ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD,
      summary: `Oldest pending delivery job age (${Math.round(pendingDeliveryAgeMs)}ms) exceeds threshold (${env.ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD}ms).`,
    });
  }

  const lagAlerts = await evaluateIndexerLagAlerts();
  alerts.push(...lagAlerts);

  return { alerts, checks: {
    pendingDeliveryJobs: stats.pending,
    failedDeliveryJobs: stats.failed,
    pendingDeliveryAgeMs,
    indexerLagMax,
    failedDeliveryJobsThreshold: env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD,
    pendingDeliveryJobsThreshold: env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD,
    pendingDeliveryAgeMsThreshold: env.ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD,
    indexerLagBlocksThreshold: env.ALERT_INDEXER_LAG_BLOCKS_THRESHOLD,
  } };
}

type ChainIndexLag = {
  chainKey: string;
  latestBlock: number | null;
  checkpoint: number;
  lag: number | null;
};

async function evaluateIndexerLag() {
  const checkpoints = await getChainEventCheckpoints();
  if (!checkpoints.length || !env.CHAIN_RPC_URL) {
    return null;
  }
  const latestBlock = await getLatestBlockNumber(env.CHAIN_RPC_URL);
  if (!latestBlock) {
    return null;
  }
  let maxLag: number | null = null;
  for (const checkpoint of checkpoints) {
    const parsedCheckpoint = Number(checkpoint.last_processed_block);
    const lag = latestBlock - parsedCheckpoint;
    if (Number.isFinite(lag) && (maxLag === null || lag > maxLag)) {
      maxLag = lag;
    }
  }
  return maxLag;
}

async function evaluateIndexerLagAlerts() {
  const alerts: ObservabilityAlert[] = [];
  const checkpoints = await getChainEventCheckpoints();
  if (!checkpoints.length || !env.CHAIN_RPC_URL) {
    return alerts;
  }
  const latestBlock = await getLatestBlockNumber(env.CHAIN_RPC_URL);
  if (!latestBlock) {
    return alerts;
  }
  for (const checkpoint of checkpoints) {
    const checkpointBlock = Number(checkpoint.last_processed_block);
    const lag = latestBlock - checkpointBlock;
    if (Number.isFinite(lag) && lag > env.ALERT_INDEXER_LAG_BLOCKS_THRESHOLD) {
      alerts.push({
        level: 'warn',
        code: 'indexer_lag',
        metric: 'mmp_indexer_lag_blocks',
        value: lag,
        threshold: env.ALERT_INDEXER_LAG_BLOCKS_THRESHOLD,
        summary: `Indexer lag for ${checkpoint.chain_key} is ${lag} blocks.`,
      });
    }
  }
  return alerts;
}

function lastTraceId(traces: Array<{ traceId: string }>) {
  const latest = traces[traces.length - 1];
  return latest?.traceId ?? null;
}

export async function getObservabilitySnapshot(): Promise<ObservabilitySnapshot> {
  const stats = await getDeliveryJobStats();
  const traces = getTraces(Math.max(1, env.TRACE_MAX_SPANS));
  const oldestPending = await getOldestPendingDeliveryJob();
  const pendingDeliveryAgeMs = oldestPending ? Math.max(0, Date.now() - Number(oldestPending.created_at)) : null;
  const indexerLagMax = await evaluateIndexerLag();
  const lagDetails = await getIndexerLagDetails();
  return {
    generatedAt: new Date().toISOString(),
    traces: {
      enabled: env.TRACE_ENABLED,
      sampleCount: traces.length,
      lastTrace: lastTraceId(traces as Array<{ traceId: string }>),
    },
    deliveryJobs: {
      pending: stats.pending,
      processing: stats.processing,
      done: stats.done,
      failed: stats.failed,
      deadLetter: stats.deadLetter,
    },
    alerts: {
      total: 0,
      warn: 0,
      alert: 0,
    },
    thresholds: {
      pendingDeliveryJobs: env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD,
      failedDeliveryJobs: env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD,
      pendingDeliveryAgeMs: env.ALERT_PENDING_DELIVERY_AGE_MS_THRESHOLD,
      indexerLagBlocks: env.ALERT_INDEXER_LAG_BLOCKS_THRESHOLD,
    },
    pendingDeliveryAgeMs,
    indexerLagMax,
    indexerLag: lagDetails,
  };
}

async function getIndexerLagDetails(): Promise<ChainIndexLag[]> {
  const checkpoints = await getChainEventCheckpoints();
  if (!checkpoints.length || !env.CHAIN_RPC_URL) {
    return [];
  }
  const latestBlock = await getLatestBlockNumber(env.CHAIN_RPC_URL);
  if (!latestBlock) {
    return checkpoints.map((checkpoint) => ({
      chainKey: checkpoint.chain_key,
      latestBlock: null,
      checkpoint: Number(checkpoint.last_processed_block),
      lag: null,
    }));
  }
  return checkpoints.map((checkpoint) => {
    const checkpointBlock = Number(checkpoint.last_processed_block);
    const lag = latestBlock - checkpointBlock;
    return {
      chainKey: checkpoint.chain_key,
      latestBlock,
      checkpoint: checkpointBlock,
      lag: Number.isFinite(lag) ? lag : null,
    };
  });
}

export async function getObservabilityHealth() {
  const result = await evaluateDeliveryAlerts();
  const snapshot = await getObservabilitySnapshot();
  snapshot.alerts = {
    total: result.alerts.length,
    warn: result.alerts.filter((alert) => alert.level === 'warn').length,
    alert: result.alerts.filter((alert) => alert.level === 'alert').length,
  };
  snapshot.thresholds = {
    pendingDeliveryJobs: result.checks.pendingDeliveryJobsThreshold,
    failedDeliveryJobs: result.checks.failedDeliveryJobsThreshold,
    pendingDeliveryAgeMs: result.checks.pendingDeliveryAgeMsThreshold,
    indexerLagBlocks: result.checks.indexerLagBlocksThreshold,
  };
  return { snapshot, alerts: result.alerts, checks: result.checks };
}

export async function sendObservabilityAlerts() {
  if (!env.OBSERVABILITY_ALERT_WEBHOOK_URL) {
    return false;
  }
  const payload = await buildObservabilityAlertPayload();
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (env.OBSERVABILITY_ALERT_TOKEN) {
    headers.authorization = `Bearer ${env.OBSERVABILITY_ALERT_TOKEN}`;
  }
  try {
    const response = await fetch(env.OBSERVABILITY_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function buildObservabilityAlertPayload(): Promise<WebhookPayload> {
  const { alerts, checks } = await evaluateDeliveryAlerts();
  const snapshot = await getObservabilitySnapshot();
  snapshot.alerts = {
    total: alerts.length,
    warn: alerts.filter((alert) => alert.level === 'warn').length,
    alert: alerts.filter((alert) => alert.level === 'alert').length,
  };
  snapshot.thresholds = {
    pendingDeliveryJobs: checks.pendingDeliveryJobsThreshold,
    failedDeliveryJobs: checks.failedDeliveryJobsThreshold,
    pendingDeliveryAgeMs: checks.pendingDeliveryAgeMsThreshold,
    indexerLagBlocks: checks.indexerLagBlocksThreshold,
  };
  return {
    generatedAt: snapshot.generatedAt,
    alerts,
    snapshot,
  };
}

export async function maybeSendObservabilityAlerts() {
  if (!env.OBSERVABILITY_ALERT_WEBHOOK_URL) {
    return false;
  }
  const payload = await buildObservabilityAlertPayload();
  if (!payload.alerts.length) {
    return false;
  }
  return sendObservabilityAlertsFromPayload(payload);
}

async function sendObservabilityAlertsFromPayload(payload: WebhookPayload): Promise<boolean> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (env.OBSERVABILITY_ALERT_TOKEN) {
    headers.authorization = `Bearer ${env.OBSERVABILITY_ALERT_TOKEN}`;
  }
  try {
    const response = await fetch(env.OBSERVABILITY_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    return response.ok;
  } catch {
    return false;
  }
}
