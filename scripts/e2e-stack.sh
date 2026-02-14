#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  cat <<'USAGE'
Usage: scripts/e2e-stack.sh

Starts local dependencies and executes:
  - contract deployment on local Hardhat node
  - mmp API postgres + redis stack
  - API postgres migration + chain integration e2e
  - Full repository test suite
USAGE
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run postgres/redis stack."
  exit 1
fi

if ! command -v docker-compose >/dev/null 2>&1 && ! command -v docker compose >/dev/null 2>&1; then
  echo "docker compose (plugin or standalone) is required."
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DC="docker compose"
else
  DC="docker-compose"
fi
COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mmp-local}"

COMPOSE_FILE="infra/docker-compose.local.yml"
if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "Missing compose file: $COMPOSE_FILE"
  exit 1
fi

HH_LOG_FILE="/tmp/mmp-hh-local.log"

SENDER_KEY="${CHAIN_SENDER_PRIVATE_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"
RECIPIENT_KEY="${CHAIN_RECIPIENT_PRIVATE_KEY:-0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6}"
TOPUP_AMOUNT="${MMP_CHAIN_TOPUP_AMOUNT:-1000}"
MESSAGE_AMOUNT="${MMP_CHAIN_SEND_AMOUNT:-100}"
WITHDRAW_AMOUNT="${MMP_CHAIN_WITHDRAW_AMOUNT:-20}"
MINT_AMOUNT="${MMP_CHAIN_MINT_AMOUNT:-1000000000}"
DEFAULT_SENDER_ADDRESS="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"
DEFAULT_DATABASE_PORT="5433"
DEFAULT_REDIS_PORT="6379"

find_free_port() {
  local preferred=$1
  local offset=${2:-0}
  local candidate=$((preferred + offset))

  for _ in $(seq 0 20); do
    if ! lsof -iTCP -sTCP:LISTEN -nP | rg -q ":${candidate} "; then
      echo "$candidate"
      return 0
    fi
    candidate=$((candidate + 1))
  done
  echo "$candidate"
}

if [[ -z "${MMP_POSTGRES_PORT:-}" ]]; then
  MMP_POSTGRES_PORT="$(find_free_port "$DEFAULT_DATABASE_PORT")"
else
  if lsof -iTCP -sTCP:LISTEN -nP | rg -q ":${MMP_POSTGRES_PORT} "; then
    echo "MMP_POSTGRES_PORT ${MMP_POSTGRES_PORT} is already in use. Selecting next free port."
    MMP_POSTGRES_PORT="$(find_free_port "$MMP_POSTGRES_PORT" 1)"
  fi
fi

if [[ -z "${MMP_REDIS_PORT:-}" ]]; then
  MMP_REDIS_PORT="$(find_free_port "$DEFAULT_REDIS_PORT")"
else
  if lsof -iTCP -sTCP:LISTEN -nP | rg -q ":${MMP_REDIS_PORT} "; then
    echo "MMP_REDIS_PORT ${MMP_REDIS_PORT} is already in use. Selecting next free port."
    MMP_REDIS_PORT="$(find_free_port "$MMP_REDIS_PORT" 1)"
  fi
fi

if [ -z "${CHAIN_SENDER_ADDRESS:-}" ]; then
  if [ "$SENDER_KEY" = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" ]; then
    CHAIN_SENDER_ADDRESS="$DEFAULT_SENDER_ADDRESS"
  else
    CHAIN_SENDER_ADDRESS="$(CHAIN_SENDER_PRIVATE_KEY="$SENDER_KEY" pnpm --dir contracts exec node -e 'const { Wallet } = require("ethers"); console.log(new Wallet(process.env.CHAIN_SENDER_PRIVATE_KEY).address);')"
  fi
else
  CHAIN_SENDER_ADDRESS="$CHAIN_SENDER_ADDRESS"
fi

CHAIN_PAYER_PRIVATE_KEY="${CHAIN_PAYER_PRIVATE_KEY:-$SENDER_KEY}"

echo "Starting postgres + redis stack..."
docker rm -f mmp-postgres mmp-redis >/dev/null 2>&1 || true
MMP_POSTGRES_PORT="$MMP_POSTGRES_PORT" \
MMP_REDIS_PORT="$MMP_REDIS_PORT" \
  $DC -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" up -d --remove-orphans

cleanup() {
  echo "Cleaning up..."
  $DC -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" down -v --remove-orphans
  if kill -0 "$HH_PID" >/dev/null 2>&1; then
    kill "$HH_PID" 2>/dev/null || true
    wait "$HH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Waiting for postgres/redis health..."
for _ in $(seq 1 90); do
  if [[ "$($DC -f "$COMPOSE_FILE" -p "$COMPOSE_PROJECT_NAME" ps | grep -c "healthy")" -ge 2 ]]; then
    break
  fi
  sleep 1
done

echo "Starting local Hardhat node..."
pkill -f "hardhat node" >/dev/null 2>&1 || true
(
  pnpm --dir contracts exec hardhat node --hostname 127.0.0.1 --port 8545 > "$HH_LOG_FILE" 2>&1
) &
HH_PID=$!

for _ in $(seq 1 160); do
  if grep -q 'Listening on' "$HH_LOG_FILE" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if ! kill -0 "$HH_PID" >/dev/null 2>&1; then
  echo "Failed to start local node."
  cat "$HH_LOG_FILE"
  exit 1
fi

export CHAIN_RPC_URL="http://127.0.0.1:8545"
export DATABASE_BACKEND=postgres
export DATABASE_URL="postgresql://mmp:mmp@127.0.0.1:${MMP_POSTGRES_PORT}/mmp"
export REDIS_URL="redis://127.0.0.1:${MMP_REDIS_PORT}"
export WORKER_DISTRIBUTED=true
export CHAIN_INDEXER_ENABLED=true
export DELIVERY_WORKER_ENABLED=true
export DELIVERY_WORKER_BATCH_SIZE=20
export CHAIN_INDEXER_POLL_INTERVAL_MS=3000
export DELIVERY_WORKER_POLL_INTERVAL_MS=3000
export SESSION_SECRET="e2e-stack-session-secret-rotate-me-please"
export COMPLIANCE_BLOCK_ON_WARN=false
export COMPLIANCE_ENFORCE_LAUNCH=false
export OBSERVABILITY_ALERT_WEBHOOK_INTERVAL_MS=10000
export TRACE_ENABLED=true
export TRACE_MAX_SPANS=200
export TRACE_BUFFER_FLUSH_MS=1000

echo "Running API migrations..."
pnpm --dir api run migrate:postgres

echo "Deploying contracts..."
DEPLOY_OUT=$(pnpm --dir contracts run --silent deploy-local)
TOKEN_ADDRESS="$(printf '%s' "$DEPLOY_OUT" | node -e "const fs=require('node:fs'); const o=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(o.tokenAddress || '');")"
VAULT_ADDRESS="$(printf '%s' "$DEPLOY_OUT" | node -e "const fs=require('node:fs'); const o=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(o.vaultAddress || '');")"

if [ -z "$TOKEN_ADDRESS" ] || [ -z "$VAULT_ADDRESS" ]; then
  echo "Deployment output missing token/vault."
  echo "$DEPLOY_OUT"
  exit 1
fi

echo "Minting sender and seeding for chain flows..."
USDC_ADDRESS="$TOKEN_ADDRESS" \
RECIPIENT="$CHAIN_SENDER_ADDRESS" \
AMOUNT="$MINT_AMOUNT" \
pnpm --dir contracts run --silent mint

echo "Running local contract smoke..."
USDC_ADDRESS="$TOKEN_ADDRESS" \
VAULT_ADDRESS="$VAULT_ADDRESS" \
TOPUP_AMOUNT="$TOPUP_AMOUNT" \
SEND_AMOUNT="$MESSAGE_AMOUNT" \
WITHDRAW_AMOUNT="$WITHDRAW_AMOUNT" \
pnpm --dir contracts run --silent smoke-local

echo "Running API-focused stack checks with postgres/redis..."
CHAIN_RPC_URL="$CHAIN_RPC_URL" \
CHAIN_VAULT_ADDRESS="$VAULT_ADDRESS" \
CHAIN_USDC_ADDRESS="$TOKEN_ADDRESS" \
CHAIN_SENDER_PRIVATE_KEY="$SENDER_KEY" \
CHAIN_PAYER_PRIVATE_KEY="$CHAIN_PAYER_PRIVATE_KEY" \
CHAIN_RECIPIENT_PRIVATE_KEY="$RECIPIENT_KEY" \
CHAIN_SENDER_ADDRESS="$CHAIN_SENDER_ADDRESS" \
DATABASE_BACKEND="$DATABASE_BACKEND" \
DATABASE_URL="$DATABASE_URL" \
REDIS_URL="$REDIS_URL" \
WORKER_DISTRIBUTED="$WORKER_DISTRIBUTED" \
DELIVERY_WORKER_ENABLED="$DELIVERY_WORKER_ENABLED" \
CHAIN_INDEXER_ENABLED="$CHAIN_INDEXER_ENABLED" \
MMP_RESET_STORE=1 \
MMP_POSTGRES_STACK=1 \
NODE_ENV=test \
pnpm --dir api exec jest --runInBand chain-integration.spec.ts postgres-cluster.spec.ts

echo "Running full repository checks..."
CHAIN_RPC_URL="$CHAIN_RPC_URL" \
CHAIN_VAULT_ADDRESS="$VAULT_ADDRESS" \
CHAIN_USDC_ADDRESS="$TOKEN_ADDRESS" \
CHAIN_SENDER_PRIVATE_KEY="$SENDER_KEY" \
CHAIN_PAYER_PRIVATE_KEY="$CHAIN_PAYER_PRIVATE_KEY" \
CHAIN_RECIPIENT_PRIVATE_KEY="$RECIPIENT_KEY" \
CHAIN_SENDER_ADDRESS="$CHAIN_SENDER_ADDRESS" \
DATABASE_BACKEND="$DATABASE_BACKEND" \
DATABASE_URL="$DATABASE_URL" \
REDIS_URL="$REDIS_URL" \
WORKER_DISTRIBUTED="$WORKER_DISTRIBUTED" \
DELIVERY_WORKER_ENABLED="$DELIVERY_WORKER_ENABLED" \
CHAIN_INDEXER_ENABLED="$CHAIN_INDEXER_ENABLED" \
MMP_RESET_STORE=1 \
MMP_POSTGRES_STACK=1 \
NODE_ENV=test \
pnpm --dir api exec jest --runInBand

echo "Local production-style stack run complete."
echo "Postgres: ${MMP_POSTGRES_PORT}, Redis: ${MMP_REDIS_PORT}"
echo "TokenAddress=$TOKEN_ADDRESS"
echo "VaultAddress=$VAULT_ADDRESS"
