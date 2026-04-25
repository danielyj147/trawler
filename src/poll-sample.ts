/** Quick-poll a sample of companies to populate the DB with real jobs. */
import { Store } from './store.js';
import { greenhouse } from './adapters/greenhouse.js';
import { lever } from './adapters/lever.js';
import { ashby } from './adapters/ashby.js';

const store = new Store('trawler.db');
const adapters = { greenhouse, lever, ashby };

const companies = store.db.prepare(
  `SELECT * FROM companies WHERE ats_type IN ('greenhouse','lever','ashby') AND active = 1 ORDER BY RANDOM() LIMIT 30`
).all() as any[];

console.log(`Polling ${companies.length} companies...`);
let totalJobs = 0;

for (const c of companies) {
  const adapter = (adapters as any)[c.ats_type];
  if (!adapter) continue;
  try {
    const init = adapter.buildFetchInit?.(c.slug) ?? {};
    const res = await fetch(adapter.buildUrl(c.slug), { ...init, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) { console.log(`  ${c.ats_type}/${c.slug}: ${res.status}`); continue; }
    const body = await res.text();
    const jobs = adapter.parse(body);
    const now = new Date().toISOString();
    for (const job of jobs) {
      if (job.url.includes('/unknown/')) job.url = job.url.replace('/unknown/', `/${c.slug}/`);
      store.upsertJob({ ...job, company_id: c.id, updated_at: now });
    }
    totalJobs += jobs.length;
    console.log(`  ${c.ats_type}/${c.slug}: ${jobs.length} jobs`);
  } catch (e: any) {
    console.log(`  ${c.ats_type}/${c.slug}: ${e.message?.substring(0, 60)}`);
  }
}

console.log(`Done. ${totalJobs} jobs polled. DB total: ${store.getJobCount()}`);
store.close();
