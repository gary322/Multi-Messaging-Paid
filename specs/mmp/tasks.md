---
goal: Build and ship production MVP of `mmp` over 5 execution phases.
status: draft
---

## Phase 0 — Foundation and Scaffolding (Weeks 1–2)

- [ ] 0.1 Initialize monorepo structure (`apps/web`, `apps/api`, `contracts`, `infra`, `docs`) with lint/type/test toolchains.
  - Files: `pnpm-workspace.yaml`, `package.json`, service configs.
  - Done when: local `pnpm install` and `pnpm test` can be run.

- [ ] 0.2 Set up secure CI/CD skeleton with formatting, type check, unit tests, and security scan.
  - Files: `.github/workflows/ci.yml`
  - Done when: each pull request runs compile/test/lint and blocks on failure.

- [ ] 0.3 Provision environments and secrets handling.
  - Files: `infra/`, deployment templates, secret naming strategy.
  - Done when: staging deploy works and service health checks pass.

## Phase 1 — Smart Contracts and Indexing (Weeks 2–4)

- [ ] 1.1 Implement `PayInboxVault` contract with internal balances, deposits, withdrawals, message payments, fee config, and pause.
  - Files: `contracts/src/PayInboxVault.sol`
  - Verify: unit tests for deposits/withdraws/limits/no reentrancy and nonce checks.

- [ ] 1.2 Implement `PricingRegistry` contract for pricing and allowlist pointers.
  - Files: `contracts/src/PricingRegistry.sol`
  - Verify: unit tests for price reads and invalid updates.

- [ ] 1.3 Add hardhat/foundry deployment scripts and local testnet scripts.
  - Files: `contracts/scripts/deploy.ts`, `contracts/test/*`
  - Verify: complete deploy + upgrade dry-runs in local fork.

- [ ] 1.4 Build chain indexer for `MessagePaid` and pricing/events synchronization.
  - Files: `apps/api/src/indexer/*`
  - Verify: receives mock txs and writes message payment states.

- [ ] 1.5 Contract audit readiness pass 1 (internal review checklist + automated slither run).
  - Files: `docs/security/audit-checklist.md`
  - Done when: no open high-severity issues.

## Phase 2 — Identity, Verification, and Auth (Weeks 4–6)

- [ ] 2.1 Implement passkey/social login flow and smart account bootstrap on Base.
  - Files: `apps/web`, `apps/api/src/auth/*`
  - Done when: end-to-end register/login and wallet-linked profile created.

- [ ] 2.2 Implement phone verification (OTP) + email verification (magic link or OTP).
  - Files: `apps/api/src/verification/*`
  - Done when: replay-safe verification states and expiry tested.

- [ ] 2.3 Add user profile and public ID management (`@handle`, optional basename binding).
  - Files: `apps/api/src/profile/*`, `apps/web/src/*`
  - Done when: handle uniqueness and rotation constraints enforced.

- [ ] 2.4 Build pricing settings API and UI (default and first-contact price).
  - Files: `apps/api/src/pricing/*`, `apps/web/src/pages/*`
  - Done when: recipient can set prices and sender reads correct values.

## Phase 3 — Core Product: Paid Messaging (Weeks 6–9)

- [ ] 3.1 Implement message compose/send path with content hash generation and encryption-at-rest wrapper.
  - Files: `apps/web/src/*`, `apps/api/src/messages/*`
  - Done when: payment and message record created only after signature/tx confirmation path.

- [ ] 3.2 Implement prepaid top-up and payout path.
  - Files: `apps/web/src/payments/*`, `apps/api/src/payments/*`
  - Done when: top-up, balance checks, withdrawals pass end-to-end tests.

- [ ] 3.3 Implement in-app inbox with tabs (`Paid`, `Requests`, `Threads`) and recipient-side message lifecycle.
  - Files: `apps/web/src/inbox/*`
  - Done when: paid messages show in inbox immediately once indexer confirms.

- [ ] 3.4 Implement sender search and recipient card with pricing preview.
  - Files: `apps/web/src/send/*`, `apps/api/src/discovery/*`
  - Done when: search by handle/phone alias works with proper privacy checks.

## Phase 4 — Notifications, Suitcase, Compliance, and Ops (Weeks 9–11)

- [ ] 4.1 Implement encrypted credential suitcase with server-stored ciphertext only.
  - Files: `apps/api/src/vault/*`, encryption utility modules
  - Done when: DB dumps contain no plaintext channel secrets.

- [ ] 4.2 Integrate Telegram bot notify, WhatsApp opt-in flow, and X optional notify.
  - Files: `apps/api/src/channels/*`
  - Done when: optional notification workers send only after explicit consent.

- [ ] 4.3 Add abuse controls: rate limits, anti-fraud scoring, reporting, blocks.
  - Files: API gateways, Redis/rules, background jobs.
  - Done when: policy actions can pause senders and auto-throttle anomalies.

- [ ] 4.4 Observability and SLOs.
  - Files: `apps/*/telemetry/*`, dashboard definitions.
  - Done when: alerting exists for tx failure, queue backlog, high withdrawal spikes.

## Phase 5 — Testing, Hardening, and Launch Prep (Weeks 11–14)

- [ ] 5.1 End-to-end scenarios:
  - recipient onboarding -> set pricing -> sender sends -> payment event -> inbox receive -> notification.
  - top up -> send chain of messages -> insufficient balance -> top-up -> send again.
  - withdrawal and failed notification recovery.
  - Files: `apps/e2e/*`, `apps/api/test/*`, `contracts/test/*`
  - Done when all acceptance tests in `requirements.md` pass.

- [x] 5.2 Pen-test style security pass: auth abuse, IDOR, replay, injection, and permission bypass.
  - Files: security test checklist + fixes.
  - Done when no high/critical issues remain.

- [x] 5.3 Performance and reliability validation.
  - Files: load test scripts, chaos test jobs.
  - Done when target p95 latencies and recovery criteria are met.

- [ ] 5.4 Run canary release.
  - Files: release playbook
  - Done when: stable staged rollout with defined rollback threshold for 14 days.

- [ ] 5.5 Production readiness review and launch.
  - Files: `docs/runbooks/*`, `docs/post-launch-incident.md`
  - Done when: legal/compliance sign-off and ops runbook are approved.

## Long-Term Roadmap (Post-MVP)

- [ ] Enable in-app encrypted E2E and group keys.
- [ ] Add auto-dispute/refund mechanics with reputation weighting.
- [ ] Add merchant/API access for paid reach APIs.
- [ ] Add team/shared inbox and business-tier pricing.
- [ ] Add cross-chain expansion if required.

## Quality Gates (Mandatory)

- [ ] Contract gas budget and event schema lock.
- [ ] 95% of critical paths with automated tests.
- [ ] Zero storage of plaintext channel OAuth tokens in logs/analytics.
- [ ] Confirmed platform policy-compliant channels before enabling production credentials.
