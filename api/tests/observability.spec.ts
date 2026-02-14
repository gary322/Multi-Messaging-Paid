import request from 'supertest';
import {
  createMessageDeliveryJob,
  createUser,
  getMessageByMessageId,
  resetStore,
} from '../src/lib/db';
import { getObservabilityHealth } from '../src/lib/observability';
import { maybeSendObservabilityAlerts } from '../src/lib/observability';
import { env } from '../src/config/env';
import { createServer } from '../src/index';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('observability', () => {
  beforeEach(async () => {
    await resetStore();
    delete (global as any).fetch;
  });

  it('returns observability snapshot endpoint', async () => {
    const app = await createServer();
    const response = await request(app.server).get('/v1/observability/snapshot');
    expect(response.status).toBe(200);
    expect(response.body.generatedAt).toBeTruthy();
    expect(response.body.traces.enabled).toBe(env.TRACE_ENABLED);
    expect(response.body.deliveryJobs).toBeDefined();
    await app.close();
  });

  it('returns alerts endpoint with structured totals', async () => {
    const app = await createServer();
    const response = await request(app.server).get('/v1/observability/alerts');
    expect(response.status).toBe(200);
    expect(Array.isArray(response.body.alerts)).toBe(true);
    expect(response.body.snapshot).toBeDefined();
    expect(typeof response.body.snapshot.alerts.total).toBe('number');
    await app.close();
  });

  it('accepts alert-hook callbacks', async () => {
    const app = await createServer();
    const response = await request(app.server)
      .post('/v1/observability/alert-hook')
      .send({
        alerts: [{ labels: { alertname: 'queue_backlog' } }, { labels: { alertname: 'dead_letter' } }],
      });
    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.received).toBe(2);
    await app.close();
  });

  it('exposes metrics endpoint with auth token and prometheus format', async () => {
    await withEnv(
      {
        METRICS_ENABLED: true,
        METRICS_ROUTE_TOKEN: 'metrics-token',
        METRICS_MAX_SNAPSHOTS: 100,
      },
      async () => {
        const app = await createServer();
        const response = await request(app.server)
          .get('/v1/metrics')
          .set('x-metrics-token', 'wrong')
          .query({ format: 'prometheus' });
        expect(response.status).toBe(401);

        const response2 = await request(app.server)
          .get('/v1/metrics')
          .set('x-metrics-token', 'metrics-token')
          .set('Accept', 'text/plain');
        expect(response2.status).toBe(200);
        expect(typeof response2.text).toBe('string');

        const response3 = await request(app.server)
          .get('/v1/metrics')
          .set('Authorization', 'Bearer metrics-token')
          .set('Accept', 'text/plain');
        expect(response3.status).toBe(200);
        expect(typeof response3.text).toBe('string');
        await app.close();
      },
    );
  });

  it('returns 404 for traces endpoint when tracing is disabled', async () => {
    await withEnv(
      {
        TRACE_ENABLED: false,
      },
      async () => {
        const app = await createServer();
        const response = await request(app.server).get('/v1/observability/traces');
        expect(response.status).toBe(404);
        expect(response.body.error).toBe('tracing_disabled');
        await app.close();
      },
    );
  });

  it('returns traces when tracing is enabled', async () => {
    await withEnv(
      {
        TRACE_ENABLED: true,
        TRACE_MAX_SPANS: 2,
      },
      async () => {
        const app = await createServer();
        await request(app.server).get('/health');
        const response = await request(app.server).get('/v1/observability/traces?limit=1');
        expect(response.status).toBe(200);
        expect(response.body.generatedAt).toBeTruthy();
        expect(Array.isArray(response.body.traces)).toBe(true);
        expect(response.body.traces.length).toBeGreaterThan(0);
        await app.close();
      },
    );
  });

  it('triggers webhook alerts when threshold is exceeded', async () => {
    await withEnv(
      {
        ALERT_PENDING_DELIVERY_JOBS_THRESHOLD: 0,
        ALERT_FAILED_DELIVERY_JOBS_THRESHOLD: 0,
        OBSERVABILITY_ALERT_WEBHOOK_URL: 'https://observability.test/webhook',
        OBSERVABILITY_ALERT_TOKEN: 'token-abc',
      },
      async () => {
        const recipient = await createUser('0x1111111111111111111111111111111111111113');
        await createMessageDeliveryJob({
          messageId: 'obs-webhook-test',
          userId: recipient.id,
          channel: 'telegram',
          destination: '@recipient',
          payload: { subject: 'New paid message' },
        });

        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          text: async () => 'ok',
          status: 200,
        } as any);
        (global as any).fetch = fetchMock;

        const sent = await maybeSendObservabilityAlerts();
        expect(sent).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toBe('https://observability.test/webhook');
        expect(options.headers).toMatchObject({
          'content-type': 'application/json',
          authorization: 'Bearer token-abc',
        });

        const payload = JSON.parse(options.body);
        expect(Array.isArray(payload.alerts)).toBe(true);
        expect(payload.alerts.length).toBeGreaterThan(0);
        expect(payload.snapshot.thresholds.pendingDeliveryJobs).toBe(0);
        expect(payload.snapshot.thresholds.failedDeliveryJobs).toBe(0);
      },
    );
  });

  it('exposes compliance alert health and snapshot shape from module', async () => {
    const health = await getObservabilityHealth();
    expect(health).toHaveProperty('snapshot');
    expect(health).toHaveProperty('alerts');
    expect(health).toHaveProperty('checks');
    expect(Array.isArray(health.alerts)).toBe(true);
    expect(health.snapshot.alerts.total).toBe(health.alerts.length);
    const message = await getMessageByMessageId('no-such-id');
    expect(message).toBeNull();
  });
});
