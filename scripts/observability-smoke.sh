#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run the observability smoke test."
  exit 1
fi

if ! command -v docker-compose >/dev/null 2>&1 && ! command -v docker >/dev/null 2>&1; then
  echo "docker compose (plugin or standalone) is required."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi

COMPOSE_FILE="infra/docker-compose.observability.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing compose file: $COMPOSE_FILE"
  exit 1
fi

find_free_port() {
  local preferred=$1
  local candidate=$preferred
  for _ in $(seq 0 20); do
    if ! lsof -iTCP -sTCP:LISTEN -nP | grep -q ":${candidate} "; then
      echo "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

GRAFANA_PORT="${MMP_GRAFANA_PORT:-3001}"
if lsof -iTCP -sTCP:LISTEN -nP | grep -q ":${GRAFANA_PORT} "; then
  echo "MMP_GRAFANA_PORT ${GRAFANA_PORT} is already in use. Selecting next free port."
  GRAFANA_PORT="$(find_free_port "$GRAFANA_PORT")"
fi
export MMP_GRAFANA_PORT="$GRAFANA_PORT"

API_LOG="/tmp/mmp-observability-api.log"
API_PID=""

cleanup() {
  set +e
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
  $DC -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Starting observability stack (Grafana on ${MMP_GRAFANA_PORT})..."
$DC -f "$COMPOSE_FILE" up -d --remove-orphans

echo "Building API..."
pnpm --dir api run --silent build

echo "Starting API with OTLP export to Tempo..."
rm -f "$API_LOG" >/dev/null 2>&1 || true
PORT=4000 \
NODE_ENV=development \
METRICS_ENABLED=true \
OTEL_TRACING_ENABLED=true \
OTEL_TRACES_EXPORT_URL="http://127.0.0.1:4318/v1/traces" \
OTEL_BSP_SCHEDULE_DELAY=200 \
LAUNCH_STARTUP_GATING=false \
COMPLIANCE_ENFORCE_LAUNCH=false \
RUN_SERVER=1 \
  node api/dist/index.js > "$API_LOG" 2>&1 &
API_PID="$!"

echo "Waiting for API health..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:4000/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:4000/health" >/dev/null 2>&1; then
  echo "API failed to start on :4000"
  tail -n 200 "$API_LOG" || true
  exit 1
fi

# Generate some traffic and spans.
curl -fsS "http://127.0.0.1:4000/health" >/dev/null
curl -fsS "http://127.0.0.1:4000/health" >/dev/null

echo "Checking API metrics endpoint..."
curl -fsS "http://127.0.0.1:4000/v1/metrics?format=prometheus" >/dev/null

echo "Waiting for Prometheus readiness..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:9090/-/ready" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "Waiting for Prometheus to scrape mmp-api target..."
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:9090/api/v1/targets" | node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(0,'utf8')); const targets=payload?.data?.activeTargets||[]; const t=targets.find((x)=>String(x.scrapeUrl||'').includes('host.docker.internal:4000/v1/metrics')); process.exit(t && t.health==='up' ? 0 : 1);" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:9090/api/v1/targets" | node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(0,'utf8')); const targets=payload?.data?.activeTargets||[]; const t=targets.find((x)=>String(x.scrapeUrl||'').includes('host.docker.internal:4000/v1/metrics')); process.exit(t && t.health==='up' ? 0 : 1);" >/dev/null 2>&1; then
  echo "Prometheus did not report the mmp-api scrape target as healthy."
  curl -fsS "http://127.0.0.1:9090/api/v1/targets" | node -e "const fs=require('fs'); const payload=JSON.parse(fs.readFileSync(0,'utf8')); const targets=payload?.data?.activeTargets||[]; const t=targets.find((x)=>String(x.scrapeUrl||'').includes('host.docker.internal:4000/v1/metrics')); console.log(JSON.stringify({ found: Boolean(t), scrapeUrl: t?.scrapeUrl, health: t?.health, lastError: t?.lastError }, null, 2));" || true
  exit 1
fi

echo "Waiting for Tempo readiness..."
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:3200/metrics" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "Waiting for Tempo to receive spans..."
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:3200/metrics" | node -e "const fs=require('fs'); const text=fs.readFileSync(0,'utf8'); const lines=text.split(/\\n/); const patterns=[/^tempo_distributor_.*spans_received_total/, /^tempo_distributor_.*traces_received_total/, /^tempo_receiver_.*spans_received_total/]; let max=0; for (const line of lines) { const trimmed=line.trim(); if (!trimmed || trimmed.startsWith('#')) continue; if (!patterns.some((p)=>p.test(trimmed))) continue; const parts=trimmed.split(/\\s+/); const value=Number(parts[parts.length-1]); if (Number.isFinite(value)) max=Math.max(max,value); } process.exit(max>0 ? 0 : 1);" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:3200/metrics" | node -e "const fs=require('fs'); const text=fs.readFileSync(0,'utf8'); const lines=text.split(/\\n/); const patterns=[/^tempo_distributor_.*spans_received_total/, /^tempo_distributor_.*traces_received_total/, /^tempo_receiver_.*spans_received_total/]; let max=0; for (const line of lines) { const trimmed=line.trim(); if (!trimmed || trimmed.startsWith('#')) continue; if (!patterns.some((p)=>p.test(trimmed))) continue; const parts=trimmed.split(/\\s+/); const value=Number(parts[parts.length-1]); if (Number.isFinite(value)) max=Math.max(max,value); } process.exit(max>0 ? 0 : 1);" >/dev/null 2>&1; then
  echo "Tempo did not report any received spans."
  exit 1
fi

echo "Observability smoke test passed."

