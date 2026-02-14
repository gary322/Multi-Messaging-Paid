import { closePostgresPool } from './lib/postgres';
import { closeRedisClient } from './lib/redis';
import { incrementCounter, observeDuration, setGauge } from './lib/metrics';
import { randomUUID } from 'node:crypto';
import { env } from './config/env';
import { assertLaunchReady } from './lib/launchReadiness';
import { migratePostgresSchema, resetStore } from './lib/db';
import { createDeliveryWorker } from './workers/delivery.worker';
import { createIndexerWorker } from './workers/indexer';
import { getChainId } from './services/chain';
import { closeChainClients } from './services/chain';
import { endSpan, getTraces, startSpan } from './lib/tracing';
import { maybeSendObservabilityAlerts } from './lib/observability';
import { shutdownOtelTracing, startOtelTracing } from './lib/otel';

export async function createServer() {
  await startOtelTracing();
  const fastify = await import('fastify').then((m) => m.default);
  const cors = await import('@fastify/cors').then((m) => m.default);
  const helmet = await import('@fastify/helmet').then((m) => m.default);
  const app = fastify({ logger: { level: env.NODE_ENV === 'production' ? 'info' : 'debug' } });

  if (env.LAUNCH_STARTUP_GATING) {
    await assertLaunchReady();
  }

  if (process.env.MMP_RESET_STORE === '1') {
    await resetStore();
  }

  app.register(cors);
  app.register(helmet);

  if (env.DATABASE_BACKEND === 'postgres' && env.DATABASE_MIGRATIONS_ON_START) {
    await migratePostgresSchema();
  }

  const routeModules = await Promise.all([
    import('./routes/auth'),
    import('./routes/passkeys'),
    import('./routes/socialAuth'),
    import('./routes/verification'),
    import('./routes/profile'),
    import('./routes/payments'),
    import('./routes/messages'),
    import('./routes/channels'),
    import('./routes/vault'),
    import('./routes/compliance'),
  ]);

  routeModules.forEach((m) => app.register(m.default));

  const startedWorkers: Array<{ stop: () => Promise<void> }> = [];
  let inflightRequests = 0;
  let metricsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let observabilityHeartbeatTimer: ReturnType<typeof setInterval> | null = null;

  if (env.CHAIN_INDEXER_ENABLED && env.CHAIN_RPC_URL && env.CHAIN_VAULT_ADDRESS) {
    const chainId = await getChainId(env.CHAIN_RPC_URL);
    const indexer = createIndexerWorker({
      enabled: true,
      rpcUrl: env.CHAIN_RPC_URL,
      vaultAddress: env.CHAIN_VAULT_ADDRESS,
      chainId,
      decimals: env.CHAIN_TOKEN_DECIMALS,
      pollIntervalMs: env.CHAIN_INDEXER_POLL_INTERVAL_MS,
      startBlock: env.CHAIN_START_BLOCK,
    });
    startedWorkers.push(indexer);
  }

  if (env.DELIVERY_WORKER_ENABLED) {
    const worker = createDeliveryWorker({
      enabled: true,
      workerId: 'api-delivery-worker',
      pollIntervalMs: env.DELIVERY_WORKER_POLL_INTERVAL_MS,
      batchSize: env.DELIVERY_WORKER_BATCH_SIZE,
    });
    startedWorkers.push(worker);
  }

  app.addHook('onClose', async () => {
    await Promise.all(startedWorkers.map((worker) => worker.stop()));
    if (metricsHeartbeatTimer) {
      clearInterval(metricsHeartbeatTimer);
    }
    if (observabilityHeartbeatTimer) {
      clearInterval(observabilityHeartbeatTimer);
    }
    await shutdownOtelTracing();
    await closeChainClients();
    await closeRedisClient();
    await closePostgresPool();
  });

  app.addHook('onRequest', (req, _reply, done) => {
    const startTime = Date.now();
    (req as any).mmpStartTime = startTime;
    const traceId = (req.headers['x-request-id'] as string) || randomUUID();
    (req.headers['x-request-id'] as string | undefined) = traceId;
    (req as any).mmpTraceId = traceId;
    (req as any).mmpRequestSpan = startSpan('http.request', {
      method: req.method,
      route: String(req.routeOptions?.url || req.url || 'unknown'),
    }, traceId);
    inflightRequests += 1;
    setGauge('mmp_http_inflight_requests', { service: 'api' }, inflightRequests);
    done();
  });

  app.addHook('onResponse', (req, reply, done) => {
    const start = (req as any).mmpStartTime;
    const route = String(req.routeOptions?.url || req.url || 'unknown');
    const method = req.method || 'UNKNOWN';
    const status = String(reply.statusCode || 200);
    const duration = Date.now() - (start || Date.now());
    inflightRequests = Math.max(0, inflightRequests - 1);
    setGauge('mmp_http_inflight_requests', { service: 'api' }, inflightRequests);
    incrementCounter('mmp_http_requests_total', { route, method, status, service: 'api' });
    observeDuration('mmp_http_request_duration_ms', { route, method, status, service: 'api' }, duration);
    void endSpan((req as any).mmpRequestSpan, reply.statusCode >= 400 ? 'error' : 'ok', {
      route,
      method,
      status,
      durationMs: duration,
    });
    reply.header('x-request-id', (req as any).mmpTraceId);
    done();
  });

  app.get('/v1/observability/traces', async (req, reply) => {
    if (!env.TRACE_ENABLED) {
      reply.status(404).send({ error: 'tracing_disabled' });
      return;
    }
    const q = (req.query as { limit?: string | number })?.limit;
    const parsed = typeof q === 'string' ? Number(q) : q;
    const limit = Number.isFinite(parsed as number) ? Number(parsed) : undefined;
    reply.send({ generatedAt: new Date().toISOString(), traces: getTraces(limit) });
  });

  metricsHeartbeatTimer = setInterval(() => {
    setGauge('mmp_process_uptime_seconds', { service: 'api' }, Math.floor(process.uptime()));
    setGauge('mmp_process_memory_rss_bytes', { service: 'api' }, process.memoryUsage().rss);
  }, 10_000);
  metricsHeartbeatTimer.unref();

  if (env.OBSERVABILITY_ALERT_WEBHOOK_URL) {
    observabilityHeartbeatTimer = setInterval(() => {
      void maybeSendObservabilityAlerts();
    }, env.OBSERVABILITY_ALERT_WEBHOOK_INTERVAL_MS);
    observabilityHeartbeatTimer.unref();
  }

  app.get('/health', async () => ({ ok: true, service: 'mmp-api' }));

  app.setErrorHandler((err: any, _req: any, reply: any) => {
    if (err?.issues) {
      reply.status(400).send({ error: 'validation_error', details: err.issues });
      return;
    }
    if (err?.validation) {
      reply.status(400).send({ error: 'validation_error' });
      return;
    }
    app.log.error(err);
    reply.status(500).send({ error: 'internal_error' });
  });

  await app.ready();
  return app;
}

export async function startServer() {
  const app = await createServer();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  app.log.info(`mmp api listening on :${env.PORT}`);
  return app;
}

if (require.main === module) {
  void startServer();
}
