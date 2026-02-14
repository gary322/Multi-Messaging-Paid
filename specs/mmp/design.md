---
goal: Define the production architecture and implementation approach for `mmp`.
status: draft
---

## 1) High-Level Architecture

```
Client (Web/mobile)
  -> API Gateway (auth, rate limits, authz)
      -> Core Services (users, pricing, messaging, payments, notifications)
          -> Postgres (profiles, policies, message metadata)
          -> Redis (caching, idempotency, queues)
          -> Vault Store (encrypted connector credentials)
  -> Onchain Contracts (Base)
          -> PayInboxVault
          -> PricingRegistry
          -> DirectoryResolver (optional)
  -> Indexer/Worker
          -> Event stream / observability
          -> Delivery workers
```

## 2) Recommended Stack (v1)

- Frontend: Next.js (App Router), TypeScript, Tailwind, WebCrypto for local encryption.
- API: NestJS or Fastify + TypeScript (single codebase, modular monolith).
- Data: Postgres + Prisma; Redis + BullMQ for async jobs.
- Blockchain: Solidity + Hardhat/Foundry, wagmi/viem on frontend.
- Infra: Docker Compose for local stack, GitHub Actions for CI, Terraform for AWS/GCP deployment.
- Telemetry: OpenTelemetry + Prometheus + Grafana + Sentry.

## 3) Smart Contracts

### 3.1 PayInboxVault
- Functions:
  - `deposit(uint256 amount)`
  - `withdraw(uint256 amount)`
  - `sendMessagePayment(address recipient, uint256 amount, bytes32 contentHash, bytes32 messageId, bytes32 channel, uint64 nonce)`
- Storage:
  - `balances[address]`
  - `nonces[address]`
  - `feeBps`, `feeRecipient`
- Event:
  - `MessagePaid(address indexed payer, address indexed recipient, bytes32 indexed messageId, uint256 amount, uint256 fee, bytes32 contentHash, uint64 nonce, uint32 channel)`
- Security:
  - Reentrancy protection on withdrawal
  - Pause by DAO/admin-safe path
  - Nonce checks for replay protection

### 3.2 PricingRegistry
- Functions:
  - `setPricing(address user, uint256 defaultPrice, uint256 firstContactPrice, bool allowFirstContactOnly...)`
  - `setProfileURI(address user, string profileUri)`
  - `setAllowlist(address user, address sender, uint256 discountBps)`
- On-chain stores only identifiers that are not PII.

### 3.3 DirectoryResolver (optional v1.1)
- Handles mapping from canonical human-facing IDs to on-chain or service IDs without storing raw phone on-chain.
- Can be off-chain only with strict signed responses and nonce/challenge mechanism.

## 4) API Surface (First Cut)

- `POST /v1/auth/register`
- `POST /v1/verify/phone`
- `POST /v1/verify/email`
- `GET /v1/identity/{handle}`
- `POST /v1/pricing`
- `GET /v1/pricing/{recipient}`
- `POST /v1/messages/draft`
- `POST /v1/messages/send`
- `GET /v1/inbox/{user}`
- `POST /v1/payments/topup`
- `POST /v1/payments/withdraw`
- `POST /v1/channels/{channel}/connect`
- `GET /v1/channels/{channel}/status`
- `POST /v1/channels/{channel}/disconnect`

## 5) Data Model (Core Tables)

- `users(id, wallet_address, handle, status, created_at, updated_at)`
- `verification_records(id, user_id, channel, target, status, verified_at, expires_at)`
- `pricing_profiles(id, user_id, default_price_usdc, first_contact_price_usdc, allowlist_rules_json)`
- `messages(id, message_id, sender_id, recipient_id, content_hash, price_usdc, status, tx_hash, created_at)`
- `payments(id, tx_hash, sender_id, recipient_id, amount, fee, message_id, confirmed_at, status)`
- `channel_connections(id, user_id, channel, external_handle, encrypted_secret_ref, consent_version, status)`
- `vault_audit_log(id, user_id, event_type, event_at, metadata_json)`

## 6) Credential Suitcase Design

- Client-generated vault key stored in platform secure keychain.
- Encrypted secret payload on server (`vault_blob`, `iv`, `key_version`, `user_salt`).
- Rewrap on new device via passkey challenge and secure recovery path.
- Per-channel token scope and expiry tracking.

## 7) Notification Delivery Logic

- On new payment event:
  1. Indexer validates event signature and marks message as `paid`.
  2. In-app message appears immediately via DB update.
  3. Notification workers fan-out to connected channels.
  4. Failures are retried with exponential backoff and dead-letter queue.

## 8) Security Controls

- JWT/session hardening, CSRF defense, role-based endpoint guards.
- Rate limits:
  - anonymous lookups
  - message send attempts
  - failed verifications
- Anti-fraud:
  - device/IP/user agent anomaly checks
  - sender reputation score
- Secrets:
  - HSM/KMS for server master keys
  - encryption-at-rest for DB + secrets + audit logs.

## 9) Testing Strategy

- Contract:
  - unit tests for payment math, fee logic, pause states, nonce logic
  - forked chain integration for on-chain flows
- Backend:
  - contract-service integration tests for payment + messaging
  - auth and verification unit/integration tests
- API:
  - contract tests for required acceptance criteria
- Notification:
  - queue retry and dead-letter tests
- Security:
  - credential vault encryption/decryption tests
  - endpoint authorization checks and abuse tests
- Chaos:
  - failed RPC, delayed indexing, queue stall, duplicate events

## 10) Deployment Topology

- Environments: local, staging, canary, production.
- Branch gating:
  - lint/test/build
  - contract test + integration test
  - security scan + secrets scan
- Mainnet launch only after 14-day staged canary with rollback criteria.
