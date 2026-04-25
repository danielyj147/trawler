import { PROFILE } from '../../src/matching/profile.js';
import { checkHardConstraints } from '../../src/matching/hard-constraints.js';
import { ClaudeCliQualifier } from '../../src/matching/qualifier.js';
import { Store } from '../../src/store.js';
import { loadLabelerEntries, type LabelerEntry } from '../../src/matching/llm-labeler.js';
import type { JobRow } from '../../src/schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const HERE = import.meta.dirname;
const HISTORY = path.join(HERE, 'history.jsonl');
const RESULTS_DIR = path.join(HERE, 'results');
const LABELS_FILE = path.join(HERE, 'labels.json');

const PUSH_THRESHOLD = 70;
const DIGEST_THRESHOLD = 40;

interface MatchingMetrics {
  // User labels (small N, authoritative)
  precision_at_push: number | null;
  precision_at_digest: number | null;
  recall_at_push: number | null;
  precision_trend_over_labels: Array<{ n: number; precision: number }>;

  // LLM labels (larger N, noisy ground truth — see calibration)
  precision_at_push_llm: number | null;
  precision_at_digest_llm: number | null;
  recall_at_push_llm: number | null;
  llm_user_agreement: number | null; // calibration: do LLM labels agree with user labels?
  llm_labels_total: number;

  // Constraint adherence
  hard_constraint_enforcement: number;
  hard_constraint_false_positives: number;

  // Output validity (from result records)
  structured_output_validity: number;
  reasoning_references_evidence: number;

  // Economics
  qualifier_latency_p50_ms: number;
  qualifier_latency_p95_ms: number;

  // Distribution
  jobs_evaluated: number;
  jobs_hard_rejected: number;
  jobs_push: number;
  jobs_digest: number;
  jobs_skip: number;

  // Labels
  labels_total: number;
  labels_on_push: number;
  labels_on_digest: number;

  // Determinism
  score_stability: number | null;
}

type Label = {
  key: string;
  value: 'applied' | 'interested' | 'not_interested' | 'false_positive';
  timestamp: string;
};

type Result = {
  band: 'push' | 'digest' | 'skip';
  company_slug: string;
  title: string;
  score: number;
  reasoning: string;
  hard_failures: string[];
  latency_ms: number;
  evidence: { from_posting: string[]; from_profile: string[] };
};

function loadLabels(): Record<string, Label> {
  if (!fs.existsSync(LABELS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf-8')); } catch { return {}; }
}

function loadAllResults(): Result[] {
  // Dedup by latest result — file names are `pipeline-{ms-timestamp}.json`,
  // so ascending sort iterates oldest to newest. Last write wins, reflecting
  // the current qualifier prompt rather than a historical max.
  //
  // Then re-validate hard constraints against current code: cached scores from
  // older runs may have been generated when constraints were looser, leaving
  // stale push-tier scores for jobs that should now be hard-rejected. Re-running
  // the deterministic constraint check is fast and corrects this without
  // discarding useful LLM scores for still-valid jobs.
  if (!fs.existsSync(RESULTS_DIR)) return [];
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('pipeline-')).sort();
  const seen = new Map<string, Result>();
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as Result[];
      for (const r of arr) {
        if (!r.company_slug || !r.title) continue;
        seen.set(r.company_slug + '/' + r.title, r);
      }
    } catch {}
  }

  // Re-validate hard constraints. Skip if DB unavailable.
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  if (fs.existsSync(dbPath)) {
    const store = new Store(dbPath);
    const stmt = store.db.prepare(`
      SELECT j.raw_json FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE c.slug = ? AND j.title = ? LIMIT 1
    `);
    for (const [k, r] of seen) {
      // Already marked rejected in cached result — leave it
      if (r.hard_failures && r.hard_failures.length > 0) continue;
      const row = stmt.get(r.company_slug, r.title) as { raw_json: string } | undefined;
      if (!row) continue;
      const check = checkHardConstraints(PROFILE, r.title, row.raw_json || '');
      if (!check.passed) {
        seen.set(k, { ...r, score: 0, band: 'skip', hard_failures: check.failures });
      }
    }
    store.close();
  }
  return [...seen.values()];
}

function loadResultsChronological(): { file: string; mtime: number; results: Result[] }[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('pipeline-'));
  const out: { file: string; mtime: number; results: Result[] }[] = [];
  for (const f of files) {
    const full = path.join(RESULTS_DIR, f);
    try {
      const arr = JSON.parse(fs.readFileSync(full, 'utf-8')) as Result[];
      const stat = fs.statSync(full);
      out.push({ file: f, mtime: stat.mtimeMs, results: arr });
    } catch {}
  }
  return out.sort((a, b) => a.mtime - b.mtime);
}

// Hard constraint test fixtures
const CONSTRAINT_FIXTURES = [
  { title: 'Senior Staff Engineer', text: 'Requires 8+ years of professional experience', shouldPass: false, reason: 'years' },
  { title: 'Principal Engineer', text: '10 years minimum experience required', shouldPass: false, reason: 'years' },
  { title: 'Director of Engineering', text: 'Lead a team of 50', shouldPass: false, reason: 'title' },
  { title: 'VP of Product', text: 'Executive leadership role', shouldPass: false, reason: 'title' },
  { title: 'Staff Engineer, Platform', text: '7+ years building distributed systems', shouldPass: false, reason: 'title+years' },
  { title: 'Head of AI', text: 'Lead our AI division', shouldPass: false, reason: 'title' },
  { title: 'Software Engineer', text: 'Looking for engineers with 0-3 years experience', shouldPass: true, reason: 'new grad friendly' },
  { title: 'Software Engineer, New Grad', text: 'BS/MS in CS required', shouldPass: true, reason: 'explicit new grad' },
  { title: 'Junior Backend Engineer', text: '1-2 years experience preferred', shouldPass: true, reason: 'junior' },
  { title: 'Associate Software Engineer', text: 'Entry level position', shouldPass: true, reason: 'entry level' },
  { title: 'Full Stack Developer', text: 'React, Node.js, PostgreSQL. 2+ years experience.', shouldPass: true, reason: 'within range' },
  { title: 'AI/ML Engineer', text: 'Experience with PyTorch and LLMs. 1-2 years preferred.', shouldPass: true, reason: 'within range' },
  { title: 'Software Engineer II', text: '2 years of experience in backend development', shouldPass: true, reason: '2 years is under 3' },
  { title: 'Senior Software Engineer', text: '5+ years of experience required', shouldPass: false, reason: 'senior title + 5+ years' },
  { title: 'Software Engineer', text: '3-5 years of relevant experience required', shouldPass: false, reason: '3-5 years range, lower bound >= 3' },
  { title: 'Software Engineer', text: '1-2 years of professional experience', shouldPass: true, reason: '1-2 years, lower bound < 3' },
  // Years requirement with filler words between "years of" and anchor (outschool regression)
  { title: 'Software Engineer', text: '3-5 years of full-stack software engineering experience', shouldPass: false, reason: 'filler "full-stack software" between years and anchor' },
  { title: 'Software Engineer', text: '4+ years of backend development building production systems', shouldPass: false, reason: '4+ years with non-contiguous anchor' },
  { title: 'Software Engineer', text: 'We have 50 years of innovation. Looking for 1-2 years of experience.', shouldPass: true, reason: 'marketing "years" shouldn\'t trigger' },
  { title: 'Backend Engineer', text: 'Build and maintain services using Golang. Must be proficient in Go.', shouldPass: false, reason: 'Go primary requirement' },
  { title: 'Software Engineer', text: 'Strong Rust experience required. Build systems in Rust.', shouldPass: false, reason: 'Rust primary requirement' },
  { title: 'Full Stack Developer', text: 'Build with React and Node.js. Python experience a plus.', shouldPass: true, reason: 'React+Node are strong skills' },
  { title: 'Security Operations Analyst', text: 'Vulnerability management, SAST/DAST pipeline, SOC operations', shouldPass: false, reason: 'security ops, not SWE' },
  { title: 'Application Security Engineer', text: 'Administer security tooling, compliance frameworks, vulnerability management program', shouldPass: false, reason: 'security admin, not SWE' },
  { title: 'Application Security Engineer', text: 'Threat modeling, security review, working with engineering teams', shouldPass: false, reason: 'application security in title (no software)' },
  { title: 'Product Security Engineer', text: 'Find vulnerabilities in our products', shouldPass: false, reason: 'product security in title' },
  { title: 'Software Engineer, Security', text: 'Build security features in our product using TypeScript and React', shouldPass: true, reason: 'SWE that touches security' },
  { title: 'Software Engineer - Application Security Tools', text: 'Build internal tools', shouldPass: true, reason: 'software in title overrides security pattern' },
  { title: 'Associate Security Engineer', text: '4+ years of work experience in cybersecurity or software development', shouldPass: false, reason: '4+ years' },
  { title: 'Software Engineer', text: '{"location":{"name":"London, UK"}}', shouldPass: false, reason: 'UK location' },
  { title: 'Applied AI Engineer, EMEA', text: 'Based in Paris. European work authorization required.', shouldPass: false, reason: 'EMEA/Paris' },
  { title: 'Software Engineer', text: '{"location":{"name":"Remote (US)"}}', shouldPass: true, reason: 'US remote' },
  { title: 'Software Engineer', text: '{"location":{"name":"New York, NY"}}', shouldPass: true, reason: 'US location' },
];

function runConstraintBench(): { enforcement: number; false_positives: number } {
  let correctRejects = 0, totalShouldReject = 0, falseRejects = 0, totalShouldPass = 0;
  for (const fix of CONSTRAINT_FIXTURES) {
    const result = checkHardConstraints(PROFILE, fix.title, fix.text);
    if (!fix.shouldPass) {
      totalShouldReject++;
      if (!result.passed) correctRejects++;
      else console.log(`  MISS: "${fix.title}" should fail (${fix.reason}) but passed`);
    } else {
      totalShouldPass++;
      if (!result.passed) {
        falseRejects++;
        console.log(`  FALSE REJECT: "${fix.title}" should pass but failed: ${result.failures.join('; ')}`);
      }
    }
  }
  return {
    enforcement: totalShouldReject > 0 ? correctRejects / totalShouldReject : 1,
    false_positives: totalShouldPass > 0 ? falseRejects / totalShouldPass : 0,
  };
}

// Precision from labels over de-duped pipeline results.
// `good` = applied | interested. `bad` = not_interested | false_positive.
function computePrecision(
  results: Result[],
  labels: Record<string, Label>,
  minScore: number,
  maxScore: number | null = null,
): { precision: number | null; n: number; good: number; bad: number } {
  let good = 0, bad = 0;
  for (const r of results) {
    if (r.score < minScore) continue;
    if (maxScore != null && r.score >= maxScore) continue;
    const k = r.company_slug + '/' + r.title;
    const l = labels[k];
    if (!l) continue;
    if (l.value === 'applied' || l.value === 'interested') good++;
    else bad++;
  }
  const n = good + bad;
  return { precision: n > 0 ? good / n : null, n, good, bad };
}

// Recall@push: of labeled "good" jobs, how many appear in push?
function computeRecall(
  results: Result[],
  labels: Record<string, Label>,
): { recall: number | null; n: number; hits: number } {
  const byKey = new Map(results.map(r => [r.company_slug + '/' + r.title, r]));
  let hits = 0, total = 0;
  for (const [k, l] of Object.entries(labels)) {
    if (l.value !== 'applied' && l.value !== 'interested') continue;
    const r = byKey.get(k);
    if (!r) continue; // can't evaluate if we didn't rank it
    total++;
    if (r.score >= PUSH_THRESHOLD) hits++;
  }
  return { recall: total > 0 ? hits / total : null, n: total, hits };
}

// Precision as a function of label count, labels ordered by timestamp.
// Reports precision on push-scored results whose key is in the first N labels (chronologically).
function computePrecisionTrend(
  results: Result[],
  labels: Record<string, Label>,
): Array<{ n: number; precision: number }> {
  const byKey = new Map(results.map(r => [r.company_slug + '/' + r.title, r]));
  const ordered = Object.values(labels).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const points: Array<{ n: number; precision: number }> = [];
  let good = 0, bad = 0;
  for (let i = 0; i < ordered.length; i++) {
    const l = ordered[i];
    const r = byKey.get(l.key);
    if (!r || r.score < PUSH_THRESHOLD) continue;
    if (l.value === 'applied' || l.value === 'interested') good++; else bad++;
    const n = good + bad;
    if (n > 0) points.push({ n, precision: good / n });
  }
  return points;
}

// Precision against LLM labels. Treats "fit" as good, "unfit" as bad,
// "borderline" excluded from strict precision (acceptable in either band).
function computePrecisionLLM(
  results: Result[],
  llmLabels: Map<string, LabelerEntry>,
  minScore: number,
  maxScore: number | null = null,
): { precision: number | null; n: number; good: number; bad: number } {
  let good = 0, bad = 0;
  for (const r of results) {
    if (r.score < minScore) continue;
    if (maxScore != null && r.score >= maxScore) continue;
    const e = llmLabels.get(r.company_slug + '/' + r.title);
    if (!e) continue;
    if (e.verdict === 'fit') good++;
    else if (e.verdict === 'unfit') bad++;
    // borderline excluded
  }
  const n = good + bad;
  return { precision: n > 0 ? good / n : null, n, good, bad };
}

function computeRecallLLM(
  results: Result[],
  llmLabels: Map<string, LabelerEntry>,
): { recall: number | null; n: number; hits: number } {
  const byKey = new Map(results.map(r => [r.company_slug + '/' + r.title, r]));
  let hits = 0, total = 0;
  for (const [k, e] of llmLabels) {
    if (e.verdict !== 'fit') continue;
    const r = byKey.get(k);
    if (!r) continue;
    total++;
    if (r.score >= PUSH_THRESHOLD) hits++;
  }
  return { recall: total > 0 ? hits / total : null, n: total, hits };
}

// Calibration: agreement between LLM and user labels.
// - applied / interested → user says fit. LLM agrees if not "unfit".
// - false_positive → user says wrong match. LLM agrees if not "fit".
// - not_interested is excluded: user just doesn't want it; the role can still
//   be a correct match. Counting these as disagreement penalizes the labeler
//   for accurately judging fit, which is exactly what we want it to do.
function computeUserLLMAgreement(
  userLabels: Record<string, Label>,
  llmLabels: Map<string, LabelerEntry>,
): { agreement: number | null; n: number; agree: number } {
  let total = 0, agree = 0;
  for (const [k, l] of Object.entries(userLabels)) {
    const e = llmLabels.get(k);
    if (!e) continue;
    if (l.value === 'not_interested') continue; // ambiguous — exclude
    total++;
    if (l.value === 'applied' || l.value === 'interested') {
      if (e.verdict !== 'unfit') agree++;
    } else if (l.value === 'false_positive') {
      if (e.verdict !== 'fit') agree++;
    }
  }
  return { agreement: total > 0 ? agree / total : null, n: total, agree };
}

// Output validity: does each result have reasoning + in-range score + evidence fields?
function computeOutputQuality(results: Result[]): { validity: number; evidence: number; latency_p50: number; latency_p95: number } {
  const llm = results.filter(r => r.latency_ms > 0 && r.hard_failures.length === 0);
  if (llm.length === 0) return { validity: 0, evidence: 0, latency_p50: 0, latency_p95: 0 };
  const valid = llm.filter(r =>
    typeof r.score === 'number' && r.score >= 0 && r.score <= 100 &&
    typeof r.reasoning === 'string' && r.reasoning.length >= 10
  ).length;
  const withEvidence = llm.filter(r =>
    (Array.isArray(r.evidence?.from_posting) && r.evidence.from_posting.length > 0) ||
    (Array.isArray(r.evidence?.from_profile) && r.evidence.from_profile.length > 0)
  ).length;
  const lat = llm.map(r => r.latency_ms).sort((a, b) => a - b);
  return {
    validity: valid / llm.length,
    evidence: withEvidence / llm.length,
    latency_p50: lat[Math.floor(lat.length * 0.5)] ?? 0,
    latency_p95: lat[Math.floor(lat.length * 0.95)] ?? 0,
  };
}

function format(m: MatchingMetrics): string {
  const L: string[] = [];
  const RULE = '='.repeat(60);
  L.push('', RULE, `  MATCHING BENCHMARK -- ${new Date().toISOString()}`, RULE, '');
  L.push('  CONSTRAINTS');
  L.push(`  hard_constraint_enforcement      ${m.hard_constraint_enforcement.toFixed(3)}    ${m.hard_constraint_enforcement >= 1.0 ? 'ok' : 'FAIL'}`);
  L.push(`  hard_constraint_false_positives  ${m.hard_constraint_false_positives.toFixed(3)}    ${m.hard_constraint_false_positives === 0 ? 'ok' : 'FAIL'}`);

  L.push('', '  OUTPUT QUALITY');
  L.push(`  structured_output_validity       ${m.structured_output_validity.toFixed(3)}`);
  L.push(`  reasoning_references_evidence    ${m.reasoning_references_evidence.toFixed(3)}`);

  L.push('', '  ECONOMICS');
  L.push(`  qualifier_latency_p50_ms         ${m.qualifier_latency_p50_ms.toFixed(0)}`);
  L.push(`  qualifier_latency_p95_ms         ${m.qualifier_latency_p95_ms.toFixed(0)}`);

  L.push('', '  DISTRIBUTION');
  L.push(`  jobs_evaluated                   ${m.jobs_evaluated}`);
  L.push(`  jobs_push                        ${m.jobs_push}`);
  L.push(`  jobs_digest                      ${m.jobs_digest}`);
  L.push(`  jobs_skip                        ${m.jobs_skip}`);

  L.push('', '  LABELS');
  L.push(`  labels_total                     ${m.labels_total}`);
  L.push(`  labels_on_push                   ${m.labels_on_push}`);
  L.push(`  labels_on_digest                 ${m.labels_on_digest}`);

  L.push('', '  PRECISION (user labels — small N, authoritative)');
  L.push(`  precision_at_push                ${m.precision_at_push != null ? m.precision_at_push.toFixed(3) : '--'}   (target >= 0.60)`);
  L.push(`  precision_at_digest              ${m.precision_at_digest != null ? m.precision_at_digest.toFixed(3) : '--'}`);
  L.push(`  recall_at_push                   ${m.recall_at_push != null ? m.recall_at_push.toFixed(3) : '--'}`);

  L.push('', `  PRECISION (LLM labels — N=${m.llm_labels_total}, noisy ground truth)`);
  L.push(`  precision_at_push_llm            ${m.precision_at_push_llm != null ? m.precision_at_push_llm.toFixed(3) : '--'}`);
  L.push(`  precision_at_digest_llm          ${m.precision_at_digest_llm != null ? m.precision_at_digest_llm.toFixed(3) : '--'}`);
  L.push(`  recall_at_push_llm               ${m.recall_at_push_llm != null ? m.recall_at_push_llm.toFixed(3) : '--'}`);
  L.push(`  llm_user_agreement               ${m.llm_user_agreement != null ? m.llm_user_agreement.toFixed(3) : '--'}   (target >= 0.80)`);

  if (m.precision_trend_over_labels.length > 0) {
    L.push('', '  PRECISION TREND (push, by labels accumulated)');
    for (const p of m.precision_trend_over_labels) {
      L.push(`    n=${p.n.toString().padStart(2)}   precision=${p.precision.toFixed(3)}`);
    }
  }

  if (m.score_stability != null) {
    L.push('', `  SCORE STABILITY                  ${m.score_stability.toFixed(2)} (stdev across repeats)`);
  }

  L.push('', RULE);
  return L.join('\n');
}

/**
 * Score stability: run the qualifier N times on the same jobs, measure stdev.
 * Gated by STABILITY=1 so the default bench stays fast (no LLM calls).
 */
async function measureStability(repeats: number = 3, sampleSize: number = 3): Promise<number | null> {
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  if (!fs.existsSync(dbPath)) return null;

  // Sample from jobs that currently score non-trivially (pass hard constraints + LLM gave them meaningful value).
  // Sampling blindly from the DB almost always picks hard-rejected or
  // filtered-out titles, which trivially return score 0 (useless for stability).
  const results = loadAllResults().filter(r => r.score >= DIGEST_THRESHOLD && r.hard_failures.length === 0);
  if (results.length === 0) return null;

  const picks = results.sort(() => Math.random() - 0.5).slice(0, sampleSize);
  const store = new Store(dbPath);
  const jobs: (JobRow & { company_slug: string })[] = [];
  for (const r of picks) {
    const row = store.db.prepare(`
      SELECT j.*, c.slug as company_slug
      FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE c.slug = ? AND j.title = ? LIMIT 1
    `).get(r.company_slug, r.title) as any;
    if (row) jobs.push(row);
  }
  store.close();
  if (jobs.length === 0) return null;

  console.log(`  Stability: ${jobs.length} jobs × ${repeats} repeats = ${jobs.length * repeats} LLM calls`);
  const q = new ClaudeCliQualifier('sonnet', jobs.length);
  const perJobScores: number[][] = jobs.map(() => []);

  for (let r = 0; r < repeats; r++) {
    const results = await q.qualifyBatch(PROFILE, jobs);
    for (let i = 0; i < jobs.length; i++) perJobScores[i].push(results[i].score);
    const line = perJobScores.map((s, i) => `${jobs[i].company_slug}/${jobs[i].title.substring(0, 30)}: [${s.join(',')}]`).join('  ');
    console.log(`    run ${r + 1}: ${line}`);
  }

  // Stdev per job, mean across jobs
  const stdevs = perJobScores.map(scores => {
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const variance = scores.reduce((a, b) => a + (b - mean) ** 2, 0) / scores.length;
    return Math.sqrt(variance);
  });
  return stdevs.reduce((a, b) => a + b, 0) / stdevs.length;
}

async function main() {
  const note = process.argv.slice(2).join(' ') || 'no note';
  console.log('Matching benchmark\n');

  // Phase 1: Hard constraints
  console.log('=== Hard constraint fixtures ===');
  const { enforcement, false_positives } = runConstraintBench();
  console.log(`  Enforcement: ${enforcement.toFixed(3)}, False positives: ${false_positives.toFixed(3)}\n`);

  // Phase 2: Read existing pipeline results + labels, compute metrics
  console.log('=== Precision from labels + results ===');
  const results = loadAllResults();
  const labels = loadLabels();
  console.log(`  ${results.length} unique pipeline results, ${Object.keys(labels).length} labels`);

  const push = computePrecision(results, labels, PUSH_THRESHOLD);
  const digest = computePrecision(results, labels, DIGEST_THRESHOLD, PUSH_THRESHOLD);
  const recall = computeRecall(results, labels);
  const trend = computePrecisionTrend(results, labels);
  const quality = computeOutputQuality(results);

  // LLM labels (independent testset)
  const llmLabels = loadLabelerEntries();
  const pushLLM = computePrecisionLLM(results, llmLabels, PUSH_THRESHOLD);
  const digestLLM = computePrecisionLLM(results, llmLabels, DIGEST_THRESHOLD, PUSH_THRESHOLD);
  const recallLLM = computeRecallLLM(results, llmLabels);
  const agreement = computeUserLLMAgreement(labels, llmLabels);

  if (push.n > 0) {
    console.log(`  USER push (>=${PUSH_THRESHOLD}): ${push.good}/${push.n} good -> precision ${push.precision!.toFixed(3)}`);
  } else {
    console.log(`  USER push: no labels yet`);
  }
  if (digest.n > 0) {
    console.log(`  USER digest: ${digest.good}/${digest.n} good -> precision ${digest.precision!.toFixed(3)}`);
  }
  if (pushLLM.n > 0) {
    console.log(`  LLM  push (>=${PUSH_THRESHOLD}): ${pushLLM.good}/${pushLLM.n} fit -> precision ${pushLLM.precision!.toFixed(3)}`);
  }
  if (digestLLM.n > 0) {
    console.log(`  LLM  digest: ${digestLLM.good}/${digestLLM.n} fit -> precision ${digestLLM.precision!.toFixed(3)}`);
  }
  if (agreement.n > 0) {
    console.log(`  Calibration: LLM↔user agreement ${agreement.agree}/${agreement.n} = ${agreement.agreement!.toFixed(3)}`);
  }
  console.log('');

  const metrics: MatchingMetrics = {
    precision_at_push: push.precision,
    precision_at_digest: digest.precision,
    recall_at_push: recall.recall,
    precision_trend_over_labels: trend,
    precision_at_push_llm: pushLLM.precision,
    precision_at_digest_llm: digestLLM.precision,
    recall_at_push_llm: recallLLM.recall,
    llm_user_agreement: agreement.agreement,
    llm_labels_total: llmLabels.size,
    hard_constraint_enforcement: enforcement,
    hard_constraint_false_positives: false_positives,
    structured_output_validity: quality.validity,
    reasoning_references_evidence: quality.evidence,
    qualifier_latency_p50_ms: quality.latency_p50,
    qualifier_latency_p95_ms: quality.latency_p95,
    jobs_evaluated: results.length,
    jobs_hard_rejected: results.filter(r => r.hard_failures?.length > 0).length,
    jobs_push: results.filter(r => r.score >= PUSH_THRESHOLD).length,
    jobs_digest: results.filter(r => r.score >= DIGEST_THRESHOLD && r.score < PUSH_THRESHOLD).length,
    jobs_skip: results.filter(r => r.score < DIGEST_THRESHOLD).length,
    labels_total: Object.keys(labels).length,
    labels_on_push: push.n,
    labels_on_digest: digest.n,
    score_stability: null,
  };

  // Phase 3: score stability (optional — needs LLM calls)
  if (process.env.STABILITY === '1') {
    console.log('=== Score stability ===');
    metrics.score_stability = await measureStability();
  }

  console.log(format(metrics));

  const entry = {
    timestamp: new Date().toISOString(),
    commit: (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch { return 'no-commit'; } })(),
    benchmark: 'matching',
    metrics,
    note,
  };
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
  console.log(`  History -> ${path.relative(process.cwd(), HISTORY)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
