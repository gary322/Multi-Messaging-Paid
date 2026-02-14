import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';

type ChildResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

async function runNodeScript(
  scriptPath: string,
  envOverrides: Record<string, string>,
  timeoutMs = 15_000,
): Promise<ChildResult> {
  return await new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', scriptPath], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: '1',
        ...envOverrides,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`otel_child_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref();

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function waitFor(condition: () => boolean, timeoutMs = 2_000) {
  const start = Date.now();
  while (!condition() && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return condition();
}

describe('otel tracing', () => {
  it(
    'exports traces to OTLP HTTP endpoint when enabled',
    async () => {
    const received: Array<{ url: string; contentType: string | null; bytes: number }> = [];

    const collector = http.createServer((req, res) => {
      let bytes = 0;
      req.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk);
      });
      req.on('end', () => {
        received.push({
          url: req.url || '',
          contentType: (req.headers['content-type'] as string) || null,
          bytes,
        });
        res.statusCode = 200;
        res.end();
      });
    });

    await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));
    const address = collector.address();
    if (!address || typeof address === 'string') {
      throw new Error('failed_to_bind_otel_collector');
    }

    const exportUrl = `http://127.0.0.1:${address.port}/v1/traces`;

    const childScript = path.resolve(__dirname, 'helpers', 'otel-child.ts');
    let childResult: ChildResult | null = null;
    try {
      childResult = await runNodeScript(childScript, {
        NODE_ENV: 'test',
        OTEL_TRACING_ENABLED: 'true',
        OTEL_TRACES_EXPORT_URL: exportUrl,
      });

      const ok = await waitFor(() => received.length > 0, 3_000);
      if (!ok) {
        const details = childResult
          ? `child_exit_code=${String(childResult.code)} signal=${String(childResult.signal)}\nstdout:\n${childResult.stdout}\nstderr:\n${childResult.stderr}`
          : 'child_not_started';
        throw new Error(`otel_collector_received_no_requests\n${details}`);
      }

      expect(received.some((item) => item.url.includes('/v1/traces'))).toBe(true);
      expect(received.some((item) => (item.bytes ?? 0) > 0)).toBe(true);
      expect(childResult.code).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => collector.close((err) => (err ? reject(err) : resolve())));
    }
    },
    30_000,
  );
});
