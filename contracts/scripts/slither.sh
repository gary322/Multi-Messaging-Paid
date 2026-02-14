#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required to run slither via eth-security-toolbox."
  exit 1
fi

TOOLS_DIR="$ROOT_DIR/tools"
mkdir -p "$TOOLS_DIR"

SOLC_VERSION="0.8.24"
SOLC_BUILD="solc-linux-amd64-v${SOLC_VERSION}+commit.e11b9ed9"
SOLC_URL="https://binaries.soliditylang.org/linux-amd64/${SOLC_BUILD}"
SOLC_BIN="$TOOLS_DIR/solc-${SOLC_VERSION}"

OZ_VENDOR_DIR="$TOOLS_DIR/vendor"
OZ_SRC="$ROOT_DIR/node_modules/@openzeppelin/contracts"
OZ_DST="$OZ_VENDOR_DIR/@openzeppelin/contracts"

if [[ ! -f "$OZ_SRC/access/Ownable.sol" ]]; then
  echo "Missing OpenZeppelin sources at ${OZ_SRC}. Run pnpm install first."
  exit 1
fi

if [[ ! -f "$OZ_DST/access/Ownable.sol" ]]; then
  echo "Preparing vendored OpenZeppelin sources for containerized Slither run..."
  mkdir -p "$OZ_VENDOR_DIR/@openzeppelin"
  rm -rf "$OZ_DST"
  # PNPM creates symlinks that do not resolve inside Docker mounts; dereference them into a local vendor dir.
  cp -R -L "$OZ_SRC" "$OZ_DST"
fi

if [[ ! -x "$SOLC_BIN" ]]; then
  echo "Downloading solc ${SOLC_VERSION}..."
  curl -fsSL "$SOLC_URL" -o "$SOLC_BIN"
  chmod +x "$SOLC_BIN"
fi

IMAGE="trailofbits/eth-security-toolbox:latest"
TARGETS=(
  "contracts/PayInboxVault.sol"
  "contracts/PricingRegistry.sol"
)

echo "Running slither..."
for target in "${TARGETS[@]}"; do
  echo "  - ${target}"
  docker run --rm \
    --platform linux/amd64 \
    -v "$ROOT_DIR":/work \
    -w /work \
    "$IMAGE" bash -lc "
      slither ${target} \
        --solc /work/tools/solc-${SOLC_VERSION} \
        --solc-remaps '@openzeppelin/=tools/vendor/@openzeppelin/' \
        --filter-paths 'node_modules|test|scripts|cache|artifacts|dist|tools/vendor' \
        --fail-medium
    "
done
