# mmp Execution Plan (End-to-End)

## Phase 0 — Foundation
- Deliverables
  - Monorepo bootstrapped (`contracts`, `api`, `web`) with shared TS config
  - Deterministic quality gates: `pnpm test`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r build`
  - CI workflow running all gates on push/PR
- Evidence
  - `package.json` scripts plus `.github/workflows/ci.yml`
  - `specs/mmp/.progress.md` initialized

## Phase 1 — Core Contracts
- Deliverables
  - `PayInboxVault` for deposit/withdraw/send with fee + pause + events
  - `PricingRegistry` for profile pricing state
  - Hardhat tests for success and failure paths
- Evidence
  - `contracts/contracts/*`
  - `contracts/test/PayInboxVault.test.ts`
  - `contracts/scripts/deploy.ts`

## Phase 2 — API Core
- Deliverables
  - Auth/session routes, verification, profile/recipient lookup, pricing, messages, channels
  - Message transfer accounting and inbox persistence
  - Encrypted channel secret storage helpers
- Evidence
  - `api/src/routes/*.ts`
  - `api/src/lib/{db.ts,vault.ts}`
  - `api/tests/*.spec.ts`

## Phase 3 — Web MVP UX
- Deliverables
  - Single-page flow for onboarding, verify, pricing, top-up, send, connect channels, inbox
  - Responsive shell + design direction
- Evidence
  - `web/app/page.tsx`
  - `web/app/globals.css`

## Phase 4 — Operations & Hardening
- Deliverables
  - Deterministic local testing env and reset behavior
  - Rate limiting and structured logging
  - Buildability + CI gate for all packages
- Evidence
  - `api/src/lib/rateLimit.ts`
  - `api/src/index.ts`
  - `.github/workflows/ci.yml`

## Phase 5 — Test & Release Readiness
- Deliverables
  - End-to-end green local checks for contracts + API + web compile
  - Reproducible local bootstrap command: `pnpm run e2e:local`
  - Remaining gaps explicitly documented before production launch
- Evidence
  - `pnpm test`
  - `pnpm -r typecheck`
  - `pnpm -r lint`
  - `pnpm -r build`
  - `specs/mmp/.progress.md`

## Production Readiness Boundaries
- In-scope now: production-style local MVP + contract logic + API contract + UI flow.
- Remaining out-of-scope for this pass:
  - Full security audit and threat model hardening
  - Performance/chaos and SLA validation harness
  - Full production launch canary + rollback policy
