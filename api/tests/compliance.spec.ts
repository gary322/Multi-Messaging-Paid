import request from 'supertest';
import { createServer } from '../src/index';
import { env } from '../src/config/env';
import { evaluateCompliance } from '../src/services/compliance';

function withEnv(overrides: Partial<typeof env>, fn: () => Promise<void> | void) {
  const snapshot: typeof env = { ...env };
  Object.assign(env, overrides);
  return Promise.resolve(fn()).finally(() => {
    Object.assign(env, snapshot);
  });
}

describe('compliance', () => {
  it('reflects warnings for non-production persistence and provider readiness', async () => {
    await withEnv({ DATABASE_BACKEND: 'sqlite', REDIS_URL: '', COMPLIANCE_BLOCK_ON_WARN: false }, async () => {
      const report = evaluateCompliance();
      expect(report.summary.warn).toBeGreaterThan(0);
      expect(report.checks.some((check) => check.key === 'db_backend')).toBe(true);
      expect(report.checks.some((check) => check.key === 'distributed_cache')).toBe(true);
    });
  });

  it('can hard-fail launch-ready checks when warns are treated as blocking', async () => {
    await withEnv(
      {
        COMPLIANCE_ENFORCE_LAUNCH: true,
        COMPLIANCE_BLOCK_ON_WARN: true,
        DATABASE_BACKEND: 'sqlite',
      },
      async () => {
        const app = await createServer();
        const reg = await request(app.server).post('/v1/auth/register').send({
          walletAddress: '0x1111111111111111111111111111111111111111',
        });
        expect(reg.status).toBe(423);
        expect(reg.body.error).toBe('launch_not_ready');
        await app.close();
      },
    );
  });

  it('exposes compliance status and alerts APIs', async () => {
    await withEnv(
      {
        SESSION_SECRET: 'integration-test-strong-session-secret-please-change',
        PII_HASH_KEY: 'integration-test-strong-pii-hash-key-please-change',
        SMART_ACCOUNT_DERIVATION_KEY: 'integration-test-strong-smart-account-key-please-change',
      },
      async () => {
        const app = await createServer();
        const status = await request(app.server).get('/v1/compliance/status');
        expect(status.status).toBe(200);
        expect(status.body.launchReady).toBeTruthy();
        expect(Array.isArray(status.body.checks)).toBe(true);

        const alerts = await request(app.server).get('/v1/compliance/alerts');
        expect(alerts.status).toBe(200);
        expect(alerts.body.metrics).toBeDefined();
        expect(typeof alerts.body.alerted).toBe('boolean');
        await app.close();
      },
    );
  });

  it('exposes launch readiness endpoint', async () => {
    await withEnv(
      {
        SESSION_SECRET: 'integration-test-strong-session-secret-please-change',
        PII_HASH_KEY: 'integration-test-strong-pii-hash-key-please-change',
        SMART_ACCOUNT_DERIVATION_KEY: 'integration-test-strong-smart-account-key-please-change',
      },
      async () => {
        const app = await createServer();
        const payload = await request(app.server).get('/v1/compliance/launch-readiness');
        expect(payload.status).toBe(200);
        expect(payload.body.launchReady).toBe(true);
        expect(payload.body.summary.pass).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(payload.body.checks)).toBe(true);
        await app.close();
      },
    );
  });

  it('fails API startup when launch startup gating is enabled and checks fail', async () => {
    await withEnv(
      {
        LAUNCH_STARTUP_GATING: true,
        COMPLIANCE_ENFORCE_LAUNCH: true,
        COMPLIANCE_BLOCK_ON_WARN: true,
        DATABASE_BACKEND: 'sqlite',
        PERSISTENCE_STRICT_MODE: true,
      },
      async () => {
        const attempt = createServer();
        await expect(attempt).rejects.toThrow('launch readiness checks failed');
      },
    );
  });
});
