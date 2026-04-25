# Observability stack

Trawler ships its own metrics + log aggregation: **Prometheus 3.11.2** scrapes the two `/metrics` endpoints, **Loki 3.7.1** stores tailed logs (shipped by **Alloy 1.16.0**), and **Grafana 13.0.1** queries both. Everything runs as systemd user services alongside Trawler.

Dashboard: **http://&lt;host&gt;:3001/** (default `admin` / `admin` on first login — change immediately).

## Layout on the mini

```
~/observability/
  bin/                   prometheus, promtool, loki, alloy
  grafana/               extracted Grafana 13.0.1 (binary + plugins)
  etc/                   prometheus.yml, loki.yml, alloy.alloy, grafana/...
  data/                  TSDB, log chunks, Grafana DB, dashboards
  log/                   per-service stdout/stderr
```

The provisioned dashboard JSON lives at `~/observability/data/grafana-dashboards/trawler.json` (sourced from `ops/grafana/trawler-dashboard.json` in this repo).

## Ports (bind to 127.0.0.1 unless otherwise noted)

| Service     | Port  | Bind     | Notes |
|-------------|-------|----------|-------|
| Trawler feed | 3000  | 0.0.0.0 | `/metrics` scraped by Prometheus |
| Grafana     | 3001  | 0.0.0.0 | the only piece exposed on mesh |
| Trawler matching | 3002 | 0.0.0.0 | `/metrics` scraped by Prometheus |
| Loki        | 3100  | 127.0.0.1 | querying via Grafana |
| Prometheus  | 9090  | 127.0.0.1 | querying via Grafana |
| Alloy UI    | 12345 | 127.0.0.1 | local debug only |

## Operate

```
ssh mini systemctl --user status prometheus loki alloy grafana
ssh mini journalctl --user -u prometheus -f
ssh mini tail -f observability/log/grafana.log
ssh mini systemctl --user restart grafana    # apply ini changes
```

The four services start in order via `After=`/`Wants=` in their unit files: prometheus → loki → alloy → grafana.

## Apply config changes

The configs in this repo are the source of truth. To apply:

```
scp ops/observability/etc/prometheus.yml mini:observability/etc/
ssh mini systemctl --user restart prometheus
# or, if Prometheus only needs config reload:
ssh mini "curl -X POST http://127.0.0.1:9090/-/reload"
```

For dashboards, push to `~/observability/data/grafana-dashboards/` — Grafana provisioning watches the directory every 30 seconds.

If file-based dashboard provisioning doesn't pick up changes (Grafana 13's new
provisioning service has been finicky with custom paths), force-import via API:

```sh
ssh mini 'curl -s -u admin:<password> -X POST -H "Content-Type: application/json" \
  -d "$(jq -n --slurpfile d ~/observability/data/grafana-dashboards/trawler.json \
    "{dashboard: \$d[0], overwrite: true}")" \
  http://127.0.0.1:3001/api/dashboards/db'
```

To reset the admin password (e.g., after losing access):

```sh
ssh mini systemctl --user stop grafana
ssh mini "cd ~/observability/grafana && ./bin/grafana cli \
  --homepath . --config ~/observability/etc/grafana/grafana.ini \
  admin reset-admin-password '<new-password>'"
ssh mini systemctl --user start grafana
```

## What's exposed as metrics

From `src/dashboard.ts` (port 3000):
- `trawler_companies_total`, `_active`, `_disabled`
- `trawler_companies_by_ats{ats=...}`
- `trawler_jobs_total`
- `trawler_discovery_yield{source=...}`, `_unique_contribution`
- `trawler_scheduler_in_flight`, `_polls_total{result=success|fail}`
- `trawler_aimd_current_concurrent{ats}`, `_ceiling_concurrent`, `_current_interval_ms`, `_ceiling_interval_ms`, `_clean_window`
- `trawler_freshness_jobs_total{ats}`, `_with_posted_at`, `_avg_lag_ms`
- `trawler_recent_poll_errors`

From `src/matching/serve.ts` (port 3002):
- `trawler_matching_loop_ticks_total`, `_jobs_qualified_total`, `_push_found_total`, `_digest_found_total`, `_last_tick_seconds`
- `trawler_matches_total`, `_push`, `_digest`
- `trawler_matches_unlabeled{tier=push|digest}`, `_new_since_view`
- `trawler_labels_total`, `_labels_today`

The matching `/metrics` endpoint is cached for 20 s — it does ~200 sqlite hits per real call (per-result hard-constraint re-validation), so unbatched scrapes blew past the 10 s default Prometheus scrape timeout.

## Tempo (deferred)

Trawler isn't OpenTelemetry-instrumented yet, so Tempo would just be empty storage. When traces become useful (e.g., qualifier latency by job), install Tempo and wire `traces_enabled = true` in `grafana.ini`.

## Bootstrap (rebuild stack from scratch)

If the mini is wiped or you set up a new host:

```
mkdir -p ~/observability/{bin,etc,data,log}
cd ~/observability

# Prometheus
curl -sLo p.tgz https://github.com/prometheus/prometheus/releases/download/v3.11.2/prometheus-3.11.2.linux-amd64.tar.gz
tar xzf p.tgz && mv prometheus-3.11.2.linux-amd64/{prometheus,promtool} bin/ && rm -rf prometheus-3.11.2.linux-amd64 p.tgz

# Loki
curl -sLo l.zip https://github.com/grafana/loki/releases/download/v3.7.1/loki-linux-amd64.zip
unzip -q l.zip && mv loki-linux-amd64 bin/loki && chmod +x bin/loki && rm l.zip

# Alloy
curl -sLo a.zip https://github.com/grafana/alloy/releases/download/v1.16.0/alloy-linux-amd64.zip
unzip -q a.zip && mv alloy-linux-amd64 bin/alloy && chmod +x bin/alloy && rm a.zip

# Grafana
curl -sLo g.tgz https://dl.grafana.com/oss/release/grafana-13.0.1.linux-amd64.tar.gz
tar xzf g.tgz && mv grafana-13.0.1 grafana && rm g.tgz
```

Then copy configs:
```
mkdir -p ~/observability/etc/grafana/provisioning/{datasources,dashboards}
mkdir -p ~/observability/data/grafana-dashboards
scp -r ops/observability/etc/* mini:observability/etc/
scp ops/grafana/trawler-dashboard.json mini:observability/data/grafana-dashboards/trawler.json
scp ops/observability/systemd/* mini:.config/systemd/user/
ssh mini systemctl --user daemon-reload
ssh mini systemctl --user enable --now prometheus loki alloy grafana
```
