import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { evaluateCompliance } from '../services/compliance';
import { getDeliveryJobStats } from '../lib/db';
import { env } from '../config/env';
import { formatPrometheus, incrementCounter, snapshot } from '../lib/metrics';
import { getObservabilityHealth, getObservabilitySnapshot } from '../lib/observability';
import { getLaunchReadiness } from '../lib/launchReadiness';

function unauthorized(reply: FastifyReply) {
  reply.status(401).send({ error: 'auth_required', message: 'Invalid metrics token.' });
}

function requireMetricsToken(req: FastifyRequest, reply: FastifyReply) {
  if (!env.METRICS_ENABLED) {
    reply.status(404).send({ error: 'metrics_disabled' });
    return false;
  }
  if (!env.METRICS_ROUTE_TOKEN) {
    if (env.NODE_ENV === 'production') {
      reply.status(503).send({ error: 'metrics_token_required', message: 'METRICS_ROUTE_TOKEN is required in production.' });
      return false;
    }
    return true;
  }

  const expected = env.METRICS_ROUTE_TOKEN;
  const tokenHeader = req.headers['x-metrics-token'];
  const authorizationHeader = req.headers.authorization;

  const tokenFromHeader = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader;
  const authorizationValue = Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader;
  const bearerToken = (() => {
    if (!authorizationValue) return '';
    const match = String(authorizationValue).match(/^Bearer\s+(.+)$/i);
    return match ? match[1]?.trim() ?? '' : '';
  })();

  if (tokenFromHeader !== expected && bearerToken !== expected) {
    unauthorized(reply);
    return false;
  }
  return true;
}

function buildAlerts(payload: { pending: number; processing: number; failed: number; deadLetter: number }) {
  const alerts = [];
  if (payload.pending > env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD) {
    alerts.push({
      level: 'warning',
      type: 'delivery_queue_backlog',
      metric: 'mmp_delivery_jobs_pending_total',
      value: payload.pending,
      threshold: env.ALERT_PENDING_DELIVERY_JOBS_THRESHOLD,
    });
  }

  if (payload.failed > env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD) {
    alerts.push({
      level: 'warning',
      type: 'delivery_job_failures',
      metric: 'mmp_delivery_jobs_failed_total',
      value: payload.failed,
      threshold: env.ALERT_FAILED_DELIVERY_JOBS_THRESHOLD,
    });
  }

  return alerts;
}

export default async function (app: FastifyInstance) {
  app.get('/v1/compliance/status', async () => {
    return evaluateCompliance();
  });

  app.get('/v1/compliance/launch-readiness', async () => {
    return getLaunchReadiness();
  });

  app.get('/v1/compliance/alerts', async () => {
    const stats = await getDeliveryJobStats();
    const alerts = buildAlerts(stats);
    return {
      generatedAt: new Date().toISOString(),
      alerted: alerts.length > 0,
      alerts,
      metrics: {
        pending: stats.pending,
        processing: stats.processing,
        done: stats.done,
        failed: stats.failed,
        deadLetter: stats.deadLetter,
      },
    };
  });

  app.get('/v1/observability/alerts', async () => {
    const health = await getObservabilityHealth();
    return {
      generatedAt: new Date().toISOString(),
      ...health,
    };
  });

  app.get('/v1/observability/snapshot', async () => {
    return getObservabilitySnapshot();
  });

  app.post('/v1/observability/alert-hook', async (req, reply) => {
    const body = req.body as Record<string, any>;
    const alertCount = Array.isArray((body as any).alerts) ? (body as any).alerts.length : 1;
    incrementCounter('mmp_observability_alert_hook_calls_total', {
      service: 'api',
      has_body: Boolean(body).toString(),
      count: String(alertCount),
    });

    reply.send({
      ok: true,
      received: alertCount,
      message: 'observability alert hook acknowledged',
    });
  });

  app.get('/v1/metrics', async (req, reply) => {
    if (!requireMetricsToken(req, reply)) return;
    const acceptHeader = req.headers.accept || '';
    const query = req.query as { format?: string } | undefined;
    const isProm = acceptHeader.includes('text/plain') || query?.format === 'prometheus';
    if (isProm) {
      reply
        .header('content-type', 'text/plain; version=0.0.4')
        .send(formatPrometheus());
      return;
    }
    const payload = snapshot();
    reply.send({
      generatedAt: new Date().toISOString(),
      metrics: payload,
    });
    return;
  });
}
