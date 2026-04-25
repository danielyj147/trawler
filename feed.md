# Feed

The feed is the product's foundation: a fresh, comprehensive, observable stream of job postings from the ATS layer. Without a reliable feed, matching has nothing to match against and the freshness thesis is hypothetical.

## What this capability delivers

Users can trust that any posting appearing on a company's public ATS board reaches Trawler's feed within minutes. The feed includes companies the commercial alternatives don't, because Trawler discovers them continuously from free, public sources. The feed is clean — no duplicates, no promoted noise, no stale entries masquerading as fresh.

## Required behavior

- **Discover** companies with public ATS boards. Continuously, incrementally, from free sources: curated developer lists, the YC directory, search-engine enumeration of ATS subdomains, Common Crawl, GitHub code search, funding-signal feeds. New sources are added as yield demands.
- **Ingest** new postings from each discovered company's ATS. Adapters exist for every ATS covering meaningful hiring volume. Each adapter normalizes to a canonical job schema.
- **Schedule** polls at intervals appropriate to source velocity. Failure-isolated — one broken source never degrades others. Consecutive failures auto-disable a source; re-enablement is deterministic.
- **Persist** with schema-enforced dedup. `first_seen_at` is written once at insert and is never overwritten. Updates to a posting are tracked without losing its first-seen timestamp.
- **Emit** metrics so the operator sees what the system is doing in production.

## Metrics the benchmark must report

These are the numbers the development loop is optimizing. The benchmark runs on fixtures (recorded ATS responses, synthetic company lists, a held-out set of known postings) and reports each of the following. Direction indicates which way is "better."

**Breadth**
- `universe_count` — total active companies in the universe. **Higher.**
- `discovery_yield[source]` — companies discovered per source. **Higher** for each source that doesn't regress others.
- `unique_contribution[source]` — companies contributed by a source that no other source found. **Higher.**

**Fidelity**
- `adapter_schema_conformance[ats]` — fraction of fixture responses that normalize cleanly to the canonical schema, per ATS. **1.0** is the only acceptable value.
- `required_field_population[field]` — fraction of ingested jobs with each required field populated. **1.0** for truly required fields.
- `dedup_rate` — duplicate job rows produced across two consecutive runs on a fixture set. **0** is the only acceptable value.
- `first_seen_immutability` — test attempts to overwrite `first_seen_at` that succeed. **0** is the only acceptable value.

**Freshness**
- `ingest_latency_p50_ms`, `_p95_ms`, `_p99_ms` — time from adapter fetch to row insert, on fixture data. **Lower.**
- `poll_to_surface_ms` — simulated time from posting appearing in a fixture ATS to appearing in the feed. **Lower.**

**Isolation**
- `broken_source_containment` — injecting a 500 / malformed response / timeout into one adapter — does the full run still complete? **1.0** is the only acceptable value.
- `auto_disable_correctness` — after N consecutive failures, the source is disabled; under recovery, it re-enables. Boolean, **pass** required.

## What "done" looks like

The capability is done when:

1. `universe_count` exceeds five figures from free sources alone.
2. Adapter fidelity metrics are at 1.0 for Greenhouse, Lever, Ashby, Workable, and any further ATS with meaningful hiring volume.
3. Dedup and first-seen-immutability metrics are at 0 and 1.0 respectively.
4. Latency metrics meet the target the operator sets.
5. Isolation metrics are at 1.0 / pass.
6. The operator's dashboard surfaces production versions of all of the above.
7. A clean machine reaches steady-state operation in minutes via one command.

## Context worth knowing

- ATS subdomain patterns (`boards.greenhouse.io/{slug}`, `jobs.lever.co/{slug}`, `jobs.ashbyhq.com/{slug}`, and similar) are enumerable through search engines, Common Crawl, and curated developer lists.
- OSS job lists (SimplifyJobs/New-Grad-Positions, speedyapply, vanshb03/Summer2026-Internships) collectively cover around a thousand companies already tagged with ATS URLs — cheapest starting source.
- The YC company directory adds several thousand companies.
- Major ATSes (Greenhouse, Lever, Ashby, Workable) expose JSON endpoints. HTML scraping is a last resort.
- `first_seen_at` is the evidence for the freshness claim. If it is wrong, the feed's value proposition is unverifiable.

## Failure modes to prevent

- Aggregators beating Trawler on freshness because of polling gaps.
- Missing postings because a silent adapter failure went undetected.
- Duplicate rows from partial retries.
- A single misbehaving source consuming poll capacity meant for healthy sources.
- `first_seen_at` mutating under updates, invalidating historical freshness claims.
- Discovery sources drifting stale without notice, so new companies stop appearing.
- Benchmark metrics diverging from production metrics — the development loop optimizing a fiction.
