import { Store } from '../../src/store.js';
import { greenhouse } from '../../src/adapters/greenhouse.js';
import { lever } from '../../src/adapters/lever.js';
import { ashby } from '../../src/adapters/ashby.js';
import { workable } from '../../src/adapters/workable.js';
import { Scheduler } from '../../src/scheduler.js';
import { parseMarkdownTable } from '../../src/discovery/oss-lists.js';
import { parseCcIndexJsonl } from '../../src/discovery/common-crawl.js';
import type { Adapter } from '../../src/adapters/types.js';
import type { Fetcher } from '../../src/scheduler.js';
import type { JobInput } from '../../src/schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const FIXTURES = path.join(import.meta.dirname, 'fixtures');
const HISTORY = path.join(import.meta.dirname, 'history.jsonl');

const ADAPTERS: Record<string, { adapter: Adapter; fixtureDir: string }> = {
  greenhouse: { adapter: greenhouse, fixtureDir: path.join(FIXTURES, 'greenhouse') },
  lever: { adapter: lever, fixtureDir: path.join(FIXTURES, 'lever') },
  ashby: { adapter: ashby, fixtureDir: path.join(FIXTURES, 'ashby') },
  workable: { adapter: workable, fixtureDir: path.join(FIXTURES, 'workable') },
};

const EMPTY_GH = JSON.stringify({ jobs: [], meta: { total: 0 } });

interface Metrics {
  universe_count: number;
  discovery_yield: Record<string, number>;
  unique_contribution: Record<string, number>;
  first_discovery_by: Record<string, number>;
  adapter_schema_conformance: Record<string, number>;
  required_field_population: Record<string, number>;
  dedup_rate: number;
  first_seen_immutability: number;
  repost_separation: boolean;
  poll_to_surface_ms: number | null;
  adapter_parse_ms: Record<string, number>;
  broken_source_containment: number | null;
  auto_disable_correctness: boolean | null;
  scheduler_load_throughput: number | null;
}

// -- Helpers --

function makeFetcher(map: Record<string, { status: number; body: string }>): Fetcher {
  return async (url: string) => {
    const r = map[url];
    if (!r) return new Response('Not Found', { status: 404 });
    return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
  };
}

// -- Benchmark sections --

function benchFidelity(store: Store): Pick<Metrics,
  'adapter_schema_conformance' | 'adapter_parse_ms' | 'required_field_population' |
  'dedup_rate' | 'first_seen_immutability' | 'repost_separation'
> {
  const result: ReturnType<typeof benchFidelity> = {
    adapter_schema_conformance: {},
    adapter_parse_ms: {},
    required_field_population: {},
    dedup_rate: 0,
    first_seen_immutability: 0,
    repost_separation: false,
  };

  const parsed: { ats: string; slug: string; jobs: JobInput[] }[] = [];

  for (const [ats, { adapter, fixtureDir }] of Object.entries(ADAPTERS)) {
    if (!fs.existsSync(fixtureDir)) continue;
    const files = fs.readdirSync(fixtureDir).filter(f => f.endsWith('.json'));
    let conformant = 0;
    let totalParseMs = 0;

    for (const file of files) {
      const content = fs.readFileSync(path.join(fixtureDir, file), 'utf-8');
      try {
        const t0 = performance.now();
        const jobs = adapter.parse(content);
        totalParseMs += performance.now() - t0;
        conformant++;
        parsed.push({ ats, slug: path.basename(file, '.json'), jobs });
      } catch { /* not conformant */ }
    }

    result.adapter_schema_conformance[ats] = files.length > 0 ? conformant / files.length : 0;
    result.adapter_parse_ms[ats] = conformant > 0 ? totalParseMs / conformant : 0;
  }

  const now = new Date().toISOString();
  for (const { ats, slug, jobs } of parsed) {
    const cid = store.discoverCompany(
      { name: slug, slug, ats_type: ats, ats_url: `https://fixture/${ats}/${slug}` },
      { source_type: 'fixture', source_detail: `${ats}/${slug}.json` },
    );
    for (const job of jobs) {
      store.upsertJob({ ...job, company_id: cid, updated_at: now });
    }
  }
  const countRun1 = store.getJobCount();

  // Dedup: second identical run
  for (const { ats, slug, jobs } of parsed) {
    const row = store.db.prepare('SELECT id FROM companies WHERE ats_type=? AND slug=?').get(ats, slug) as { id: number };
    for (const job of jobs) {
      store.upsertJob({ ...job, company_id: row.id, updated_at: now });
    }
  }
  result.dedup_rate = store.getJobCount() - countRun1;

  // first_seen_at immutability
  let overwrites = 0;
  for (const row of store.db.prepare('SELECT * FROM jobs').all() as any[]) {
    const before = row.first_seen_at;
    store.upsertJob({
      external_id: row.external_id, company_id: row.company_id,
      title: row.title + ' [MOD]', url: row.url,
      location: row.location, department: row.department,
      ats_posted_at: row.ats_posted_at, updated_at: new Date().toISOString(), raw_json: row.raw_json,
    });
    const after = store.getJob(row.id);
    if (after && after.first_seen_at !== before) overwrites++;
  }
  result.first_seen_immutability = overwrites;

  // Repost separation
  const cid = store.discoverCompany(
    { name: 'repost-test', slug: 'repost-test', ats_type: 'greenhouse', ats_url: 'https://fixture/repost' },
    { source_type: 'fixture', source_detail: 'repost-test' },
  );
  store.upsertJob({
    external_id: 'ORIG-001', company_id: cid, title: 'Staff Data Engineer',
    url: 'https://fixture/jobs/ORIG-001', location: 'Remote', department: 'Engineering',
    ats_posted_at: '2026-04-16T11:15:00Z', updated_at: now, raw_json: '{}',
  });
  store.upsertJob({
    external_id: 'REPOST-001', company_id: cid, title: 'Staff Data Engineer',
    url: 'https://fixture/jobs/REPOST-001', location: 'Remote', department: 'Engineering',
    ats_posted_at: '2026-04-20T10:00:00Z', updated_at: now, raw_json: '{}',
  });
  const o = store.getJobByKey(cid, 'ORIG-001');
  const r = store.getJobByKey(cid, 'REPOST-001');
  result.repost_separation = !!(o && r && o.id !== r.id);

  // Required field population
  const allJobs = store.db.prepare('SELECT * FROM jobs').all() as any[];
  for (const f of ['title', 'url', 'external_id'] as const) {
    const pop = allJobs.filter(j => j[f] != null && j[f] !== '').length;
    result.required_field_population[f] = allJobs.length > 0 ? pop / allJobs.length : 0;
  }
  const postedPop = allJobs.filter(j => j.ats_posted_at != null).length;
  result.required_field_population['ats_posted_at'] = allJobs.length > 0 ? postedPop / allJobs.length : 0;

  return result;
}

function benchDiscovery(store: Store): Pick<Metrics,
  'universe_count' | 'discovery_yield' | 'unique_contribution' | 'first_discovery_by'
> {
  // OSS list fixture
  const ossFixture = path.join(FIXTURES, 'discovery', 'oss-list-sample.md');
  if (fs.existsSync(ossFixture)) {
    const md = fs.readFileSync(ossFixture, 'utf-8');
    const companies = parseMarkdownTable(md);
    for (const c of companies) {
      store.discoverCompany(c.company, { source_type: 'oss_list', source_detail: 'oss-list-sample.md' });
    }
  }

  // Common Crawl fixture
  const ccFixture = path.join(FIXTURES, 'discovery', 'cc-index.jsonl');
  if (fs.existsSync(ccFixture)) {
    const jsonl = fs.readFileSync(ccFixture, 'utf-8');
    const companies = parseCcIndexJsonl(jsonl);
    for (const c of companies) {
      store.discoverCompany(c.company, { source_type: 'common_crawl', source_detail: c.source_detail });
    }
  }

  const result: ReturnType<typeof benchDiscovery> = {
    universe_count: store.getCompanyCount(),
    discovery_yield: {},
    unique_contribution: {},
    first_discovery_by: {},
  };

  for (const src of store.getSourceTypes()) {
    result.discovery_yield[src] = store.getDiscoveryYield(src);
    result.unique_contribution[src] = store.getUniqueContribution(src);
    result.first_discovery_by[src] = store.getFirstDiscoveryBy(src);
  }

  return result;
}

async function benchScheduler(): Promise<Pick<Metrics,
  'poll_to_surface_ms' | 'broken_source_containment' | 'auto_disable_correctness' | 'scheduler_load_throughput'
>> {
  const result: Awaited<ReturnType<typeof benchScheduler>> = {
    poll_to_surface_ms: null,
    broken_source_containment: null,
    auto_disable_correctness: null,
    scheduler_load_throughput: null,
  };

  const GH_CFG = { ceiling_concurrent: 10, ceiling_interval_ms: 0 };

  // -- poll_to_surface_ms --
  {
    const store = new Store(':memory:');
    const fixtureBody = fs.readFileSync(path.join(FIXTURES, 'greenhouse', 'company-a.json'), 'utf-8');
    store.discoverCompany(
      { name: 'surface-test', slug: 'surface-test', ats_type: 'greenhouse', ats_url: 'https://fixture/surface' },
      { source_type: 'bench', source_detail: 'poll-to-surface' },
    );

    const fetcher: Fetcher = async (url: string) => {
      if (url === greenhouse.buildUrl('surface-test')) {
        return new Response(fixtureBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(EMPTY_GH, { status: 200 });
    };

    const sched = new Scheduler(store, [greenhouse], {
      fetcher, global_max_in_flight: 10, ats_configs: { greenhouse: GH_CFG }, request_timeout_ms: 5000,
    });

    const t0 = performance.now();
    await sched.tick();
    await sched.drain();
    const elapsed = performance.now() - t0;

    result.poll_to_surface_ms = store.getJobCount() > 0 ? elapsed : null;
    store.close();
  }

  // -- broken_source_containment --
  {
    const store = new Store(':memory:');
    const goodBody = JSON.stringify({ jobs: [
      { id: 1, title: 'Eng', absolute_url: 'https://x.com/1', updated_at: '2026-04-20T00:00:00Z', location: null, departments: [] },
    ], meta: { total: 1 } });

    const slugs = ['good-1', 'good-2', 'good-3', 'broken', 'good-4'];
    const responses: Record<string, { status: number; body: string }> = {};
    for (const slug of slugs) {
      const url = greenhouse.buildUrl(slug);
      responses[url] = slug === 'broken'
        ? { status: 500, body: 'Internal Server Error' }
        : { status: 200, body: goodBody };
      store.discoverCompany(
        { name: slug, slug, ats_type: 'greenhouse', ats_url: url },
        { source_type: 'bench', source_detail: 'containment' },
      );
    }

    const sched = new Scheduler(store, [greenhouse], {
      fetcher: makeFetcher(responses), global_max_in_flight: 10,
      max_consecutive_failures: 5, ats_configs: { greenhouse: GH_CFG }, request_timeout_ms: 5000,
    });

    await sched.runTicks(20);
    await sched.drain();

    const goodPolled = (store.db.prepare(
      `SELECT COUNT(DISTINCT company_id) as c FROM poll_attempts WHERE status = 'success'`
    ).get() as { c: number }).c;
    const totalGood = slugs.filter(s => s !== 'broken').length;
    result.broken_source_containment = totalGood > 0 ? goodPolled / totalGood : 0;
    store.close();
  }

  // -- auto_disable_correctness --
  {
    const store = new Store(':memory:');
    const maxFail = 5;
    const cid = store.discoverCompany(
      { name: 'disable-test', slug: 'disable-test', ats_type: 'greenhouse', ats_url: 'https://fixture/disable' },
      { source_type: 'bench', source_detail: 'auto-disable' },
    );

    const failFetcher: Fetcher = async () => new Response('error', { status: 500 });
    const sched = new Scheduler(store, [greenhouse], {
      fetcher: failFetcher, global_max_in_flight: 10,
      max_consecutive_failures: maxFail, ats_configs: { greenhouse: GH_CFG }, request_timeout_ms: 5000,
    });

    for (let i = 0; i < maxFail + 5; i++) {
      await sched.tick();
      await sched.drain();
    }

    const co = store.getCompany(cid);
    const disabled = co && co.active === 0 && co.disabled_at !== null;

    if (disabled) {
      store.markPollSuccess(cid, new Date(Date.now() + 900000).toISOString());
      const recovered = store.getCompany(cid);
      result.auto_disable_correctness = !!(recovered && recovered.active === 1 && recovered.disabled_at === null);
    } else {
      result.auto_disable_correctness = false;
    }
    store.close();
  }

  // -- scheduler_load_throughput --
  {
    const store = new Store(':memory:');
    const N = 500;
    for (let i = 0; i < N; i++) {
      store.discoverCompany(
        { name: `load-${i}`, slug: `load-${i}`, ats_type: 'greenhouse', ats_url: `https://fixture/load/${i}` },
        { source_type: 'bench', source_detail: 'load-test' },
      );
    }

    const fastFetcher: Fetcher = async () =>
      new Response(EMPTY_GH, { status: 200, headers: { 'Content-Type': 'application/json' } });

    const sched = new Scheduler(store, [greenhouse], {
      fetcher: fastFetcher, global_max_in_flight: 100,
      ats_configs: { greenhouse: { ceiling_concurrent: 50, ceiling_interval_ms: 0 } },
      request_timeout_ms: 5000, clean_window_threshold: 1000,
    });

    const t0 = performance.now();
    for (let i = 0; i < 500; i++) {
      await sched.tick();
      if (sched.pollsCompleted >= N) break;
    }
    await sched.drain();
    const elapsed = (performance.now() - t0) / 1000;

    result.scheduler_load_throughput = elapsed > 0 ? sched.pollsCompleted / elapsed : 0;
    store.close();
  }

  return result;
}

// -- Formatting --

function pad(n: number, decimals = 0): string {
  return decimals > 0 ? n.toFixed(decimals) : String(n);
}

function col(label: string, width: number): string {
  return label + ' '.repeat(Math.max(1, width - label.length));
}

const RULE = '='.repeat(56);
const THIN = '-'.repeat(8);

function format(m: Metrics): string {
  const L: string[] = [];
  L.push('');
  L.push(RULE);
  L.push(`  FEED BENCHMARK -- ${new Date().toISOString()}`);
  L.push(RULE);

  L.push('');
  L.push('  BREADTH');
  L.push('  ' + THIN);
  L.push(`  ${col('universe_count', 44)}${pad(m.universe_count)}    (target: >10,000)`);
  for (const [s, v] of Object.entries(m.discovery_yield))
    L.push(`  ${col(`discovery_yield[${s}]`, 44)}${pad(v)}`);
  for (const [s, v] of Object.entries(m.unique_contribution))
    L.push(`  ${col(`unique_contribution[${s}]`, 44)}${pad(v)}`);
  for (const [s, v] of Object.entries(m.first_discovery_by))
    L.push(`  ${col(`first_discovery_by[${s}]`, 44)}${pad(v)}`);

  L.push('');
  L.push('  FIDELITY');
  L.push('  ' + THIN);
  for (const [a, v] of Object.entries(m.adapter_schema_conformance))
    L.push(`  ${col(`adapter_schema_conformance[${a}]`, 44)}${pad(v, 3)}    ${v >= 1.0 ? 'ok' : 'FAIL'}`);
  for (const [f, v] of Object.entries(m.required_field_population)) {
    const mark = f === 'ats_posted_at' ? (v > 0 ? '~' : '--') : (v >= 1.0 ? 'ok' : 'FAIL');
    L.push(`  ${col(`required_field_population[${f}]`, 44)}${pad(v, 3)}    ${mark}`);
  }
  L.push(`  ${col('dedup_rate', 44)}${pad(m.dedup_rate)}    ${m.dedup_rate === 0 ? 'ok' : 'FAIL'}`);
  L.push(`  ${col('first_seen_immutability', 44)}${pad(m.first_seen_immutability)}    ${m.first_seen_immutability === 0 ? 'ok' : 'FAIL'}`);
  L.push(`  ${col('repost_separation', 44)}${m.repost_separation ? 'pass' : 'FAIL'}    ${m.repost_separation ? 'ok' : 'FAIL'}`);

  L.push('');
  // Regression ceiling: 25ms. Current ~10ms. 2.3x headroom for code changes.
  // Production target is spec.md's 30-min median freshness (network-bound, not this metric).
  const SURFACE_CEILING_MS = 25;

  L.push('  FRESHNESS');
  L.push('  ' + THIN);
  const surfaceStatus = m.poll_to_surface_ms != null
    ? (m.poll_to_surface_ms <= SURFACE_CEILING_MS ? 'ok' : `FAIL (>${SURFACE_CEILING_MS}ms ceiling)`)
    : '--';
  L.push(`  ${col('poll_to_surface_ms', 44)}${m.poll_to_surface_ms != null ? pad(m.poll_to_surface_ms, 1) : '--'}    ${surfaceStatus}`);
  for (const [a, v] of Object.entries(m.adapter_parse_ms))
    L.push(`  ${col(`adapter_parse_ms[${a}]`, 44)}${pad(v, 3)}`);

  L.push('');
  L.push('  ISOLATION');
  L.push('  ' + THIN);
  L.push(`  ${col('broken_source_containment', 44)}${m.broken_source_containment != null ? pad(m.broken_source_containment, 3) + (m.broken_source_containment >= 1.0 ? '    ok' : '    FAIL') : '--'}`);
  L.push(`  ${col('auto_disable_correctness', 44)}${m.auto_disable_correctness != null ? (m.auto_disable_correctness ? 'pass    ok' : 'FAIL') : '--'}`);

  L.push('');
  L.push('  LOAD');
  L.push('  ' + THIN);
  L.push(`  ${col('scheduler_load_throughput', 44)}${m.scheduler_load_throughput != null ? pad(m.scheduler_load_throughput, 1) + ' polls/sec' : '--'}`);

  L.push('');
  L.push(RULE);
  return L.join('\n');
}

function getCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'no-commit';
  }
}

function appendHistory(metrics: Metrics, note: string): void {
  const entry = {
    timestamp: new Date().toISOString(),
    commit: getCommit(),
    benchmark: 'feed',
    metrics,
    note,
  };
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
}

// -- Main --
async function main() {
  const note = process.argv.slice(2).join(' ') || 'no note';

  const store = new Store(':memory:');
  const fidelity = benchFidelity(store);
  const discovery = benchDiscovery(store);
  store.close();

  const scheduler = await benchScheduler();

  const metrics: Metrics = { ...fidelity, ...discovery, ...scheduler };

  console.log(format(metrics));
  appendHistory(metrics, note);
  console.log(`\n  History -> ${path.relative(process.cwd(), HISTORY)}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
