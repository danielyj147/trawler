# Changelog

All notable changes to Trawler are recorded here.

This project follows [Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Each entry explains **why** the change was made, not just what changed. When a change is meant to move a benchmark metric, the entry states the before and after values. Written well, this changelog is the history, the decision record, and the record of progress.

## [Unreleased]

### Added

- **Observability stack on the mini (Prometheus + Loki + Alloy + Grafana).**
  Both Trawler dashboards now expose `/metrics` in Prometheus exposition
  format. Prometheus 3.11.2 scrapes them every 15 s. Alloy 1.16.0 tails
  `trawler.log` and ships to Loki 3.7.1. Grafana 13.0.1 (port 3001) is
  provisioned with both datasources and a "Trawler Overview" dashboard
  (universe, scheduler, matching loop, AIMD per-ATS, ingested-jobs trend,
  live log panel). All four services run as systemd user units alongside
  trawler. Configs and dashboard JSON committed to `ops/observability/`
  and `ops/grafana/` so the stack rebuilds reproducibly. Versions chosen
  by querying upstream `releases/latest` rather than relying on linuxbrew
  (which lagged 1+ majors on Grafana). Tempo deferred — Trawler isn't
  OTel-instrumented yet, so Tempo storage would be empty.

### Changed

- **Snapshot cache for matching `/metrics`.** `buildSnapshot()` does ~200
  sqlite queries per call (per-result hard-constraint re-validation).
  First call is ~5 s; Prometheus scrapes every 15 s with a 10 s timeout.
  Without caching the matching target stayed `down` indefinitely.
  Added a 20 s TTL cache; live loop counters re-attached on every read.
  Cached calls now return in 7 ms.

### Changed

- **Dashboard: inbox-style triage UI.** The previous matching dashboard mixed
  labeled and unlabeled jobs, required a full page reload on every label
  click, and offered no keyboard shortcuts — every visit was a re-scan and
  every label cost a click and a reload. The user reported frustration
  triaging matches.

  Rebuilt around the actual job: see new unlabeled matches and decide on
  each in one keypress. Filters (Unlabeled default / All / Applied+
  Interested / Passed), tier toggle (Push default / Digest / Both), sort
  (Newest first / Highest score), all persisted to localStorage. Each
  filter chip carries a count so the queue size is visible without
  scrolling. Keyboard: J/K to navigate, A/I/N/F (or 1/2/3/4) to label,
  0 to clear, O/Enter to open the job, U to undo last label, ? for help,
  R to refresh.

  Single `/api/state` snapshot replaces page reload — labels are
  optimistic with a toast undo link. "Caught up" empty state when
  filtered-unlabeled is empty. Opus LLM verdicts (fit/borderline/unfit)
  shown as a third-party signal alongside the qualifier score. Compact
  card layout with reasoning collapsed by default; opens on focus or
  Space. "Labeled today" stat for momentum.

- **Favicon.** Inline SVG (stacked-chevron net + green status dot)
  served as both `<link rel="icon">` and `/favicon.ico` so it appears
  in the browser tab regardless of how the request is made.

### Added

- **README.md.** Operator reference: quickstart, env vars, repo layout,
  daily operation, mini-PC deployment commands. Pointers into spec/feed/
  matching/CLAUDE for deeper context. Was missing because all docs were
  intentional design docs, not getting-started material.

- **GitHub remote.** Mini's working copy is a git clone — push from dev
  box, `ssh mini 'cd ~/Projects/trawler && git pull && systemctl --user
  restart trawler'` to deploy.

- **Loop tuning experiment + bench (`src/matching/bench-loop.ts`).** Times
  BM25 + rerank, LLM batch, and total tick across top-N values; reports
  projected jobs/hr if the cadence ran continuously. Ran on the mini at
  top-N ∈ {10, 30, 60}, batch=20, sonnet:

  | top-N | BM25 | LLM total | LLM/job | tick total | jobs/hr |
  |-------|------|-----------|---------|------------|---------|
  | 10    | 37s  | 131s      | 13s     | 168s       | 215     |
  | 30    | 37s  | 206s      | 6.9s    | 243s       | 445     |
  | 60    | 37s  | 13s*      | 0.2s    | 50s        | 4336*   |

  *the top-N=60 run hit a batch where the BM25 picks were short non-US
  rejects; the LLM resolved them in a single 13s call. Don't read it as
  steady-state.

  BM25 is a constant ~37s on the mini (74K jobs in memory). It dominates
  small-N ticks. Decision: keep `topN=30, intervalMs=5min, idleIntervalMs=
  15min` — 247s tick, 53s idle margin, 360 jobs/hr sustained. Bigger N
  exceeds the interval; smaller N wastes cycles on BM25 overhead. Loop
  knobs are now env-var-tunable (`TRAWLER_MATCH_TOPN`, etc.) so we can
  adjust without redeploys.

  Future optimization: cache the BM25 index across ticks and incrementally
  add new jobs. Would drop tick floor from 247s to ~210s and free CPU for
  the polling scheduler.

### Fixed

- **Qualifier parser: brittle greedy regex caused 100% parse-failure on
  some batches.** `raw.match(/\[[\s\S]*\]/)` extracts from the FIRST `[`
  in the response (often inside the LLM's prose like "this candidate has
  [strong skills]") to the LAST `]`, producing un-parseable text. New
  `extractJsonArray` walks the response with bracket-depth tracking and
  string-state awareness, returning only a balanced `[...]` containing
  `{`. Strips markdown fences first. Observed in loop-bench top-N=10 run:
  10/10 jobs flagged "Failed to parse batch JSON" with the old code; new
  parser handles the same outputs correctly.

- **`bench-loop.ts`: `require('os').hostname()` in ESM module.** Threw
  ReferenceError after summary printed. Switched to `import * as os`.

### Changed

- **systemd unit: `NODE_OPTIONS=--max-old-space-size=8192`.** Loading 74K
  jobs with full `raw_json` for BM25 indexing pushed the V8 heap past
  the 4GB default, OOM-killing the bench. Bumped to 8GB. Real fix is to
  slim the SQL projection (load descriptions only for top-K), but that's
  a refactor; bumping the heap is the right immediate move.

### Added

- **Always-on matching loop.** `src/matching/loop.ts` runs in the same process
  as the polling scheduler. Every 5 min (15 min when no fresh jobs are
  available) it: finds jobs not yet in any pipeline-*.json, runs BM25 + rerank
  to pick the top-30 candidates, batch-qualifies with sonnet, and writes a
  pipeline-*.json. New push matches surface on the dashboard automatically —
  the operator does not click anything. `npm start` launches scheduler +
  matching loop + both dashboards together; spec says "always on", and now it
  actually is.

- **Matching dashboard: NEW badges, auto-refresh, no manual button.** Each
  result carries a `_added_at` mtime from its source pipeline file; results
  whose mtime exceeds `last_viewed_at` (saved to
  `benchmarks/matching/dashboard-state.json`) get a "NEW" pill. The page
  auto-refreshes every 60 s. The "Find Next Batch" button is gone — it was a
  manual lever for a continuous problem. A "Mark all seen" link replaces it.

- **Mini-PC deployment.** systemd user service
  (`~/.config/systemd/user/trawler.service`) runs the whole stack on the mini.
  Linger is on, so it survives logout. Both dashboards bind `0.0.0.0` for mesh
  access — reach from any device on the mesh:
  `http://<mesh-ip>:3000/` (health), `http://<mesh-ip>:3002/` (matching).
  `TRAWLER_BIND` / `TRAWLER_PORT` / `TRAWLER_MATCHING_PORT` /
  `TRAWLER_NO_MATCHING` env vars expose the knobs.

### Changed

- **Qualifier and labeler: async claude CLI calls.** `execFileSync` was
  blocking the Node event loop while the LLM ran (60-300 s per batch),
  preventing the dashboards from accepting connections during qualification.
  Switched to `promisify(execFile)` so the HTTP servers stay responsive.
  Without this, the always-on dashboard wouldn't actually be reachable while
  the loop ticked.

### Added (continued)

- **LLM-labeled testset for matching benchmark.** User labels (n=9) are too few
  to validate generalization or guard against prompt overfitting. New labeler
  (`src/matching/llm-labeler.ts`) calls Opus on a stratified sample (push +
  digest + low-score bands) of jobs from the DB, with a different prompt
  structure (narrative profile + ternary fit/borderline/unfit verdict) so
  failure modes don't correlate with the Sonnet-based qualifier. Labels persist
  append-only to `benchmarks/matching/llm-labels.jsonl`, keyed by
  `(company_slug, title)` and labeler version `opus-v1`. Bench now reports
  `precision_at_push_llm`, `recall_at_push_llm`, and `llm_user_agreement` as a
  calibration metric — if LLM-vs-user agreement drops below 0.80, treat the
  LLM precision metrics as untrustworthy and inspect labeler output before
  acting on them. Run with `npx tsx src/matching/run-labeler.ts --n=60`.

  Initial run on n=52: 11 fit / 14 borderline / 27 unfit. `llm_user_agreement`
  0.750 — one disagreement (user marked d3/Frontend Engineer-New Grad as
  false_positive but labeler says fit) appears to be a user-only preference
  signal the labeler can't see. `not_interested` excluded from agreement
  (means "I don't want it", not "wrong match" — counting it as disagreement
  penalises correct labeler judgments).

- **Hard-constraint re-validation on result load.** Bench and dashboard now
  re-run hard constraints on every cached pipeline result against the current
  code. Cached scores from older runs (when constraints were looser) get
  retroactively reclassified — no need to re-LLM the universe to clean up
  stale push-tier entries after a constraint tighten. `precision_at_push_llm`
  0.625 → 1.000 after this load, surfacing 3 cached push picks
  (twinhealth/Application Security Engineer 81, galaxydigitalservices/Vuln
  Management 79, planetlabs/SE Platform Ops Canada 70) that should have been
  rejected.

- **Hard constraint: `SECURITY_TITLE` pattern.** "Application Security Engineer",
  "Product Security Engineer", and similar titles without "software" in the
  title are now hard-rejected. The existing `OPS_ADMIN_PATTERNS` only matched
  body text; titles like "Application Security Engineer" describing high-level
  responsibilities snuck through. New fixtures cover the new pattern.

- **Matching benchmark: precision metrics wired to labels.** Bench now reads
  `benchmarks/matching/labels.json` + `benchmarks/matching/results/pipeline-*.json`
  to compute `precision_at_push`, `precision_at_digest`, `recall_at_push`, and
  `precision_trend_over_labels`. Previously these were `null`. Output validity
  and reasoning-evidence are now derived from result records too — no need to
  re-run the LLM on every bench, only on `STABILITY=1`.
  Baseline (9 labels): `precision_at_push` 0.400 → 1.000 after fixes below.
  Caveat: 5 labels is too few to claim generalization. Treat as an initial floor.

- **Score stability metric.** `STABILITY=1` runs the qualifier 3× on a sample
  of 3 push/digest-tier jobs and reports per-job stdev mean. Initial measurement:
  0.94 (stdev across repeats), tolerance currently undocumented — gather more
  runs before setting a regression ceiling.

### Changed

- **Pipeline-result dedup: latest-wins.** Both bench and dashboard previously
  kept the highest historical score for a `(company, title)` pair, which meant
  prompt regressions never showed up — old high scores from a permissive prompt
  outranked accurate lower scores from a tighter one. Now: most recent run wins.
  This makes prompt changes observable in the next bench run.

- **Qualifier prompt: level/domain framing tightened.**
  - Candidate-level paragraph rewritten to a decision table for posting language
    (new grad / 2 yrs post-grad / 2+ yrs / mid-level / 4+ yrs / senior). Was a
    one-line "stronger than typical new grad but NOT mid-level" which the model
    inconsistently applied.
  - Level cap on "mid-level" / "mid to senior" / explicit 3+ yrs language with
    explicit override for postings that welcome entry-level / new grad.
  - Domain cap (60) for highly specialized non-web/non-data domains (no
    candidate signal). Generalized — does not enumerate specific industries.
  - Generic non-NY US location penalty REMOVED. The candidate's profile
    accepts US-wide; user labels confirm Boston is a fit. Was capping
    legitimate matches.

  Validated on 5 labeled push jobs: precision moved 2/5 → 5/5 on that subset.
  This is a small sample; further label collection needed to confirm the rules
  generalize.

### Fixed

- **Hard constraint: years regex missed "N years of [filler] experience".**
  Outschool posting "3-5 years of full-stack software engineering experience"
  was passing because the regex required `experience|professional|...` directly
  after `years of`. Broadened to allow up to ~80 chars of intervening text and
  a wider anchor list (engineering, development, software, industry, etc.).
  Constraint fixtures grow by 3 cases. `hard_constraint_enforcement` 1.000 held;
  outschool now hard-rejected (was scoring 75 → push).

- **Ashby adapter: wrong GraphQL schema.** Used fields (publishedDate, departmentName,
  jobUrl) that don't exist on JobPostingBriefsWithIdsAndTeamId. Every Ashby poll
  returned a Zod validation error. Discovered in live shakedown — 0/21 polls succeeded.
  Fixed by introspecting the real schema. Available: id, title, locationName,
  employmentType, compensationTierSummary. Consequence: ats_posted_at is always null
  for Ashby (publishedDate not available at list level).

- **Ashby adapter: null jobBoard for non-existent boards.** Ashby returns
  `{ data: { jobBoard: null } }` for invalid slugs. Zod rejected this. Made nullable.

- **Ashby adapter: GET instead of POST.** Ashby's job board API is GraphQL (POST).
  The adapter was building a GET URL. Added `buildFetchInit` to the adapter interface.

- **Greenhouse ats_posted_at: was using updated_at instead of first_published.**
  Live API response confirmed `first_published` field is available at list endpoint.
  `first_published` is the original posting date (stable). `updated_at` changes on
  edits. Shakedown confirms: 100% population rate with first_published.

- **Workable adapter: spi/v3/jobs requires authentication.** Switched to public
  widget API at apply.workable.com/api/v1/widget/accounts/{slug}.

- **Workable URL parser: matched "apply" as a company slug.** apply.workable.com is
  the generic subdomain, not a company board. Excluded from pattern.

- **raw_json was stripping unknown fields.** All Zod schemas used .parse() which
  drops undeclared fields. Matching needs the full ATS response (descriptions, salary,
  employment type). Fixed with .passthrough() on all object schemas.

### Added

- **Regression ceiling: poll_to_surface_ms <= 25ms.** Current: ~10ms. Production
  target: spec.md 30-min median freshness. The 25ms ceiling catches code regressions
  without being sensitive to normal variance.

- **Live discovery against real sources.** 303 companies from SimplifyJobs and
  vanshb03 repos. CC Index Server returned 504 for all queries (server-side issue).
  GitHub code search needs authentication. ATS distribution: greenhouse 48%, ashby
  37%, lever 15%, workable <1%. Verification: 18/20 random slugs confirmed live.

- **Live calibration against real ATSes.** Greenhouse: c=1 false signal (latency
  variance, zero errors); override to c=3. Lever: baseline p95 10.4s, c=2,
  interval=500ms. Ashby: aggressive rate limiting (90% 429s), c=1, interval=3s.

## [0.1.0] - 2026-04-21

### Added

- **Feed capability: complete.** Fresh, deduplicated job stream from ATS layer.

- **Canonical schemas** (Zod): Company, Job, CompanySource, PollAttempt. Job schema
  includes `ats_posted_at` for production freshness measurement and `first_seen_at`
  protected by upsert that never touches it. Company schema includes operational
  fields: active, next_poll_at, consecutive_failures, disabled_at.
  CompanySource join table tracks all discovery sources per company.

- **SQLite store** with WAL mode. Dedup via UNIQUE(company_id, external_id) and
  upsert. `first_seen_at` set on INSERT via DEFAULT, excluded from ON CONFLICT
  UPDATE. Repost test proves same-title/different-ID jobs stored as separate rows.
  `dedup_rate` 0, `first_seen_immutability` 0 (pass).

- **Four ATS adapters**: Greenhouse, Lever, Ashby, Workable. All expose JSON APIs.
  Each validates response via Zod at the boundary. `adapter_schema_conformance` 1.0
  for all four.

- **Scheduler**: event-driven dispatch loop. Per-ATS concurrency via AIMD (additive
  increase on clean windows, multiplicative decrease on 429/5xx/timeout/rate-limit
  headers). Auto-disable after N consecutive failures; recovery sweep with backoff
  (10min -> 1hr -> 4hr -> 24hr cap, clock from disabled_at, failed attempts don't
  reset). `broken_source_containment` 1.0, `auto_disable_correctness` pass.

- **Calibrator**: offline tool probing each ATS by ramping concurrency then request
  rate against a sample of real companies. Boring nested loop — increment, sustain
  2-5 min, stop on first signal. Records source IP, evidence, recommendations to
  calibration/history.jsonl. Calibration benchmark with simulated ATSes converges on
  known limits (concurrent=3 found=3, interval=100ms found=100ms).

- **Discovery sources**: OSS list parser (markdown tables + URL lists), Common Crawl
  CC index JSONL parser. `universe_count` 12,039 from fixture data (target: >10,000).

- **Benchmark**: reports all feed.md metrics on fixtures. Runs in ~5s. History
  appended to benchmarks/feed/history.jsonl per run.

- **Dashboard**: plain HTML + JSON API at /api/metrics. Surfaces universe count,
  per-ATS breakdown, discovery source yields, AIMD state (current + ceiling),
  freshness lag, recent polls, disabled companies. Auto-refreshes every 30s.

- **One-command startup**: `npm start` runs discovery check + scheduler + dashboard.
  `npm run discover` populates the universe. `npm run calibrate` tunes ATS limits.

---

## Entry conventions

- Group entries by type (`Added`, `Changed`, `Deprecated`, `Removed`, `Fixed`, `Security`).
- Each entry is one line. If the reasoning does not fit in one line, write a paragraph below it.
- Write for a reader who was not present when the change was made. Explain the problem that motivated the change, not just the code that implements it.
- When a non-obvious tradeoff is made, name the alternative that was rejected and why.
- **When the change was intended to move a benchmark metric, state before → after.** Example: "Added Common Crawl discovery source. `universe_count` 5,247 → 48,903; `unique_contribution[common_crawl]` 39,102."
- When a feature document's capability ships, cut a version, date it, and open a fresh `[Unreleased]`. Capability-complete changes are at least a minor version bump.
