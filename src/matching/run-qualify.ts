/**
 * Run the qualifier on a targeted sample of SWE-relevant jobs from the DB.
 * Usage: npx tsx src/matching/run-qualify.ts [--count 15]
 */

import { Store } from '../store.js';
import { PROFILE } from './profile.js';
import { ClaudeCliQualifier } from './qualifier.js';
import type { QualifyResult } from './qualifier.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');

async function main() {
  const count = parseInt(process.argv.find(a => a.startsWith('--count'))?.split('=')[1] ?? '15', 10);

  const store = new Store('trawler.db');

  // Get SWE-relevant jobs (mix of should-match and edge cases)
  const jobs = store.db.prepare(`
    SELECT j.*, c.slug as company_slug, c.name as company_name, c.ats_type
    FROM jobs j JOIN companies c ON c.id = j.company_id
    WHERE j.title LIKE '%Engineer%'
       OR j.title LIKE '%Developer%'
       OR j.title LIKE '%Backend%'
       OR j.title LIKE '%Frontend%'
       OR j.title LIKE '%Full Stack%'
       OR j.title LIKE '%ML %'
       OR j.title LIKE '%Machine Learning%'
       OR j.title LIKE '%DevOps%'
       OR j.title LIKE '%SRE%'
       OR j.title LIKE '%Platform%'
    ORDER BY RANDOM()
    LIMIT ?
  `).all(count) as any[];

  console.log(`Qualifying ${jobs.length} SWE-relevant jobs from feed`);
  console.log('');

  const qualifier = new ClaudeCliQualifier();
  const results: any[] = [];

  for (const job of jobs) {
    const result = await qualifier.qualify(PROFILE, job);
    results.push({ ...result, job_title: job.title, company_slug: job.company_slug, ats_type: job.ats_type });

    const marker = result.band === 'push' ? '>>>' :
                   result.band === 'digest' ? ' > ' :
                   result.hard_failures.length > 0 ? ' X ' : '   ';
    const hf = result.hard_failures.length > 0 ? ` [HARD: ${result.hard_failures[0]}]` : '';
    console.log(`${marker} [${result.score.toString().padStart(3)}] ${result.band.padEnd(6)} ${job.company_slug}/${job.title.substring(0, 50)}${hf}`);
    if (result.band !== 'skip' || result.hard_failures.length > 0) {
      console.log(`         ${result.reasoning.substring(0, 120)}`);
    }
  }

  // Summary
  const push = results.filter(r => r.band === 'push').length;
  const digest = results.filter(r => r.band === 'digest').length;
  const skip = results.filter(r => r.band === 'skip').length;
  const hardRejected = results.filter(r => r.hard_failures.length > 0).length;
  const latencies = results.filter(r => r.latency_ms > 0).map(r => r.latency_ms).sort((a: number, b: number) => a - b);

  console.log('');
  console.log(`Push: ${push}  Digest: ${digest}  Skip: ${skip}  Hard rejected: ${hardRejected}`);
  console.log(`Latency p50: ${latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)].toFixed(0) : 0}ms`);

  // Save for labeling
  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, `targeted-${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`Results: ${outFile}`);

  store.close();
}

main().catch(err => { console.error(err); process.exit(1); });
