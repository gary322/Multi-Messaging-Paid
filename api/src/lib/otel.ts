import { env } from '../config/env';

let sdk: any | null = null;
let startPromise: Promise<void> | null = null;

export function isOtelTracingEnabled() {
  return Boolean(env.OTEL_TRACING_ENABLED && env.OTEL_TRACES_EXPORT_URL);
}

export async function startOtelTracing() {
  if (!isOtelTracingEnabled()) {
    return;
  }

  if (sdk) {
    return;
  }

  if (startPromise) {
    await startPromise;
    return;
  }

  startPromise = (async () => {
    // Use `require()` rather than `import()` so Jest and Node share a single module
    // instance (Jest's runtime module loader + dynamic import can lead to separate
    // OpenTelemetry API singletons, breaking span export in tests).
    // This stays lazy: OTel deps are only loaded when enabled.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { NodeSDK, tracing } = require('@opentelemetry/sdk-node') as typeof import('@opentelemetry/sdk-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node') as typeof import('@opentelemetry/auto-instrumentations-node');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http') as typeof import('@opentelemetry/exporter-trace-otlp-http');

    const exporter = new OTLPTraceExporter({
      url: env.OTEL_TRACES_EXPORT_URL,
    });

    const useSimpleSpanProcessor = env.NODE_ENV === 'test';
    const spanProcessors = useSimpleSpanProcessor
      ? [new tracing.SimpleSpanProcessor(exporter)]
      : undefined;

    sdk = new NodeSDK({
      serviceName: env.OTEL_SERVICE_NAME || 'mmp-api',
      ...(spanProcessors ? { spanProcessors } : { traceExporter: exporter }),
      instrumentations: [getNodeAutoInstrumentations()],
    });

    await sdk.start();
  })().finally(() => {
    startPromise = null;
  });

  try {
    await startPromise;
  } catch (error) {
    // Observability must not take down the API. In tests we fail fast so instrumentation
    // issues are detected before shipping.
    sdk = null;
    if (env.NODE_ENV === 'test') {
      throw error;
    }
  }
}

export async function shutdownOtelTracing() {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  try {
    const tracerProvider = (current as any)?._tracerProvider;
    if (tracerProvider && typeof tracerProvider.forceFlush === 'function') {
      // Ensure spans are exported before shutting down the SDK (important for tests and fast shutdowns).
      await Promise.resolve(tracerProvider.forceFlush()).catch(() => {});
    }
    await current.shutdown();
  } catch {
    // Ignore shutdown failures.
  }
}
