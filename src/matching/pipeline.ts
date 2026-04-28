/**
 * Full matching pipeline: retrieve → rerank → qualify.
 *
 * Usage: npx tsx src/matching/pipeline.ts [--top-k 200] [--top-n 30] [--model sonnet]
 */

import { Store } from '../store.js';
import { PROFILE } from './profile.js';
import { retrieveAndRerank } from './retriever.js';
import { ClaudeCliQualifier } from './qualifier.js';
import { computeIRMetrics, formatIRMetrics } from './ir-metrics.js';
import type { QualifyResult } from './qualifier.js';
import type { JobRow } from '../schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');

async function main() {
  const args = process.argv.slice(2);
  const topK = parseInt(args.find(a => a.startsWith('--top-k'))?.split('=')[1] ?? '200', 10);
  const topN = parseInt(args.find(a => a.startsWith('--top-n'))?.split('=')[1] ?? '30', 10);
  const model = args.find(a => a.startsWith('--model'))?.split('=')[1] ?? 'sonnet';
  const excludeEvaluated = args.includes('--exclude-evaluated');

  const store = new Store('trawler.db');
  const allJobs = store.db.prepare(`
    SELECT j.*, c.slug as company_slug, c.name as company_name, c.ats_type
    FROM jobs j JOIN companies c ON c.id = j.company_id
  `).all() as (JobRow & { company_slug: string; company_name: string; ats_type: string })[];
  store.close();

  // Optionally exclude jobs we've already qualified in a prior pipeline run.
  // Without this, BM25 keeps picking the same top candidates run after run.
  let filtered = allJobs;
  if (excludeEvaluated) {
    const seen = new Set<string>();
    const dir = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir).filter(f => f.startsWith('pipeline-'))) {
        try {
          const arr = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as any[];
          for (const r of arr) if (r.company_slug && r.title) seen.add(r.company_slug + '/' + r.title);
        } catch {}
      }
    }
    filtered = allJobs.filter(j => !seen.has(j.company_slug + '/' + j.title));
    console.log(`--exclude-evaluated: dropping ${allJobs.length - filtered.length} already-scored jobs`);
  }

  console.log(`Pipeline: ${filtered.length} jobs → BM25 top-${topK} → rerank top-${topN} → LLM`);
  console.log('');

  // Stage 1+2: Retrieve and rerank
  const t0 = performance.now();
  const candidates = await retrieveAndRerank(PROFILE, filtered, topK, topN);
  const retrieveMs = performance.now() - t0;

  console.log(`Stage 1+2: ${retrieveMs.toFixed(0)}ms — ${candidates.length} candidates from ${filtered.length} jobs`);
  console.log('');

  // Show rerank scores
  console.log('Top candidates (pre-LLM):');
  for (let i = 0; i < Math.min(candidates.length, 10); i++) {
    const c = candidates[i];
    const j = c.job as any;
    const f = c.features;
    console.log(`  ${(i + 1).toString().padStart(2)}. [${f.combined.toFixed(2)}] skill=${f.skill_overlap.toFixed(2)} lvl=${f.level_match.toFixed(1)} loc=${f.location_match.toFixed(1)} ${j.company_slug || ''}/${j.title.substring(0, 50)}`);
  }
  console.log('');

  // Stage 3: LLM qualification on top-N
  // Cap batch size — large batches (50+) cause output truncation in some
  // claude CLI configurations and yield "Failed to parse batch JSON".
  const batchSize = parseInt(args.find(a => a.startsWith('--batch'))?.split('=')[1] ?? '20', 10);
  console.log(`Stage 3: LLM qualifying ${candidates.length} candidates (model=${model}, batch=${batchSize})...`);
  const qualifier = new ClaudeCliQualifier(model, batchSize);
  const candidateJobs = candidates.map(c => c.job);
  const t1 = performance.now();
  const results = await qualifier.qualifyBatch(PROFILE, candidateJobs);
  const qualifyMs = performance.now() - t1;

  // Combine and display
  console.log('');
  console.log(`Stage 3: ${(qualifyMs / 1000).toFixed(1)}s — ${(qualifyMs / results.filter(r => r.latency_ms > 0).length).toFixed(0)}ms/job amortized`);
  console.log('');

  const pushResults: any[] = [];
  const digestResults: any[] = [];

  console.log('RESULTS:');
  console.log('-'.repeat(70));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const j = candidates[i].job as any;
    const f = candidates[i].features;
    const marker = r.band === 'push' ? '>>>' : r.band === 'digest' ? ' > ' : r.hard_failures.length > 0 ? ' X ' : '   ';

    if (r.band === 'push' || r.band === 'digest') {
      console.log(`${marker} [${r.score.toString().padStart(3)}] ${r.band.padEnd(6)} ${j.company_slug}/${j.title}`);
      console.log(`         ${j.url || '(no url)'}`);
      console.log(`         ${r.reasoning.substring(0, 120)}`);
      if (r.band === 'push') pushResults.push({ ...r, company: j.company_slug, title: j.title, url: j.url, features: f });
      else digestResults.push({ ...r, company: j.company_slug, title: j.title, url: j.url, features: f });
    }
  }

  const hardRejected = results.filter(r => r.hard_failures.length > 0).length;
  const titleFiltered = results.filter(r => r.reasoning.includes('not SWE-relevant')).length;
  const llmEvaluated = results.filter(r => r.latency_ms > 0).length;

  console.log('');
  console.log('='.repeat(70));
  console.log(`SUMMARY`);
  console.log(`  Total jobs in feed:      ${allJobs.length}`);
  console.log(`  BM25 retrieved:          ${topK}`);
  console.log(`  Reranked to LLM:         ${candidates.length}`);
  console.log(`  Hard rejected:           ${hardRejected}`);
  console.log(`  Title filtered:          ${titleFiltered}`);
  console.log(`  LLM evaluated:           ${llmEvaluated}`);
  console.log(`  Push matches:            ${pushResults.length}`);
  console.log(`  Digest matches:          ${digestResults.length}`);
  console.log(`  Retrieve+rerank time:    ${retrieveMs.toFixed(0)}ms`);
  console.log(`  LLM time:               ${(qualifyMs / 1000).toFixed(1)}s`);
  console.log(`  Total time:             ${((retrieveMs + qualifyMs) / 1000).toFixed(1)}s`);
  console.log('');

  // IR metrics — how well did the retriever rank candidates?
  const irInput = results.map(r => ({
    score: r.score,
    hardRejected: r.hard_failures.length > 0,
  }));
  const ir = computeIRMetrics(irInput);
  console.log(formatIRMetrics(ir));
  console.log('');
  console.log('='.repeat(70));

  // Save results
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const allResults = results.map((r, i) => ({
    ...r,
    company_slug: (candidates[i].job as any).company_slug,
    title: candidates[i].job.title,
    url: candidates[i].job.url,
    location: candidates[i].job.location,
    features: candidates[i].features,
  }));
  const outFile = path.join(RESULTS_DIR, `pipeline-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(allResults, null, 2));
  console.log(`\nResults: ${outFile}`);
}

main().catch(err => { console.error(err); process.exit(1); });
