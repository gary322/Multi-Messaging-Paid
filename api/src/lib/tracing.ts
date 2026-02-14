import { env } from '../config/env';

type TraceSpanRecord = {
  id: string;
  name: string;
  status: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  traceId: string;
  tags: Record<string, string>;
};

type ActiveSpan = {
  id: string;
  name: string;
  startTs: number;
  traceId: string;
  tags: Record<string, string>;
  otelSpan?: any;
};

const spans: TraceSpanRecord[] = [];
let otelApi: any | null = null;

function tryGetOtelApi() {
  if (otelApi) return otelApi;
  try {
    // CommonJS build: require is available.
    otelApi = require('@opentelemetry/api');
    return otelApi;
  } catch {
    return null;
  }
}

function toSafeJson(value: unknown) {
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function clampSpans() {
  if (spans.length <= env.TRACE_MAX_SPANS) {
    return;
  }

  const excess = spans.length - env.TRACE_MAX_SPANS;
  if (excess > 0) {
    spans.splice(0, excess);
  }
}

function normalizeTags(tags: Record<string, unknown>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags)) {
    out[key] = toSafeJson(value);
  }
  return out;
}

function buildSpanPayload(record: TraceSpanRecord) {
  const eventTime = new Date(record.endTs).toISOString();
  return {
    scope: 'mmp/api',
    name: record.name,
    status: record.status,
    traceId: record.traceId,
    spanId: record.id,
    startTimeUnixNano: String(record.startTs * 1_000_000),
    endTimeUnixNano: String(record.endTs * 1_000_000),
    durationMs: record.durationMs,
    tags: record.tags,
    observedAt: eventTime,
  };
}

async function exportSpan(record: TraceSpanRecord) {
  if (!env.TRACE_EXPORT_URL) {
    return;
  }

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (env.METRICS_AUTH_TOKEN) {
    headers.authorization = `Bearer ${env.METRICS_AUTH_TOKEN}`;
  }

  try {
    await fetch(env.TRACE_EXPORT_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        resource: { serviceName: 'mmp-api', attributes: {} },
        spans: [buildSpanPayload(record)],
      }),
      signal: AbortSignal.timeout(Math.min(10_000, env.TRACE_BUFFER_FLUSH_MS)),
    });
  } catch {
    // Trace export failures must never fail request processing.
  }
}

export function startSpan(name: string, tags: Record<string, unknown> = {}, traceId: string): ActiveSpan {
  const startTs = Date.now();
  const record: ActiveSpan = {
    id: env.TRACE_ENABLED ? `${Date.now()}-${Math.random().toString(16).slice(2)}` : '',
    name,
    startTs,
    traceId,
    tags: env.TRACE_ENABLED ? normalizeTags(tags) : normalizeTags(tags),
  };

  if (env.OTEL_TRACING_ENABLED && env.OTEL_TRACES_EXPORT_URL) {
    const api = tryGetOtelApi();
    if (api) {
      try {
        const { trace } = api;
        const tracer = trace.getTracer('mmp/api');
        record.otelSpan = tracer.startSpan(name, {
          attributes: {
            'mmp.trace_id': traceId,
            ...normalizeTags(tags),
          },
        });
      } catch {
        // ignore
      }
    }
  }

  return record;
}

export async function endSpan(span: ActiveSpan, status: string, tags: Record<string, unknown> = {}) {
  const endTs = Date.now();
  const extraTags = normalizeTags(tags);

  if (span.otelSpan) {
    const api = tryGetOtelApi();
    if (api) {
      try {
        const { SpanStatusCode } = api;
        if (status === 'ok') {
          span.otelSpan.setStatus({ code: SpanStatusCode.OK });
        } else {
          span.otelSpan.setStatus({ code: SpanStatusCode.ERROR });
        }
        for (const [key, value] of Object.entries(extraTags)) {
          span.otelSpan.setAttribute(key, value);
        }
        span.otelSpan.setAttribute('mmp.status', status);
        span.otelSpan.setAttribute('mmp.duration_ms', Math.max(0, endTs - (span.startTs || endTs)));
        span.otelSpan.end();
      } catch {
        // ignore
      }
    }
  }

  if (!env.TRACE_ENABLED || !span.startTs) {
    return;
  }

  const record: TraceSpanRecord = {
    id: span.id,
    name: span.name,
    status,
    startTs: span.startTs,
    endTs,
    durationMs: endTs - span.startTs,
    traceId: span.traceId,
    tags: {
      ...span.tags,
      ...extraTags,
    },
  };

  spans.push(record);
  clampSpans();
  void exportSpan(record);
}

export async function withSpan<T>(name: string, traceId: string, tags: Record<string, unknown>, cb: () => Promise<T>): Promise<T> {
  const span = startSpan(name, tags, traceId);

  if (span.otelSpan) {
    const api = tryGetOtelApi();
    if (api) {
      try {
        const { context, trace } = api;
        return await context.with(trace.setSpan(context.active(), span.otelSpan), async () => {
          try {
            const result = await cb();
            await endSpan(span, 'ok');
            return result;
          } catch (error) {
            await endSpan(span, 'error', {
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        });
      } catch {
        // ignore and fall through
      }
    }
  }

  try {
    const result = await cb();
    await endSpan(span, 'ok');
    return result;
  } catch (error) {
    await endSpan(span, 'error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

export function getTraces(limit = env.TRACE_MAX_SPANS) {
  return [...spans].slice(-Math.max(1, limit));
}
