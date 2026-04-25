/**
 * Full discovery pipeline: fetches from all live sources, deduplicates, verifies.
 *
 * Sources:
 *   1. OSS job list repos (SimplifyJobs, vanshb03, pittcsc, coderQuad)
 *   2. GitHub code search (authenticated)
 *   3. YC company directory (Algolia API)
 *   4. Hacker News "Who's Hiring" threads (Algolia HN API)
 *   5. Common Crawl CC Index (when available)
 *
 * Usage: npx tsx src/run-discovery.ts [--verify-sample 20] [--skip-probe]
 */

import { parseAtsUrl } from './discovery/oss-lists.js';
import { discoverFromGitHub } from './discovery/github-search.js';
import { discoverFromYc } from './discovery/yc-directory.js';
import { discoverFromHn } from './discovery/hn-whos-hiring.js';
import { discoverFromCcDirect } from './discovery/cc-direct.js';
import type { DiscoveryResult } from './discovery/types.js';
import { Store } from './store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const FIXTURE_OUTPUT = path.join(import.meta.dirname, '..', 'benchmarks', 'feed', 'fixtures', 'discovery', 'cc-index.jsonl');
const DB_PATH = process.env.TRAWLER_DB || 'trawler.db';

const OSS_SOURCES = [
  { name: 'SimplifyJobs/New-Grad-Positions', url: 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md' },
  { name: 'SimplifyJobs/Summer2025-Internships', url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2025-Internships/dev/README.md' },
  { name: 'vanshb03/Summer2026-Internships', url: 'https://raw.githubusercontent.com/vanshb03/Summer2026-Internships/main/README.md' },
  { name: 'pittcsc/Summer2024-Internships', url: 'https://raw.githubusercontent.com/pittcsc/Summer2024-Internships/dev/README.md' },
  { name: 'coderQuad/New-Grad-2024', url: 'https://raw.githubusercontent.com/coderQuad/New-Grad-Positions-2024/master/README.md' },
  { name: 'speedyapply/2026-New-Grad', url: 'https://raw.githubusercontent.com/speedyapply/2026-New-Grad-Tech-Jobs/main/README.md' },
  { name: 'SimplifyJobs/Summer2026-Internships', url: 'https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/README.md' },
];

interface DiscoveredCompany {
  name: string;
  slug: string;
  ats_type: string;
  ats_url: string;
  source: string;
}

function extractCompanies(text: string, source: string): DiscoveredCompany[] {
  const urlRegex = /https?:\/\/[^\s)>\]"'`,]+/g;
  const seen = new Set<string>();
  const results: DiscoveredCompany[] = [];

  for (const match of text.matchAll(urlRegex)) {
    const url = match[0].replace(/[.)]+$/, '');
    const parsed = parseAtsUrl(url);
    if (!parsed) continue;
    const key = `${parsed.ats_type}:${parsed.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const lineStart = text.lastIndexOf('\n', match.index!) + 1;
    const line = text.substring(lineStart, text.indexOf('\n', match.index!) || text.length);
    const nameMatch = line.match(/\|\s*(?:\*\*)?(?:<img[^>]*>)?\s*\[?([^\]|*<\n]+)/);
    const name = nameMatch?.[1]?.trim() || parsed.slug;

    results.push({ name, slug: parsed.slug, ats_type: parsed.ats_type, ats_url: parsed.ats_url, source });
  }
  return results;
}

async function main() {
  const skipProbe = process.argv.includes('--skip-probe');
  const t0 = Date.now();

  console.log('TRAWLER FULL DISCOVERY');
  console.log('='.repeat(60));
  console.log('');

  const allCompanies = new Map<string, DiscoveredCompany>();
  const sourceStats: { source: string; newSlugs: number; elapsed: number }[] = [];

  function addResults(results: DiscoveryResult[], sourceName?: string) {
    let newCount = 0;
    for (const r of results) {
      const key = `${r.company.ats_type}:${r.company.slug}`;
      if (!allCompanies.has(key)) {
        allCompanies.set(key, {
          name: r.company.name,
          slug: r.company.slug,
          ats_type: r.company.ats_type,
          ats_url: r.company.ats_url,
          source: sourceName || r.source_type,
        });
        newCount++;
      }
    }
    return newCount;
  }

  // Phase 1: OSS repos
  console.log('Phase 1: OSS job list repos');
  for (const src of OSS_SOURCES) {
    const st = Date.now();
    try {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) { console.log(`  ${src.name}: HTTP ${res.status} — skipping`); continue; }
      const text = await res.text();
      const companies = extractCompanies(text, src.name);
      let newCount = 0;
      for (const c of companies) {
        const key = `${c.ats_type}:${c.slug}`;
        if (!allCompanies.has(key)) { allCompanies.set(key, c); newCount++; }
      }
      console.log(`  ${src.name}: ${companies.length} found, ${newCount} new`);
      sourceStats.push({ source: src.name, newSlugs: newCount, elapsed: Date.now() - st });
    } catch (err: any) {
      console.log(`  ${src.name}: ${err.message}`);
      sourceStats.push({ source: src.name, newSlugs: 0, elapsed: Date.now() - st });
    }
  }
  console.log(`  Total after OSS: ${allCompanies.size}`);
  console.log('');

  // Phase 2: GitHub code search
  console.log('Phase 2: GitHub code search (authenticated)');
  {
    const st = Date.now();
    try {
      const results = await discoverFromGitHub();
      const newCount = addResults(results, 'github');
      console.log(`  GitHub total: ${results.length} found, ${newCount} new`);
      sourceStats.push({ source: 'github-code-search', newSlugs: newCount, elapsed: Date.now() - st });
    } catch (err: any) {
      console.log(`  GitHub error: ${err.message}`);
      sourceStats.push({ source: 'github-code-search', newSlugs: 0, elapsed: Date.now() - st });
    }
  }
  console.log(`  Total after GitHub: ${allCompanies.size}`);
  console.log('');

  // Phase 3: YC directory
  console.log('Phase 3: YC company directory');
  {
    const st = Date.now();
    try {
      const results = await discoverFromYc();
      const newCount = addResults(results, 'yc');
      console.log(`  YC total: ${results.length} found, ${newCount} new`);
      sourceStats.push({ source: 'yc-directory', newSlugs: newCount, elapsed: Date.now() - st });
    } catch (err: any) {
      console.log(`  YC error: ${err.message}`);
      sourceStats.push({ source: 'yc-directory', newSlugs: 0, elapsed: Date.now() - st });
    }
  }
  console.log(`  Total after YC: ${allCompanies.size}`);
  console.log('');

  // Phase 4: HN Who's Hiring
  console.log('Phase 4: HN "Who\'s Hiring" threads');
  {
    const st = Date.now();
    try {
      const results = await discoverFromHn(12);
      const newCount = addResults(results, 'hn');
      console.log(`  HN total: ${results.length} found, ${newCount} new`);
      sourceStats.push({ source: 'hn-whos-hiring', newSlugs: newCount, elapsed: Date.now() - st });
    } catch (err: any) {
      console.log(`  HN error: ${err.message}`);
      sourceStats.push({ source: 'hn-whos-hiring', newSlugs: 0, elapsed: Date.now() - st });
    }
  }
  console.log(`  Total after HN: ${allCompanies.size}`);
  console.log('');

  // Phase 5: CC direct CDX (bypasses broken Index Server)
  console.log('Phase 5: Common Crawl direct CDX');
  {
    const st = Date.now();
    try {
      const results = await discoverFromCcDirect(['CC-MAIN-2026-12', 'CC-MAIN-2026-08', 'CC-MAIN-2026-04']);
      const newCount = addResults(results, 'common_crawl');
      console.log(`  CC total: ${results.length} found, ${newCount} new`);
      sourceStats.push({ source: 'cc-direct-cdx', newSlugs: newCount, elapsed: Date.now() - st });
    } catch (err: any) {
      console.log(`  CC error: ${err.message}`);
      sourceStats.push({ source: 'cc-direct-cdx', newSlugs: 0, elapsed: Date.now() - st });
    }
  }
  console.log(`  Total after CC: ${allCompanies.size}`);
  console.log('');

  const totalElapsed = (Date.now() - t0) / 1000;

  // Write fixture
  const fixtureLines: string[] = [];
  for (const [, c] of allCompanies) {
    fixtureLines.push(JSON.stringify({ url: c.ats_url, slug: c.slug, ats_type: c.ats_type, source: c.source }));
  }
  fs.writeFileSync(FIXTURE_OUTPUT, fixtureLines.join('\n') + '\n');

  // Write to DB
  const store = new Store(DB_PATH);
  let dbNew = 0;
  for (const [, c] of allCompanies) {
    const srcType = c.source.includes('/') ? 'oss_list' : c.source;
    const before = store.getCompanyCount();
    store.discoverCompany(
      { name: c.name, slug: c.slug, ats_type: c.ats_type, ats_url: c.ats_url },
      { source_type: srcType, source_detail: c.source },
    );
    if (store.getCompanyCount() > before) dbNew++;
  }

  // ATS distribution
  const byAts: Record<string, number> = {};
  for (const [, c] of allCompanies) byAts[c.ats_type] = (byAts[c.ats_type] || 0) + 1;

  // Report
  console.log('='.repeat(60));
  console.log('DISCOVERY REPORT');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Runtime:             ${totalElapsed.toFixed(1)}s`);
  console.log(`  Total unique:        ${allCompanies.size}`);
  console.log(`  New to DB:           ${dbNew}`);
  console.log(`  Fixture:             ${FIXTURE_OUTPUT} (${(fs.statSync(FIXTURE_OUTPUT).size / 1024).toFixed(0)}KB)`);
  console.log('');

  console.log('  Source breakdown:');
  for (const s of sourceStats)
    console.log(`    ${s.source.padEnd(40)} ${String(s.newSlugs).padStart(5)} new  (${(s.elapsed / 1000).toFixed(1)}s)`);
  console.log('');

  console.log('  ATS distribution:');
  for (const [ats, count] of Object.entries(byAts).sort((a, b) => b[1] - a[1]))
    console.log(`    ${ats.padEnd(15)} ${String(count).padStart(5)}  (${((count / allCompanies.size) * 100).toFixed(1)}%)`);
  console.log('');

  console.log('  DB source metrics:');
  for (const src of store.getSourceTypes()) {
    const y = store.getDiscoveryYield(src);
    const u = store.getUniqueContribution(src);
    const f = store.getFirstDiscoveryBy(src);
    console.log(`    ${src.padEnd(15)} yield=${String(y).padStart(5)}  unique=${String(u).padStart(5)}  first_by=${String(f).padStart(5)}`);
  }
  console.log('');
  console.log('='.repeat(60));

  store.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
