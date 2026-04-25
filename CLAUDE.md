# Trawler

Trawler is a job-intelligence product. It surfaces, qualifies, and alerts users to new job postings at the source-of-truth layer — company ATS platforms — ahead of aggregators and without their ranking biases.

Users rely on Trawler to watch the market when they cannot. Missed alerts are missed opportunities users cannot recover. Late alerts compete with hundreds of earlier applicants. Wrong alerts train users to ignore the product. Every engineering decision is evaluated against that user impact.

## Documents

- `spec.md` — the product. What Trawler is, who uses it, what it must do to work.
- Feature documents (`feed.md`, `matching.md`, ...) — each describes a product capability, its required behavior, the metrics that prove it is working, and the failure modes to prevent. Read the one the operator names.
- `CHANGELOG.md` — append-only history in Keep-a-Changelog format. Every behavioral change lands here with its reasoning and its benchmark impact.

## Evaluation

Changes are evaluated against four properties, in priority order:

1. **Latency.** Time from ATS publication to users receiving the information.
2. **Fidelity.** Completeness and correctness of extracted data. Missing data is a trust failure.
3. **Observability.** The state of the system is inspectable without attaching a debugger. A claim unverifiable from instrumentation is a claim probably wrong.
4. **Operational simplicity.** Code maintainable under pressure. Every dependency, abstraction, and moving part is a cost.

A change improving any of (1)-(3) at the cost of (4) is acceptable if noted in the changelog. A change improving (4) at the cost of (1)-(3) is rarely right.

## Benchmarks

Development requires a fast feedback loop. Every capability ships with a benchmark — code that reports the capability's key metrics on fixtures, in seconds, without touching production data or live external services. The benchmark is run after every meaningful change. A change lands only when the numbers move the right direction, or are unchanged for properties the change was not meant to affect.

Benchmarks are not correctness tests. Tests verify behavior against an oracle — pass or fail. Benchmarks report numbers that either went up, went down, or didn't move. Both exist, for different purposes.

Properties of a good benchmark:

- **Fast.** Complete in seconds. If running it is expensive, it won't be run.
- **Fixture-based.** No live network, no paid API calls, no flaky dependencies. Recorded responses, synthetic data, held-out labeled sets.
- **Deterministic.** Same inputs produce same outputs, or differences are bounded and reported.
- **Interpretable.** Output tells a human (or the model) what changed, not just "PASS" or "FAIL."
- **Versioned with the capability.** Benchmark code lives next to the capability it measures.

A capability without a benchmark is incomplete. A change that cannot be evaluated against a benchmark is a change that cannot be defended.

Each feature document lists the metrics its benchmark must report. Build the benchmark while building the capability — not after.

### History

Every benchmark run appends a record to a persistent history log (a JSONL file committed alongside the code, or an equivalent append-only format). Each record captures: timestamp, git commit SHA, benchmark name, every metric with its value, and a short note explaining what motivated the run — baseline, post-change, re-measurement after a dependency update, and so on.

The history is the objective record of progress across sessions. At the start of a session, reading the last several entries establishes which metrics are moving, which are stuck, and which have regressed. Without it, every session starts blind.

History files are never edited, only appended. A regression is part of the record; hiding it defeats the point. Plot the history when a visual check is useful, but never rewrite it.

## Invariants

- **Simplicity bias.** Boring beats clever. Standard library beats novel dependency. One way to do a thing beats three.
- **Modularity.** Each component has one responsibility, swappable at a clean boundary.
- **Normalize at boundaries.** Upstream schemas and vendor quirks do not leak into core logic.
- **Failure isolation.** One broken source never degrades the system beyond that source.
- **Good-faith use of public endpoints.** Respect rate limits. We are not adversarial.
- **One-command deployment.** Shipping, updating, and inspecting the running system are each one command.
- **No half-shipped features.** A capability is either production-grade or absent. Demos pretending to be features are not acceptable.

## Changelog discipline

SemVer and Keep a Changelog. Every behavioral change lands in `[Unreleased]` with an entry explaining why. When a change is meant to move a benchmark metric, the entry states the before and after values. The changelog is the narrative record; benchmark history is the numerical record. Together they answer both "why did we make this change" and "did it work."

## Session discipline

A session is a loop, not a linear script.

**Start.** Read `spec.md` and the feature document the operator names. Read the last several entries in benchmark history to establish recent trajectory. Run the benchmark now to record a baseline for this session.

**Loop until done.** Repeat:

1. Compare the latest benchmark numbers against the feature's "what done looks like" criteria. Identify the largest remaining gap.
2. Form a hypothesis for why the gap exists. Change code to close it.
3. Run the benchmark. Append the result to history with a note explaining what changed and why.
4. Verify the targeted metric moved the right direction and no unrelated metric regressed.
5. If any criterion is still unmet and no blocker applies, return to step 1.

Every few iterations, post a brief progress summary to the operator: which criteria are green, which are not, the last change attempted, the next change planned. This keeps the operator oriented without requiring them to read code.

**Stop only when:**

- Every "what done looks like" criterion is met and verified on the benchmark, or
- A decision only the operator can make blocks further progress — a meaningful tradeoff, a new external dependency, a scope change. State the blocker explicitly and hand back, or
- Required information is genuinely unavailable and cannot be derived from existing sources. State what is missing and hand back.

Handing back because "enough work has been done," because the session "feels long," or because the next step seems hard is the primary failure mode of agentic work. Resist it. The done-criteria are the judge, not a sense of effort.

Before stopping for any reason, update the changelog so it reflects reality.
