# Matching

Matching turns a raw feed into a product users act on. The feed is a commodity — every aggregator has one, just worse. Matching is where Trawler earns user trust: by showing users only jobs worth their attention, and by improving over time against users' own judgment.

## What this capability delivers

Users receive a short, high-precision stream of job matches. Each match carries explicit reasoning — users can tell at a glance why Trawler surfaced it. Feedback on alerted jobs feeds back into the system; precision improves measurably with use.

## Required behavior

- **Profile representation.** Each user maintains a structured profile describing experience, capabilities, and hard constraints (location, visa, clearance). Users with search intent across distinct role shapes maintain multiple lenses. The profile is data, not a prompt — re-tunable without touching code.
- **Qualification.** Every new posting is evaluated against each active profile by an LLM-based scorer. Output is structured: qualified or not, score, hard failures, reasoning. Hard constraints are checked deterministically where possible; softer judgment is delegated to the model.
- **Alerts.** Strong matches are delivered through the user's configured channel. Borderline matches accumulate into a daily digest. Alert payloads include the qualifier's reasoning so users can calibrate rather than wonder.
- **Labels.** Every alerted job can be marked `applied`, `interested`, `not interested`, or `false positive`. Labels persist and are queryable.
- **Learning.** The qualifier re-tunes against the accumulated label set on a cadence appropriate to label volume. Precision is measured and tracked; the scoring function is not static.
- **Emit** metrics so the operator sees what the system is doing in production.

## Metrics the benchmark must report

The benchmark runs on a held-out labeled fixture set (job × profile pairs with known outcomes) and a synthetic hard-constraint suite. It does not hit production LLM providers on every run; small smoke runs against a cheap model are fine, but the bulk of the signal comes from fixtures that exercise the deterministic parts of the pipeline. Directions marked where relevant.

**Precision**
- `precision_at_threshold[band]` — fraction of alerted fixtures marked `applied` or `interested` versus `not interested` or `false positive`, at each score threshold. **Higher.**
- `recall_at_threshold[band]` — fraction of truly-qualified fixtures the system alerts on at each threshold. **Higher.**
- `precision_trend_over_labels` — precision as a function of label set size, measured on chronologically-ordered fixtures. **Monotone non-decreasing** is the goal; flat is failure.

**Constraint adherence**
- `hard_constraint_enforcement` — fraction of synthetic fixtures where a profile's hard constraint is clearly violated by the posting, and the qualifier correctly flags it. **1.0** is the only acceptable value.
- `hard_constraint_false_positives` — fraction of fixtures where a constraint is satisfied but the qualifier flags a violation. **0.** 

**Output validity**
- `structured_output_validity` — fraction of qualifier calls returning valid, schema-conformant JSON with all required fields. **1.0** required.
- `reasoning_references_evidence` — fraction of outputs whose `reasoning` field cites specific content from the profile or posting. Approximate, but **higher** is better.

**Economics**
- `qualifier_latency_p50_ms`, `_p95_ms` — time per qualification. **Lower.**
- `qualifier_cost_usd_per_thousand` — estimated dollar cost per thousand qualifications. **Lower** subject to precision not regressing.
- `tokens_in_p50`, `tokens_out_p50` — distribution of token usage. **Lower.**

**Determinism**
- `score_stability` — variance in score across repeated calls with identical inputs, at fixed temperature. **Low.** Document the tolerance.

## What "done" looks like

1. `precision_at_threshold[push]` exceeds 60% on held-out labels and trends up as labels accumulate.
2. `hard_constraint_enforcement` is 1.0 and `hard_constraint_false_positives` is 0.
3. Every alert carries reasoning referencing evidence from the posting; `reasoning_references_evidence` is high.
4. `structured_output_validity` is 1.0.
5. Push alert volume in production stays under the configured ceiling; borderline matches never leak into push.
6. The learning loop is visibly doing work — precision trends up in the benchmark as labeled fixtures are added.
7. All observables are on the operator's dashboard in production form.

## Open questions to resolve with measurement

- Prompt optimization approach: automated tuning against the label set versus manual revision with labels as evidence. Resolve once the benchmark has enough labels for statistical power.
- Qualifier economics: run on every new posting versus a pre-filtered subset. Resolve by measuring `qualifier_cost_usd_per_thousand` against `recall_at_threshold` with and without pre-filter.
- Alert channel strategy: single channel versus multi-channel routing by score band. Resolve by user preference once alert volume is real.

## Failure modes to prevent

- Alerts that lack reasoning, training users to distrust the system.
- Push alerts for borderline matches, training users to ignore push.
- A qualifier that never learns, so precision plateaus regardless of label volume.
- Hard constraint failures delegated to the LLM, producing hallucinated qualification.
- Labels captured but never used — feedback loops with no closure.
- Silent qualifier degradation after a re-tune goes poorly — benchmark should catch this before production does.
- Benchmarks that only measure what is easy to measure, letting the hard metrics (precision, constraint adherence) drift.
