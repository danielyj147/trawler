/**
 * Batch poll: fetch jobs from N companies across all ATSes.
 * Usage: npx tsx src/poll-batch.ts [--count 500] [--concurrency 10] [--mode unpolled|random|all]
 *
 * Modes:
 *   unpolled (default): prefer companies that have no jobs in DB yet.
 *                       Falls back to random once the unpolled pool is exhausted.
 *   random:             sample randomly across all active companies (original behavior).
 *   all:                same as random, kept for backward compat.
 */

import { Store } from './store.js';
import { greenhouse } from './adapters/greenhouse.js';
import { lever } from './adapters/lever.js';
import { ashby } from './adapters/ashby.js';
import { workable } from './adapters/workable.js';
import type { Adapter } from './adapters/types.js';

const ADAPTERS: Record<string, Adapter> = { greenhouse, lever, ashby, workable };

async function main() {
  const count = parseInt(process.argv.find(a => a.startsWith('--count'))?.split('=')[1] ?? '500', 10);
  const concurrency = parseInt(process.argv.find(a => a.startsWith('--concurrency'))?.split('=')[1] ?? '10', 10);
  const mode = (process.argv.find(a => a.startsWith('--mode'))?.split('=')[1] ?? 'unpolled') as 'unpolled' | 'random' | 'all';

  const store = new Store('trawler.db');

  // Prefer never-polled companies — the DB has ~9k discovered-but-never-polled
  // entries because discovery runs in bulk and polling runs over time. Polling
  // randomly re-polls already-known companies instead of expanding the universe.
  let companies: any[];
  if (mode === 'unpolled') {
    const unpolled = store.db.prepare(`
      SELECT c.* FROM companies c
      LEFT JOIN (SELECT DISTINCT company_id FROM jobs) j ON j.company_id = c.id
      WHERE c.active = 1 AND j.company_id IS NULL
      ORDER BY RANDOM() LIMIT ?
    `).all(count) as any[];
    if (unpolled.length >= count) {
      companies = unpolled;
    } else {
      // Pool exhausted — fall back to random among the rest
      const need = count - unpolled.length;
      const rest = store.db.prepare(`
        SELECT c.* FROM companies c
        INNER JOIN (SELECT DISTINCT company_id FROM jobs) j ON j.company_id = c.id
        WHERE c.active = 1
        ORDER BY RANDOM() LIMIT ?
      `).all(need) as any[];
      companies = [...unpolled, ...rest];
      console.log(`Unpolled pool exhausted (${unpolled.length}); re-polling ${rest.length} existing for freshness`);
    }
  } else {
    companies = store.db.prepare(
      'SELECT * FROM companies WHERE active = 1 ORDER BY RANDOM() LIMIT ?'
    ).all(count) as any[];
  }

  console.log(`Polling ${companies.length} companies (concurrency=${concurrency})...`);
  const t0 = Date.now();
  let totalJobs = 0;
  let successes = 0;
  let failures = 0;
  let active = 0;

  const byAts: Record<string, { ok: number; fail: number; jobs: number }> = {};

  async function poll(company: any) {
    const adapter = ADAPTERS[company.ats_type];
    if (!adapter) return;
    const stat = byAts[company.ats_type] ??= { ok: 0, fail: 0, jobs: 0 };

    try {
      const init = adapter.buildFetchInit?.(company.slug) ?? {};
      const res = await fetch(adapter.buildUrl(company.slug), {
        ...init,
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) { stat.fail++; failures++; return; }
      const body = await res.text();
      const jobs = adapter.parse(body);
      const now = new Date().toISOString();
      for (const job of jobs) {
        if (job.url.includes('/unknown/')) job.url = job.url.replace('/unknown/', `/${company.slug}/`);
        store.upsertJob({ ...job, company_id: company.id, updated_at: now });
      }
      stat.ok++;
      stat.jobs += jobs.length;
      totalJobs += jobs.length;
      successes++;
    } catch {
      stat.fail++;
      failures++;
    }
  }

  // Process with bounded concurrency
  let idx = 0;
  async function worker() {
    while (idx < companies.length) {
      const company = companies[idx++];
      await poll(company);
      if ((successes + failures) % 50 === 0) {
        process.stdout.write(`\r  ${successes + failures}/${companies.length} polled, ${totalJobs} jobs, ${failures} failures`);
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  const elapsed = (Date.now() - t0) / 1000;
  console.log(`\n\nDone in ${elapsed.toFixed(1)}s`);
  console.log(`  Success: ${successes}, Failed: ${failures}, Jobs: ${totalJobs}`);
  console.log(`  DB total: ${store.getJobCount()} jobs`);
  for (const [ats, s] of Object.entries(byAts)) {
    console.log(`  ${ats}: ${s.ok} ok, ${s.fail} fail, ${s.jobs} jobs`);
  }
  store.close();
}

main().catch(err => { console.error(err); process.exit(1); });
