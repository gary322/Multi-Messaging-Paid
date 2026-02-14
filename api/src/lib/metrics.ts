type Labels = Record<string, string>;

type CounterStore = Map<string, number>;
type GaugeStore = Map<string, number>;
type HistogramStore = Map<string, { count: number; sum: number }>;

const counters: CounterStore = new Map();
const gauges: GaugeStore = new Map();
const histograms: HistogramStore = new Map();

function metricKey(name: string, labels: Labels = {}) {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  const suffix =
    entries.length === 0
      ? ''
      : `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
  return `${name}${suffix}`;
}

function normalizeLabelValue(value: string) {
  return String(value ?? '').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeLabel(value: string) {
  return normalizeLabelValue(value);
}

function histoKey(name: string, labels: Labels) {
  return metricKey(name, labels);
}

export function incrementCounter(name: string, labels: Labels = {}, amount = 1) {
  const key = metricKey(name, labels);
  counters.set(key, (counters.get(key) ?? 0) + amount);
}

export function setGauge(name: string, labels: Labels = {}, value: number) {
  const key = metricKey(name, labels);
  gauges.set(key, value);
}

export function observeDuration(name: string, labels: Labels, valueMs: number) {
  const key = histoKey(name, labels);
  const current = histograms.get(key) ?? { count: 0, sum: 0 };
  current.count += 1;
  current.sum += Math.max(0, valueMs);
  histograms.set(key, current);
}

export function snapshot() {
  return {
    counters: Array.from(counters.entries()).map(([metric, value]) => [metric, value]),
    gauges: Array.from(gauges.entries()).map(([metric, value]) => [metric, value]),
    histograms: Array.from(histograms.entries()).map(([metric, { count, sum }]) => [
      metric,
      { count, sum },
    ]),
  };
}

export function formatPrometheus() {
  const lines: string[] = [];

  for (const [metric, value] of counters) {
    const m = parseMetricName(metric);
    lines.push(`# HELP ${m.name} Total count`);
    lines.push(`# TYPE ${m.name} counter`);
    lines.push(`${m.name}${m.labels} ${value}`);
  }

  for (const [metric, value] of gauges) {
    const m = parseMetricName(metric);
    lines.push(`# HELP ${m.name} Gauge`);
    lines.push(`# TYPE ${m.name} gauge`);
    lines.push(`${m.name}${m.labels} ${value}`);
  }

  for (const [metric, value] of histograms) {
    const m = parseMetricName(metric);
    lines.push(`# HELP ${m.name}_sum Duration sum`);
    lines.push(`# TYPE ${m.name}_sum gauge`);
    lines.push(`${m.name}_sum${m.labels} ${value.sum}`);
    lines.push(`# HELP ${m.name}_count Duration count`);
    lines.push(`# TYPE ${m.name}_count counter`);
    lines.push(`${m.name}_count${m.labels} ${value.count}`);
  }
  return lines.join('\n') + '\n';
}

function parseMetricName(metricWithLabels: string) {
  const match = metricWithLabels.match(/^(.*?)(\{.*\})?$/);
  if (!match) return { name: metricWithLabels, labels: '' };
  return { name: match[1], labels: match[2] ?? '' };
}
