# Trawler

Job-intelligence service. Continuously polls ATS platforms (Greenhouse, Lever, Ashby, Workable), qualifies new postings against a structured profile with an LLM, surfaces strong matches in a self-hosted dashboard.

The product, the architecture, and the discipline are documented separately:

- **`spec.md`** — what Trawler is, who uses it, what it must do.
- **`feed.md`** — ingestion (discovery, polling, dedup).
- **`matching.md`** — qualification (profile, retriever, qualifier, alerts).
- **`CLAUDE.md`** — engineering invariants and session discipline.
- **`CHANGELOG.md`** — every behavioral change with the reasoning behind it.

This file is the operator's reference: how to run it, where data lives, how to extend it.

## Quickstart

```sh
npm install
cp profile.example.json profile.local.json   # then edit to describe yourself
npm start
```

`profile.local.json` is gitignored — keep your real profile out of the repo. Trawler reads it (or `$TRAWLER_PROFILE_PATH` if you set it) at startup and uses it to score matches.

`npm start` brings up the whole product: scheduler (continuous polling), matching loop (continuous qualification of new jobs), and both dashboards.

- **http://localhost:3000/** — health dashboard (universe, poll rates, AIMD state, freshness lag, broken sources). Also exposes `/metrics` in Prometheus exposition format.
- **http://localhost:3002/** — matching dashboard (push matches, digest, labels, loop status). Also exposes `/metrics`.

In production deployment the canonical dashboard is **Grafana** (port 3001), which queries Prometheus + Loki for richer time-series and log views — see [`ops/observability/README.md`](ops/observability/README.md).

The matching dashboard auto-refreshes every 60 seconds; new matches surface with a green **NEW** badge until you click *Mark all seen*.

### First-time setup

If `trawler.db` is empty, run discovery before `npm start`:

```sh
npx tsx src/discover.ts                  # OSS lists + GitHub seeds
npx tsx src/run-cc-discovery.ts          # Common Crawl (large universe)
npx tsx src/calibrator.ts                # tune per-ATS rate limits (writes calibration/history.jsonl)
```

## Configuration

| Env var | Default | What it does |
|---|---|---|
| `TRAWLER_DB` | `trawler.db` | SQLite path (WAL mode, dedup via `UNIQUE(company_id, external_id)`) |
| `TRAWLER_PORT` | `3000` | Health dashboard port |
| `TRAWLER_MATCHING_PORT` | `3002` | Matching dashboard port |
| `TRAWLER_BIND` | `0.0.0.0` | Interface to bind (use `127.0.0.1` for local-only) |
| `TRAWLER_NO_MATCHING` | unset | Set to `1` to skip the matching loop |
| `TRAWLER_PROFILE_PATH` | `profile.local.json` → `profile.example.json` | Path to the profile JSON the qualifier uses |

The Anthropic CLI (`claude`) must be on `PATH` and authenticated for the qualifier and labeler.

## Repository layout

```
src/
  main.ts                  entry point — boots scheduler + matching loop + dashboards
  store.ts                 SQLite schema, upsert, dedup
  scheduler.ts             AIMD-driven polling loop, auto-disable on consecutive failures
  dashboard.ts             health dashboard (port 3000)
  schema.ts                Zod schemas for Company, Job, etc — validated at boundaries
  adapters/                one file per ATS (greenhouse, lever, ashby, workable)
  discovery/               OSS lists, Common Crawl, GitHub code-search
  matching/
    profile.ts             user profile (data, not prompt — re-tunable without code)
    hard-constraints.ts    deterministic filters (years, location, exclude patterns)
    retriever.ts           BM25 + feature rerank
    qualifier.ts           Sonnet-based scorer; structured JSON output
    llm-labeler.ts         Opus-based independent labeler for benchmark testset
    loop.ts                continuous qualification of newly-ingested jobs
    serve.ts               matching dashboard (port 3002)
    pipeline.ts            one-shot pipeline (manual / benchmark mode)

benchmarks/
  feed/                    feed bench + history.jsonl
  matching/
    bench.ts               matching bench (precision, recall, calibration vs LLM labels)
    history.jsonl          append-only metric history
    labels.json            user labels (applied / interested / not_interested / false_positive)
    llm-labels.jsonl       Opus-generated testset labels
    results/               pipeline-{ts}.json — qualifier outputs (latest-wins dedup)
    dashboard-state.json   last_viewed_at (transient, gitignored)

calibration/
  history.jsonl            per-ATS rate-limit calibration runs
```

## Daily operation

### Label new matches

The dashboard's four buttons (Applied / Interested / Not Interested / False Positive) feed the precision metric. Label whatever you act on — the bench surfaces precision trend over labels accumulated.

### Run the bench

```sh
npx tsx benchmarks/matching/bench.ts "what changed this run"
```

Reports precision against user labels, against an Opus-labeled testset, and the calibration agreement between them. History appends to `benchmarks/matching/history.jsonl`.

### Refresh the LLM testset

```sh
npx tsx src/matching/run-labeler.ts --n=60
```

Stratified sample across score bands, persists to `llm-labels.jsonl`. Skips already-labeled jobs.

### One-shot pipeline (no loop)

```sh
npx tsx src/matching/pipeline.ts --top-k=500 --top-n=60 --batch=20 --model=sonnet
npx tsx src/matching/pipeline.ts --exclude-evaluated  # skip jobs already scored
```

### Poll a specific batch (no loop)

```sh
npx tsx src/poll-batch.ts --count=500 --concurrency=15 --mode=unpolled
```

Modes: `unpolled` (default; targets companies with no jobs in DB), `random` (legacy uniform sample).

## Self-host deployment

Trawler is meant to run always-on on a small Linux box you control (a mini PC, VPS, or homelab host). The commands below assume you've set up an SSH alias `mini` in `~/.ssh/config` pointing at your host — substitute your own name. A mesh network (Tailscale, NordLynx, ZeroTier, etc.) is the easiest way to reach the dashboards from anywhere; with `TRAWLER_BIND=0.0.0.0` (the default) the dashboards listen on every interface.

The unit file lives at `~/.config/systemd/user/trawler.service`:

```sh
ssh mini systemctl --user status trawler         # health
ssh mini journalctl --user -u trawler -f         # logs (systemd)
ssh mini tail -f Projects/trawler/trawler.log    # logs (file)
ssh mini systemctl --user restart trawler        # apply code changes
ssh mini systemctl --user stop trawler           # halt
```

Linger is enabled (`loginctl enable-linger`), so the service survives logout.

### Push code updates from your dev machine

```sh
git push                                         # to GitHub
ssh mini 'cd ~/Projects/trawler && git pull && systemctl --user restart trawler'
```

## Discipline

Every behavioral change goes in `CHANGELOG.md` with the reasoning. Benchmarks live next to the capability they measure and append every run to `history.jsonl`. See `CLAUDE.md` for the four-property evaluation rubric (latency, fidelity, observability, operational simplicity), in priority order.

The product is always on. Downtime is a failure of obligation to users, not a technical footnote.
