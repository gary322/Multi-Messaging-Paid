# MMP Local Observability Stack

This workspace ships a local observability compose stack for Prometheus, Alertmanager, Grafana, and Tempo (tracing).

## Files

- `infra/docker-compose.observability.yml` — local stack orchestrator
- `infra/observability/prometheus.yml` — scrape config
- `infra/observability/prometheus-alerts.yml` — Prometheus alerting rules
- `infra/observability/alertmanager.yml` — Alertmanager route/webhook settings
- `infra/observability/grafana/provisioning` — Grafana datasources and dashboards provisioning
- `infra/observability/grafana/dashboards/mmp-overview.json` — starter dashboard
- `infra/observability/tempo.yaml` — Tempo config (OTLP ingest + trace storage)

## Run

1. Start API services that expose metrics: set `METRICS_ENABLED=true` and run with any server/process that serves `/v1/metrics`.
   - For traces, set:
     - `OTEL_TRACING_ENABLED=true`
     - `OTEL_TRACES_EXPORT_URL=http://localhost:4318/v1/traces`
2. Start observability stack:

```bash
docker compose -f infra/docker-compose.observability.yml up -d
```

3. Open dashboards:

- Prometheus: http://localhost:9090
- Alertmanager: http://localhost:9093
- Grafana: http://localhost:3000

Grafana default admin credentials are:

- Username: `admin`
- Password: `mmp-grafana-admin`

## API endpoints used

- `GET /v1/metrics`  
  Raw Prometheus format when `METRICS_ENABLED=true`.
- `GET /v1/observability/alerts`  
  Structured runtime health and threshold checks.
- `POST /v1/observability/alert-hook`  
  Receives and records Alertmanager callbacks.

## Alert policy

The included Prometheus rules create alerts for:

- delivery backlog (`mmp_delivery_jobs_pending_total`)
- dead-letter usage (`mmp_delivery_jobs_dead_letter_total`)
- sustained delivery failures (`increase(mmp_delivery_jobs_failed_total[5m])`)

Alertmanager routes webhook callbacks to `/v1/observability/alert-hook`.
