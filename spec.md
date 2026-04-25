# Trawler — Spec

## What it is

Trawler is a job-intelligence product. It continuously ingests new job postings from the ATS layer (Greenhouse, Lever, Ashby, Workable, SmartRecruiters, Workday, and beyond), qualifies each posting against a user's structured profile, and alerts users on strong matches — ahead of any aggregator and without their ranking biases.

Trawler has users. Every feature, every decision, is addressed to their experience.

## The market

The public job-search market is structurally broken at its stated job. Aggregators (LinkedIn, Indeed, ZipRecruiter) monetize through promoted listings and feature placement, not through match quality. That economics produces three failure modes users experience every day:

1. **Latency.** Aggregators index postings from ATS platforms with hours to days of delay. By the time a job reaches an aggregator, applicant count is often in the hundreds.
2. **Wrong-fit.** Aggregator ranking optimizes for engagement and ad revenue, not qualification. Jobs users can't get are shown; jobs they'd be perfect for are hidden.
3. **Repetition.** Paid placement surfaces the same companies across all users. Startups and non-promoted mid-market companies are invisible.

These are not bugs. They are the equilibrium of aggregator economics. No incumbent can fix them.

## The thesis

The ATS layer is a clean source of truth sitting one layer below the aggregators. Its endpoints are public, free, fresh, and largely unrate-limited. Trawler operates exclusively there.

Three structural advantages compound:

- **Freshness.** Postings surface within minutes of publication, hours ahead of any aggregator.
- **Breadth.** Tens of thousands of tech companies have discoverable ATS boards. OSS alternatives hardcode hundreds; commercial scrapers charge for the universe that is publicly harvestable.
- **Cleanliness.** No promoted results, no SEO spam, no reposts from recruiter-of-recruiters.

## Users

Engineers with active job-search intent. Technically sharp, time-constrained, sensitive to false positives. An alert that does not deserve attention is worse than no alert. A missed alert is a missed opportunity users cannot recover.

Users trust Trawler to watch the market when they cannot. That trust is the product's primary asset. It is expensive to earn and cheap to lose.

## Capabilities

The product delivers four capabilities. Each has a feature document with required behavior, success criteria, and failure modes.

- **Feed** — the universe of companies with public ATS boards is discovered, polled, normalized, and stored as a fresh, deduplicated job stream. See `feed.md`.
- **Matching** — each new posting is evaluated against each user's profile by a qualifier, returning structured judgment. Users label alerted jobs over time; the qualifier learns from labels. See `matching.md`.
- **Alerts** — strong matches are delivered through users' configured channels. Borderline matches accumulate into a daily digest. Alert payloads carry the qualifier's reasoning so users can calibrate.
- **Dashboard** — the state of every component is inspectable in real time. Users and operators answer "is this working?" from one view.

## What success looks like

These are simultaneously the properties the product must exhibit at steady state and the observables the system must emit.

- **Universe.** Companies under active poll, by ATS.
- **Freshness.** Median and p95 time from ATS publication to Trawler ingest.
- **Coverage.** Postings ingested per day, per source, per company.
- **Precision.** Fraction of alerted jobs the user marks `applied` or `interested` versus `not interested` or `false positive`.
- **Volume.** Push alerts per day under a configurable ceiling; digest volume separately.
- **Health.** Adapter success rates, poll latencies, consecutive-failure counts, auto-disabled sources.
- **Learning.** Label counts, last qualifier re-tune, precision trend over time.

The product is working when:

1. Users wake up to a short list of fresh, well-matched jobs.
2. Median time from posting to alert is under thirty minutes.
3. Alert precision is above 60% and climbing with label accumulation.
4. Users stop manually checking aggregators.
5. Every claim above is verifiable from the dashboard without additional tooling.

## Non-goals

- **Not an aggregator.** No SEO traffic, no indexing for strangers, no selling leads to recruiters.
- **Does not touch LinkedIn.** Not the site, not Voyager, not profile scraping. Cost-to-maintenance is bad; data is worse than the ATS layer. Permanent.
- **Does not submit applications.** Different product, different legal and ethical surface.
- **Not a candidate-to-JD matcher.** We match jobs to users, not candidates to jobs.

## Operational stance

- Runs on commodity hardware or a small cloud instance. Not a kubernetes problem.
- Shipping, updating, and inspecting are each one command.
- Secrets via environment; never in code, never in a repo.
- The dashboard is self-hosted. Operators do not log into third-party services to see how Trawler is doing.
- The product is always on. Downtime is a failure of obligation to users, not a technical footnote.
