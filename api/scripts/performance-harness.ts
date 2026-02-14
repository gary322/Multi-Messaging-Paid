import request from 'supertest';
import { createServer } from '../src/index';
import { env } from '../src/config/env';
import { resetRateLimitsForTests } from '../src/lib/rateLimit';
import { resetStore } from '../src/lib/db';

type Args = {
  requests: number;
  concurrency: number;
  messageBytes: number;
  maxP95Ms: number;
};

type Result = {
  status: number;
  durationMs: number;
};

function parseArgs(): Args {
  const defaults: Args = {
    requests: 300,
    concurrency: 20,
    messageBytes: 80,
    maxP95Ms: 1250,
  };

  const raw = process.argv.slice(2);
  for (const item of raw) {
    const [key, rawValue] = item.split('=');
    const value = Number(rawValue);
    if (!rawValue || Number.isNaN(value)) {
      continue;
    }

    if (key === '--requests') defaults.requests = value;
    if (key === '--concurrency') defaults.concurrency = value;
    if (key === '--message-bytes') defaults.messageBytes = value;
    if (key === '--target-p95-ms') defaults.maxP95Ms = value;
  }

  return defaults;
}

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((ratio / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

async function run() {
  const opts = parseArgs();
  const samplePayload = `x`.repeat(Math.max(1, opts.messageBytes));
  const payload = `load-${Date.now()}-`;

  env.RATE_LIMIT_MAX = 1_000_000;
  env.RATE_LIMIT_WINDOW_MS = 120_000;
  resetRateLimitsForTests();
  await resetStore();

  const app = await createServer();
  // Under concurrency, `supertest(app.server)` can race to open/close a non-listening server.
  // Bind once and use the base URL for stable high-concurrency testing.
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  const sender = await request(baseUrl).post('/v1/auth/register').send({
    walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    handle: `perf-sender-${Date.now()}`,
  });
  const recipient = await request(baseUrl).post('/v1/auth/register').send({
    walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    handle: `perf-recipient-${Date.now()}`,
  });

  await request(baseUrl)
    .put('/v1/pricing')
    .set('Authorization', `Bearer ${recipient.body.token}`)
    .send({
      userId: recipient.body.user.id,
      defaultPrice: 0,
      firstContactPrice: 0,
      returnDiscountBps: 0,
      acceptsAll: true,
    });

  const results: Result[] = [];
  const errors: Array<{ status: number; message: string }> = [];
  let cursor = 0;

  async function sendOne(index: number) {
    const start = process.hrtime.bigint();
    try {
      const res = await request(baseUrl)
        .post('/v1/messages/send')
        .set('Authorization', `Bearer ${sender.body.token}`)
        .send({
          senderId: sender.body.user.id,
          recipientSelector: recipient.body.user.handle,
          plaintext: `${payload}${index}-${samplePayload}`,
          idempotencyKey: `perf-${index}`,
        });
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      results.push({ status: res.status, durationMs });
      if (res.status !== 200) {
        errors.push({ status: res.status, message: res.text || '' });
      }
    } catch (error) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      results.push({ status: 0, durationMs });
      errors.push({ status: 0, message: String(error instanceof Error ? error.message : 'network error') });
    }
  }

  while (cursor < opts.requests) {
    const batchSize = Math.min(opts.concurrency, opts.requests - cursor);
    const batch = [] as Promise<void>[];
    for (let i = 0; i < batchSize; i += 1) {
      const index = cursor + i;
      batch.push(sendOne(index));
    }
    cursor += batchSize;
    await Promise.all(batch);
  }

  const durations = results.map((item) => item.durationMs);
  const okCount = results.filter((item) => item.status === 200).length;
  const failCount = results.length - okCount;
  const report = {
    requests: results.length,
    ok: okCount,
    failed: failCount,
    p50Ms: percentile(durations, 50),
    p95Ms: percentile(durations, 95),
    p99Ms: percentile(durations, 99),
    maxMs: Math.max(...durations),
    minMs: Math.min(...durations),
    avgMs: durations.reduce((sum, current) => sum + current, 0) / Math.max(1, durations.length),
    uniqueErrors: errors.reduce<Record<string, number>>((acc, item) => {
      const key = String(item.status || 0);
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    targetP95Ms: opts.maxP95Ms,
  };

  const statusLine = `Performance load complete. requests=${report.requests} ok=${report.ok} fail=${report.failed} p95=${report.p95Ms.toFixed(2)}ms max=${report.maxMs.toFixed(2)}ms`;
  console.log(statusLine);
  console.log(JSON.stringify(report, null, 2));

  await app.close();

  if (failCount > 0) {
    console.error(`Load failure count: ${failCount}`);
    process.exitCode = 1;
    return;
  }

  if (report.p95Ms > opts.maxP95Ms) {
    console.error(`p95 latency exceeded target: ${report.p95Ms.toFixed(2)}ms > ${opts.maxP95Ms}ms`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = 0;
}

run().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
