# MMP (Multi-Messaging Paid Inbox)

MMP is a production-style, end-to-end local MVP for a **micropayment-enabled paid inbox**:

- Users onboard and verify **phone + email**
- Users can connect optional notification channels (**Telegram / WhatsApp / X**) with explicit consent gates
- Messages are **paid** (simulated ledger by default, with **on-chain flows** supported via the local Hardhat chain)
- A production-style **indexer** + **delivery worker** pipeline processes events and retries notifications
- Built-in **launch readiness** / **compliance** checks, abuse controls, and an observability stack

Monorepo layout:

- `api/`: Fastify API (TypeScript)
- `contracts/`: Solidity contracts (Hardhat)
- `web/`: Next.js UI (minimal MVP)
- `infra/`: Docker Compose for local Postgres/Redis + observability (Prometheus/Grafana/Tempo)
- `scripts/`: end-to-end runners

## Prerequisites

- Node.js + pnpm
- Docker (for `scripts/e2e-stack.sh` and observability stack)

## Bootstrap

```bash
pnpm install
```

## Quality Gates

```bash
pnpm run ci
pnpm run hardening
```

## End-to-End (Local)

Local chain + contracts + API integration tests:

```bash
pnpm run e2e:local
```

Production-style local stack (Postgres + Redis + Hardhat + deploy + indexer/worker + full API test suite):

```bash
bash scripts/e2e-stack.sh
```

## Observability (Local)

Spin up Prometheus + Grafana + Alertmanager + Tempo and verify metrics + trace export:

```bash
bash scripts/observability-smoke.sh
```

Grafana is exposed on `${MMP_GRAFANA_PORT:-3001}`.

## Production Notes

- For multi-instance durability, run the API with:
  - `DATABASE_BACKEND=postgres` and `DATABASE_URL=...`
  - `WORKER_DISTRIBUTED=true` and `REDIS_URL=...`
  - `PERSISTENCE_STRICT_MODE=true`
- Launch readiness checks can be viewed via:
  - `GET /v1/compliance/launch-readiness`
- External channels are treated as **opt-in notification rails**; the canonical inbox is in-app.

