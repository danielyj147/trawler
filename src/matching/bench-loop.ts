/**
 * Benchmark the matching loop on the host machine. Measures end-to-end tick
 * cost at different top-N values so we can pick a sustainable default for
 * `MatchingLoop.cfg.topN` and `intervalMs`.
 *
 * Reports per-stage timing (BM25 + rerank, LLM batches), throughput projected
 * to jobs/hour, and how well the qualifier output parses (validity rate).
 *
 * Usage:
 *   npx tsx src/matching/bench-loop.ts
 *   npx tsx src/matching/bench-loop.ts --top-ns=10,30,60 --top-k=500 --batch=20
 *
 * Saves results to benchmarks/matching/loop-bench.jsonl (append-only).
 *
 * Notes:
 * - Uses the production qualifier and prompt — same model, same batching
 *   logic the matching loop uses.
 * - Caches the BM25 index across topN values? No — BM25 over ~74K jobs is
 *   ~1-2s, and we want to measure realistic tick cost end-to-end.
 * - Each topN run consumes ~topN/batch LLM calls. Don't run a 100-job topN
 *   five times unless you mean to.
 */

import { Store } from '../store.js';
import { PROFILE } from './profile.js';
import { retrieveAndRerank } from './retriever.js';
import { ClaudeCliQualifier } from './qualifier.js';
import type { JobRow } from '../schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execSync } from 'node:child_process';

const HISTORY = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'loop-bench.jsonl');
const RESULTS_DIR = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');

function parseList(s: string | undefined, fallback: number[]): number[] {
  if (!s) return fallback;
  return s.split(',').map(x => parseInt(x.trim(), 10)).filter(Number.isFinite);
}

function loadScoredKeys(): Set<string> {
  const seen = new Set<string>();
  if (!fs.existsSync(RESULTS_DIR)) return seen;
  for (const f of fs.readdirSync(RESULTS_DIR).filter(x => x.startsWith('pipeline-'))) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as any[];
      for (const r of arr) if (r.company_slug && r.title) seen.add(r.company_slug + '/' + r.title);
    } catch {}
  }
  return seen;
}

interface RunResult {
  top_n: number;
  top_k: number;
  batch_size: number;
  unscored_jobs: number;
  bm25_rerank_ms: number;
  llm_total_ms: number;
  llm_per_job_ms: number;
  total_ms: number;
  jobs_per_hour_if_continuous: number;
  push: number;
  digest: number;
  hard_rejected: number;
  parse_failures: number;
  validity: number;
}

async function runOne(topN: number, topK: number, batchSize: number, model: string, dryRun: boolean): Promise<RunResult> {
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  const store = new Store(dbPath);
  const all = store.db.prepare(`
    SELECT j.*, c.slug as company_slug, c.name as company_name, c.ats_type
    FROM jobs j JOIN companies c ON c.id = j.company_id
  `).all() as (JobRow & { company_slug: string; company_name: string; ats_type: string })[];
  store.close();

  const scored = loadScoredKeys();
  const unscored = all.filter(j => !scored.has(j.company_slug + '/' + j.title));

  const t0 = Date.now();
  const candidates = await retrieveAndRerank(PROFILE, unscored, topK, topN);
  const bm25Ms = Date.now() - t0;

  if (candidates.length === 0 || dryRun) {
    return {
      top_n: topN, top_k: topK, batch_size: batchSize,
      unscored_jobs: unscored.length, bm25_rerank_ms: bm25Ms,
      llm_total_ms: 0, llm_per_job_ms: 0, total_ms: bm25Ms,
      jobs_per_hour_if_continuous: 0,
      push: 0, digest: 0, hard_rejected: 0, parse_failures: 0, validity: 0,
    };
  }

  const t1 = Date.now();
  const qualifier = new ClaudeCliQualifier(model, batchSize);
  const candidateJobs = candidates.map(c => c.job);
  const results = await qualifier.qualifyBatch(PROFILE, candidateJobs);
  const llmMs = Date.now() - t1;
  const totalMs = bm25Ms + llmMs;

  const push = results.filter(r => r.score >= 70).length;
  const digest = results.filter(r => r.score >= 40 && r.score < 70).length;
  const hardRej = results.filter(r => r.hard_failures.length > 0).length;
  const parseFails = results.filter(r => r.reasoning.includes('Failed to parse')).length;
  const llmEvaluated = results.filter(r => r.latency_ms > 0 && r.hard_failures.length === 0);
  const valid = llmEvaluated.filter(r => r.score > 0 || r.reasoning.length > 20).length;
  const validity = llmEvaluated.length > 0 ? valid / llmEvaluated.length : 0;

  // Save results so the data isn't wasted (the qualifier output is real)
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const shaped = results.map((r, i) => ({
    ...r,
    company_slug: (candidates[i].job as any).company_slug,
    title: candidates[i].job.title,
    url: candidates[i].job.url,
    location: candidates[i].job.location,
    features: candidates[i].features,
  }));
  fs.writeFileSync(path.join(RESULTS_DIR, `pipeline-${Date.now()}.json`), JSON.stringify(shaped, null, 2));

  return {
    top_n: topN, top_k: topK, batch_size: batchSize,
    unscored_jobs: unscored.length, bm25_rerank_ms: bm25Ms,
    llm_total_ms: llmMs,
    llm_per_job_ms: llmMs / topN,
    total_ms: totalMs,
    jobs_per_hour_if_continuous: Math.round((topN / totalMs) * 3600 * 1000),
    push, digest, hard_rejected: hardRej, parse_failures: parseFails, validity,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const topNs = parseList(args.find(a => a.startsWith('--top-ns'))?.split('=')[1], [10, 30, 60]);
  const topK = parseInt(args.find(a => a.startsWith('--top-k'))?.split('=')[1] ?? '500', 10);
  const batch = parseInt(args.find(a => a.startsWith('--batch'))?.split('=')[1] ?? '20', 10);
  const model = args.find(a => a.startsWith('--model'))?.split('=')[1] ?? 'sonnet';
  const dryRun = args.includes('--dry-run');
  const note = args.find(a => !a.startsWith('--')) ?? 'no note';

  console.log(`Loop bench — top_ns=[${topNs.join(',')}] top_k=${topK} batch=${batch} model=${model}${dryRun ? ' (DRY RUN)' : ''}`);
  console.log('');

  const runs: RunResult[] = [];
  for (const n of topNs) {
    console.log(`>>> Running top-N=${n}...`);
    const r = await runOne(n, topK, batch, model, dryRun);
    runs.push(r);
    console.log(`    bm25+rerank: ${r.bm25_rerank_ms}ms`);
    console.log(`    llm:         ${(r.llm_total_ms / 1000).toFixed(1)}s (${r.llm_per_job_ms.toFixed(0)}ms/job)`);
    console.log(`    total tick:  ${(r.total_ms / 1000).toFixed(1)}s`);
    console.log(`    jobs/hr (continuous): ${r.jobs_per_hour_if_continuous}`);
    console.log(`    push: ${r.push}, digest: ${r.digest}, hard_rejected: ${r.hard_rejected}, parse_failures: ${r.parse_failures}`);
    console.log(`    validity: ${r.validity.toFixed(3)}`);
    console.log('');
  }

  // Summary table
  console.log('SUMMARY');
  console.log('top_n  bm25_ms  llm_s  per_job_ms  tick_s  jobs/hr  push  digest  validity');
  for (const r of runs) {
    console.log(`${r.top_n.toString().padStart(5)}  ${r.bm25_rerank_ms.toString().padStart(7)}  ${(r.llm_total_ms / 1000).toFixed(1).padStart(5)}  ${r.llm_per_job_ms.toFixed(0).padStart(10)}  ${(r.total_ms / 1000).toFixed(1).padStart(6)}  ${r.jobs_per_hour_if_continuous.toString().padStart(7)}  ${r.push.toString().padStart(4)}  ${r.digest.toString().padStart(6)}  ${r.validity.toFixed(3).padStart(8)}`);
  }

  // Persist
  const entry = {
    timestamp: new Date().toISOString(),
    commit: (() => { try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); } catch { return 'no-commit'; } })(),
    benchmark: 'matching-loop',
    host: process.env.HOSTNAME || os.hostname(),
    model,
    runs,
    note,
  };
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
  console.log(`\nHistory -> ${path.relative(process.cwd(), HISTORY)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
