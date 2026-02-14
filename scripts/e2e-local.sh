#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

RPC_URL="${MMP_RPC_URL:-http://127.0.0.1:8545}"
LOG_FILE="/tmp/mmp-hh-local.log"

SENDER_KEY="${CHAIN_SENDER_PRIVATE_KEY:-0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a}"
RECIPIENT_KEY="${CHAIN_RECIPIENT_PRIVATE_KEY:-0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6}"
TOPUP_AMOUNT="${MMP_CHAIN_TOPUP_AMOUNT:-1000}"
MESSAGE_AMOUNT="${MMP_CHAIN_SEND_AMOUNT:-100}"
WITHDRAW_AMOUNT="${MMP_CHAIN_WITHDRAW_AMOUNT:-20}"
MINT_AMOUNT="${MMP_CHAIN_MINT_AMOUNT:-1000000000}"
DEFAULT_SENDER_ADDRESS="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"

if [ -n "${CHAIN_RECIPIENT_ADDRESS:-}" ]; then
  SENDER_MINT_TO="$CHAIN_RECIPIENT_ADDRESS"
elif [ "$SENDER_KEY" = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a" ]; then
  SENDER_MINT_TO="$DEFAULT_SENDER_ADDRESS"
else
  SENDER_MINT_TO="$(CHAIN_SENDER_PRIVATE_KEY="$SENDER_KEY" pnpm --dir contracts exec node -e 'const { Wallet } = require("ethers"); console.log(new Wallet(process.env.CHAIN_SENDER_PRIVATE_KEY).address);')"
fi

echo "Starting local Hardhat node..."
pkill -f "hardhat node" >/dev/null 2>&1 || true
(pnpm --dir contracts exec hardhat node --hostname 127.0.0.1 --port 8545 > "$LOG_FILE" 2>&1) &
HH_PID=$!

cleanup() {
  if kill -0 "$HH_PID" >/dev/null 2>&1; then
    kill "$HH_PID" 2>/dev/null || true
    wait "$HH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

for i in {1..160}; do
  if grep -q 'Listening on' "$LOG_FILE" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

if ! kill -0 "$HH_PID" >/dev/null 2>&1; then
  echo "Failed to start local node."
  echo "--- hardhat node log ---"
  cat "$LOG_FILE"
  exit 1
fi

export CHAIN_RPC_URL="$RPC_URL"
echo "Deploying local contracts..."
DEPLOY_OUT=$(pnpm --dir contracts run --silent deploy-local)
echo "$DEPLOY_OUT"

TOKEN_ADDRESS="$(printf '%s' "$DEPLOY_OUT" | node -e "const fs=require('node:fs'); const o=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(o.tokenAddress || '');")"
VAULT_ADDRESS="$(printf '%s' "$DEPLOY_OUT" | node -e "const fs=require('node:fs'); const o=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(o.vaultAddress || '');")"

if [ -z "$TOKEN_ADDRESS" ] || [ -z "$VAULT_ADDRESS" ]; then
  echo "Failed to parse deployment output."
  echo "--- deployment output ---"
  echo "$DEPLOY_OUT"
  exit 1
fi

echo "Token: $TOKEN_ADDRESS"
echo "Vault: $VAULT_ADDRESS"

echo "Minting sender to fund top-up flow..."
USDC_ADDRESS="$TOKEN_ADDRESS" \
RECIPIENT="$SENDER_MINT_TO" \
AMOUNT="$MINT_AMOUNT" \
pnpm --dir contracts run --silent mint

echo "Running local contract smoke..."
USDC_ADDRESS="$TOKEN_ADDRESS" \
VAULT_ADDRESS="$VAULT_ADDRESS" \
TOPUP_AMOUNT="$TOPUP_AMOUNT" \
SEND_AMOUNT="$MESSAGE_AMOUNT" \
WITHDRAW_AMOUNT="$WITHDRAW_AMOUNT" \
pnpm --dir contracts run --silent smoke-local

echo "Running chain-integration API e2e suite..."
CHAIN_RPC_URL="$CHAIN_RPC_URL" \
CHAIN_VAULT_ADDRESS="$VAULT_ADDRESS" \
CHAIN_USDC_ADDRESS="$TOKEN_ADDRESS" \
CHAIN_SENDER_PRIVATE_KEY="$SENDER_KEY" \
CHAIN_RECIPIENT_PRIVATE_KEY="$RECIPIENT_KEY" \
MMP_RESET_STORE=1 \
NODE_ENV=test \
pnpm --dir api test -- chain-integration.spec.ts

echo "Running full API/contract test suite..."
pnpm -r test

echo "Local end-to-end run complete."
echo "TokenAddress=$TOKEN_ADDRESS"
echo "VaultAddress=$VAULT_ADDRESS"
