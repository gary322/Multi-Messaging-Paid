# MMP Launch Gates

Use this document to determine launch readiness in each environment.

## Gate A — Data Plane Safety

- `DATABASE_BACKEND` must be `postgres` in non-test environments.
- `DATABASE_URL` must be set.
- `PERSISTENCE_STRICT_MODE=true` must be enabled in production to enforce strict checks.
- Multi-instance workers must use Redis when `WORKER_DISTRIBUTED=true`:
  - `REDIS_URL` must be set.
  - Locking code paths in indexer and notification workers must be enabled.

## Gate B — Identity and Auth

- `IDENTITY_ALLOWED_PROVIDERS` can be restricted in production if desired.
- For strict identity verification (`IDENTITY_VERIFICATION_STRICT=true`), ensure at least one of the following is configured:
  - Remote verifier endpoints: `PASSKEY_VERIFY_URL` and/or `SOCIAL_VERIFY_URL`
  - Local provider config:
    - Passkeys: `PASSKEY_RP_ID` + `PASSKEY_ORIGIN`
    - Social OAuth: `OAUTH_GOOGLE_*` and/or `OAUTH_GITHUB_*` credentials
- Wallet derivation for social/passkey is required (`PASSKEY_SOCIAL_NAMESPACE`/namespace fields present and stable).
- Terms controls:
  - `REQUIRE_SOCIAL_TOS_ACCEPTED=true` when legal policy is enforced.
  - `LEGAL_TOS_VERSION` must match requested `termsVersion` in social/passkey verify flows.
  - `LEGAL_TOS_APPROVED_AT` should be populated for production.

## Gate C — Notification Compliance

- At least one provider (`telegram`, `whatsapp`, `x`) is configured for production notification paths.
- If `NOTIFICATION_PROVIDERS_STRICT=true`, provider auth tokens must also be configured:
  - Telegram bot token
  - WhatsApp phone/account pair or webhook token (strict mode will block without auth)
  - X bearer/webhook token
- `/v1/channels/:channel/connect` must reject social channel connections when required terms are missing.

## Gate D — Observability

- Metrics endpoint is enabled via `METRICS_ENABLED=true`.
- Prometheus scrape for `/v1/metrics` is configured.
- Tracing export is enabled via:
  - `OTEL_TRACING_ENABLED=true`
  - `OTEL_TRACES_EXPORT_URL=http://<tempo-host>:4318/v1/traces`
- Alert rules are loaded and routed to `/v1/observability/alert-hook`.
- Grafana dashboards and Alertmanager webhooks pass smoke checks.

## Gate E — Launch Enforcement

- `COMPLIANCE_ENFORCE_LAUNCH=true` must be set for production enforcement.
- `COMPLIANCE_BLOCK_ON_WARN` policy should be decided with platform/legal:
  - `false` allows warning checks to pass with explicit override mode.
  - `true` blocks launch on any warning.
- Validate:
  - `GET /v1/compliance/status`
  - `GET /v1/compliance/alerts`
  - `POST /v1/auth/register` should fail with `launch_not_ready` when enforcement is active and checks fail.
