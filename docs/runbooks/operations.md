# Operations Runbook

## Scope

This runbook applies to API + background workers in local and production-like environments.

## Daily Health Checks

- Confirm API health: `GET /health`
- Confirm compliance state: `GET /v1/compliance/status`
- Confirm metrics exposure: `GET /v1/metrics` (with `x-metrics-token` if enabled)
- Confirm queue depth: `GET /v1/observability/alerts`
- Confirm worker status by checking `/v1/observability/snapshot`

## Incident Response

### Elevated queue depth

1. Confirm `GET /v1/observability/alerts`.
2. If only temporary, wait 5 minutes and re-check.
3. If persistent:
   - verify Redis/Postgres are reachable (for distributed mode),
   - verify chain worker liveness (`CHAIN_INDEXER_ENABLED=true`),
   - verify notification providers configured and online.
4. If unresolved, stop message ingress by toggling maintenance flag in deployment flow.

### Repeated delivery failures

1. Inspect dead-letter and failed jobs in `/v1/compliance/alerts`.
2. Validate notification provider secrets and endpoint reachability.
3. Inspect `mmp_delivery_jobs_...` metrics in Grafana for trend.
4. Retry jobs after fixing upstream provider/secret issues.

### Indexer lag

1. Review `/v1/observability/snapshot`.
2. Confirm `pendingDeliveryAgeMs` and indexer lag counters are not exploding.
3. Confirm chain RPC is healthy and indexer config (`CHAIN_RPC_URL`, `CHAIN_VAULT_ADDRESS`) is set.

## Deployment Checklist

- Run `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build`
- Run contract+API smoke: `pnpm run e2e:local`
- Run stack run: `bash ./scripts/e2e-stack.sh`
- Confirm `METRICS_ENABLED` and observability exports are green
- Confirm `COMPLIANCE_ENFORCE_LAUNCH` state aligns with policy

## Rollback

- Stop API process/containers.
- Revert environment to last known-good configuration.
- Restore identity/auth provider secrets from backup.
- Re-enable DB and queue workers after checks pass.
