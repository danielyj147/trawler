/**
 * Run Common Crawl discovery against the live CC Index Server.
 *
 * Queries index.commoncrawl.org for ATS URL patterns, extracts unique
 * company slugs, writes results to a JSONL fixture file, and reports stats.
 *
 * Usage: npx tsx src/run-cc-discovery.ts [--collection CC-MAIN-2026-12] [--max-pages 5]
 */

import { parseAtsUrl } from './discovery/oss-lists.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const CC_PATTERNS = [
  'boards.greenhouse.io/*',
  'jobs.lever.co/*',
  'jobs.ashbyhq.com/*',
  '*.workable.com/j/*',
];

interface CcEntry {
  url: string;
  status?: string;
  timestamp?: string;
  [key: string]: unknown;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let collection = 'CC-MAIN-2026-12';
  let maxPages = 5;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--collection' && args[i + 1]) collection = args[++i];
    if (args[i] === '--max-pages' && args[i + 1]) maxPages = parseInt(args[++i], 10);
  }

  return { collection, maxPages };
}

async function queryPattern(
  pattern: string,
  collection: string,
  maxPages: number,
): Promise<{ lines: string[]; bytesTotal: number; pagesQueried: number }> {
  const allLines: string[] = [];
  let bytesTotal = 0;
  let page = 0;

  while (page < maxPages) {
    const url = `https://index.commoncrawl.org/${collection}-index?url=${encodeURIComponent(pattern)}&output=json&page=${page}`;
    console.log(`    GET ${url}`);

    const t0 = Date.now();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err: any) {
      console.log(`    ERROR: ${err.message}`);
      break;
    }

    const elapsed = Date.now() - t0;

    if (response.status === 404) {
      console.log(`    404 — no more pages (${elapsed}ms)`);
      break;
    }

    if (!response.ok) {
      console.log(`    HTTP ${response.status} (${elapsed}ms)`);
      break;
    }

    const text = await response.text();
    bytesTotal += text.length;
    const lines = text.trim().split('\n').filter(Boolean);
    console.log(`    page ${page}: ${lines.length} lines, ${(text.length / 1024).toFixed(0)}KB, ${elapsed}ms`);

    if (lines.length === 0) break;
    allLines.push(...lines);
    page++;

    // Brief pause between pages to be polite
    await new Promise(r => setTimeout(r, 500));
  }

  return { lines: allLines, bytesTotal, pagesQueried: page };
}

async function main() {
  const { collection, maxPages } = parseArgs();
  const OUTPUT = path.join(import.meta.dirname, '..', 'benchmarks', 'feed', 'fixtures', 'discovery', 'cc-index-real.jsonl');

  console.log('CC Index Discovery');
  console.log(`  Collection: ${collection}`);
  console.log(`  Max pages per pattern: ${maxPages}`);
  console.log(`  Output: ${OUTPUT}`);
  console.log('');

  const t0 = Date.now();
  const allSlugs = new Map<string, { ats_type: string; slug: string; ats_url: string; url_seen: string }>();
  const perPattern: { pattern: string; lines: number; bytes: number; pages: number; slugs: number }[] = [];

  for (const pattern of CC_PATTERNS) {
    console.log(`  Pattern: ${pattern}`);
    const { lines, bytesTotal, pagesQueried } = await queryPattern(pattern, collection, maxPages);

    let newSlugs = 0;
    for (const line of lines) {
      try {
        const entry: CcEntry = JSON.parse(line);
        if (!entry.url) continue;
        const parsed = parseAtsUrl(entry.url);
        if (!parsed) continue;
        const key = `${parsed.ats_type}:${parsed.slug}`;
        if (!allSlugs.has(key)) {
          allSlugs.set(key, { ...parsed, url_seen: entry.url });
          newSlugs++;
        }
      } catch { /* skip malformed lines */ }
    }

    perPattern.push({ pattern, lines: lines.length, bytes: bytesTotal, pages: pagesQueried, slugs: newSlugs });
    console.log(`    => ${newSlugs} new unique slugs (${allSlugs.size} total so far)`);
    console.log('');
  }

  const totalElapsed = (Date.now() - t0) / 1000;

  // Write JSONL output (same format as CC index fixture)
  const outputLines: string[] = [];
  for (const [, info] of allSlugs) {
    outputLines.push(JSON.stringify({
      url: info.url_seen,
      slug: info.slug,
      ats_type: info.ats_type,
      ats_url: info.ats_url,
      collection,
    }));
  }
  fs.writeFileSync(OUTPUT, outputLines.join('\n') + '\n');

  // Random sample of 20 slugs for spot-checking
  const entries = [...allSlugs.values()];
  const sample: typeof entries = [];
  const indices = new Set<number>();
  while (sample.length < Math.min(20, entries.length)) {
    const idx = Math.floor(Math.random() * entries.length);
    if (indices.has(idx)) continue;
    indices.add(idx);
    sample.push(entries[idx]);
  }

  // Report
  console.log('='.repeat(60));
  console.log('CC DISCOVERY REPORT');
  console.log('='.repeat(60));
  console.log('');
  console.log(`  Collection:        ${collection}`);
  console.log(`  Runtime:           ${totalElapsed.toFixed(1)}s`);
  console.log(`  Total unique slugs: ${allSlugs.size}`);
  console.log(`  Output file:       ${OUTPUT} (${(fs.statSync(OUTPUT).size / 1024).toFixed(0)}KB)`);
  console.log('');

  console.log('  Per-pattern breakdown:');
  let totalBytes = 0;
  let totalLines = 0;
  for (const p of perPattern) {
    totalBytes += p.bytes;
    totalLines += p.lines;
    console.log(`    ${p.pattern.padEnd(30)} ${String(p.pages).padEnd(3)} pages  ${String(p.lines).padEnd(8)} lines  ${(p.bytes / 1024).toFixed(0).padStart(6)}KB  ${String(p.slugs).padStart(6)} slugs`);
  }
  console.log(`    ${'TOTAL'.padEnd(30)} ${' '.repeat(10)} ${String(totalLines).padEnd(8)} lines  ${(totalBytes / 1024).toFixed(0).padStart(6)}KB  ${String(allSlugs.size).padStart(6)} slugs`);
  console.log('');

  // ATS distribution
  const byAts: Record<string, number> = {};
  for (const [, info] of allSlugs) {
    byAts[info.ats_type] = (byAts[info.ats_type] || 0) + 1;
  }
  console.log('  ATS distribution:');
  for (const [ats, count] of Object.entries(byAts).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${ats.padEnd(15)} ${count}`);
  }
  console.log('');

  console.log('  Random 20 slugs for spot-checking:');
  for (const s of sample) {
    console.log(`    ${s.ats_type.padEnd(12)} ${s.slug.padEnd(30)} ${s.ats_url}`);
  }
  console.log('');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
