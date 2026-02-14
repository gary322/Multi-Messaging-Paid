# Contract Audit Readiness Checklist (MMP)

This checklist is intended to be run before any mainnet deployment of `PayInboxVault` and `PricingRegistry`.

## Scope

- `contracts/contracts/PayInboxVault.sol`
- `contracts/contracts/PricingRegistry.sol`
- `contracts/contracts/MockERC20.sol` (test-only)

## Build + Tests (Required)

- `pnpm --dir contracts build`
- `pnpm --dir contracts test`
- Local smoke: `pnpm run e2e:local`

## Static Analysis (Required)

- Slither: `pnpm --dir contracts audit:slither`
- Review Slither output and resolve/justify any High/Medium findings.

## Manual Review (Required)

- Access control:
  - Owner-only functions are minimal and correct (`pause`, `unpause`, `setFeeConfig`).
  - Ownership transfer procedures are documented (operational runbook).
- Pause semantics:
  - All state-changing money movement is blocked when paused.
- Reentrancy:
  - External token transfers are guarded (`nonReentrant`).
  - No external calls after state updates that could be re-entered.
- ERC20 safety:
  - `transferFrom`/`transfer` return values checked.
  - Token decimal assumptions are off-chain only; on-chain amounts are raw token units.
- Invariants:
  - `balances[payer]` decreases by `amount + fee` on `sendMessagePayment`.
  - `balances[recipient]` increases by `amount`.
  - `balances[feeRecipient]` increases by `fee`.
  - `feeBps <= MAX_FEE_BPS`.
  - `nonces[payer]` strictly increases.
- Event schema:
  - `MessagePaid` includes payer/recipient/messageId/contentHash/channel/amount/fee/nonce.
  - Event is emitted exactly once per successful payment.
- Abuse surfaces:
  - Ensure messageId/contentHash are treated as opaque receipts (no on-chain PII).
- Upgradeability:
  - Current contracts are non-upgradeable. Confirm this is acceptable for v1.

## Deployment / Ops (Required)

- Confirm fee recipient address for each environment.
- Confirm owner key custody (multisig recommended for production).
- Confirm pause/unpause runbook and monitoring alerts for unexpected pauses.

