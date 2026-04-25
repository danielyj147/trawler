/**
 * Build the LLM-labeled testset.
 *
 * Strategy:
 * - Sample stratified across score bands using the latest pipeline results
 *   (push >=70, digest 40-69, low <40 but reached LLM). This ensures the
 *   testset spans the qualifier's full output range — not just push or
 *   skipped jobs — so precision/recall are measurable.
 * - Skip jobs already labeled by this labeler version (resume incrementally).
 * - After labeling, cross-check against the user labels in labels.json. The
 *   labeler is trusted only if agreement is high.
 *
 * Usage: npx tsx src/matching/run-labeler.ts [--n 60]
 */

import { Store } from '../store.js';
import {
  OpusLabeler,
  loadLabelerEntries,
  appendLabelerEntries,
  LABELER_VERSION,
  LABELS_PATH,
  type LabelerEntry,
} from './llm-labeler.js';
import type { JobRow } from '../schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');
const USER_LABELS = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'labels.json');

type Result = { company_slug: string; title: string; score: number; band: string; latency_ms: number; hard_failures: string[] };

function loadAllResults(): Result[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('pipeline-')).sort();
  const seen = new Map<string, Result>();
  for (const f of files) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as Result[];
      for (const r of arr) if (r.company_slug && r.title) seen.set(r.company_slug + '/' + r.title, r);
    } catch {}
  }
  return [...seen.values()];
}

function stratifiedSample(results: Result[], n: number): Result[] {
  // Want roughly equal coverage of push / digest / low-but-LLM-evaluated
  const reachedLLM = results.filter(r => r.latency_ms > 0 && r.hard_failures.length === 0);
  const push = reachedLLM.filter(r => r.score >= 70);
  const digest = reachedLLM.filter(r => r.score >= 40 && r.score < 70);
  const low = reachedLLM.filter(r => r.score < 40);

  const pick = (arr: Result[], k: number) => arr.sort(() => Math.random() - 0.5).slice(0, k);
  const perBand = Math.floor(n / 3);
  const sampled = [
    ...pick(push, perBand),
    ...pick(digest, perBand),
    ...pick(low, n - 2 * perBand),
  ];
  return sampled;
}

function loadUserLabels(): Record<string, { value: string }> {
  if (!fs.existsSync(USER_LABELS)) return {};
  try { return JSON.parse(fs.readFileSync(USER_LABELS, 'utf-8')); } catch { return {}; }
}

// Map user label values to labeler verdicts for agreement check.
// applied/interested → fit. not_interested → unfit OR borderline. false_positive → unfit.
function userLabelToVerdict(value: string): 'fit' | 'unfit' | null {
  if (value === 'applied' || value === 'interested') return 'fit';
  if (value === 'false_positive') return 'unfit';
  return null; // not_interested is too ambiguous (could be borderline) — exclude from strict agreement
}

async function main() {
  const args = process.argv.slice(2);
  const n = parseInt(args.find(a => a.startsWith('--n'))?.split('=')[1] ?? '60', 10);

  const allResults = loadAllResults();
  console.log(`Loaded ${allResults.length} unique pipeline results`);

  const existing = loadLabelerEntries();
  console.log(`Already labeled by ${LABELER_VERSION}: ${existing.size}`);

  // Sample stratified, exclude already-labeled
  const candidates = stratifiedSample(allResults, n).filter(r => !existing.has(r.company_slug + '/' + r.title));
  console.log(`New candidates to label: ${candidates.length}`);

  if (candidates.length === 0) {
    console.log('Nothing to do.');
  } else {
    // Look up actual job rows for the qualifier
    const dbPath = process.env.TRAWLER_DB || 'trawler.db';
    const store = new Store(dbPath);
    const jobs: (JobRow & { company_slug: string })[] = [];
    for (const c of candidates) {
      const row = store.db.prepare(`
        SELECT j.*, c.slug as company_slug
        FROM jobs j JOIN companies c ON c.id = j.company_id
        WHERE c.slug = ? AND j.title = ? LIMIT 1
      `).get(c.company_slug, c.title) as any;
      if (row) jobs.push(row);
    }
    store.close();
    console.log(`Resolved ${jobs.length}/${candidates.length} jobs from DB. Labeling with Opus...`);

    const labeler = new OpusLabeler('opus', 10);
    const t0 = performance.now();
    const verdicts = await labeler.labelBatch(jobs);
    const elapsed = (performance.now() - t0) / 1000;
    console.log(`Labeled ${jobs.length} jobs in ${elapsed.toFixed(0)}s`);

    const now = new Date().toISOString();
    const newEntries: LabelerEntry[] = jobs.map((j, i) => ({
      key: j.company_slug + '/' + j.title,
      verdict: verdicts[i].verdict,
      rationale: verdicts[i].rationale,
      labeler_id: LABELER_VERSION,
      labeled_at: now,
    }));
    appendLabelerEntries(newEntries);
    console.log(`Saved ${newEntries.length} labels to ${path.relative(process.cwd(), LABELS_PATH)}`);
  }

  // Calibration: agreement between LLM labels and user labels
  const all = loadLabelerEntries();
  const user = loadUserLabels();
  let total = 0, agree = 0;
  const disagreements: { key: string; user: string; llm: string }[] = [];
  for (const [k, l] of Object.entries(user)) {
    const expected = userLabelToVerdict(l.value);
    if (!expected) continue;
    const llm = all.get(k);
    if (!llm) continue;
    total++;
    // Strict: fit↔fit, unfit↔unfit. Allow borderline as a partial credit.
    const userOK = (expected === 'fit' && llm.verdict !== 'unfit') ||
                   (expected === 'unfit' && llm.verdict !== 'fit');
    if (userOK) agree++;
    else disagreements.push({ key: k, user: l.value, llm: llm.verdict });
  }

  console.log('');
  console.log(`=== Calibration (LLM labels vs user labels) ===`);
  console.log(`Coverage: ${total}/${Object.keys(user).length} user labels overlap with LLM labels`);
  if (total > 0) {
    console.log(`Agreement: ${agree}/${total} = ${(agree / total * 100).toFixed(0)}%`);
    if (disagreements.length > 0) {
      console.log('Disagreements:');
      for (const d of disagreements) console.log(`  ${d.key}  user=${d.user}  llm=${d.llm}`);
    }
  }

  // Distribution of verdicts
  let fit = 0, borderline = 0, unfit = 0;
  for (const e of all.values()) {
    if (e.verdict === 'fit') fit++;
    else if (e.verdict === 'unfit') unfit++;
    else borderline++;
  }
  console.log('');
  console.log(`=== Verdict distribution ===`);
  console.log(`  fit:        ${fit}`);
  console.log(`  borderline: ${borderline}`);
  console.log(`  unfit:      ${unfit}`);
  console.log(`  total:      ${all.size}`);
}

main().catch(err => { console.error(err); process.exit(1); });
