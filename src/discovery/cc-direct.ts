/**
 * Common Crawl direct CDX access: bypasses the Index Server by downloading
 * CDX shard blocks directly from S3 via HTTP Range requests.
 *
 * How it works:
 * 1. Download cluster.idx — maps SURT ranges to CDX shard file offsets
 * 2. Find blocks containing our target ATS hostnames (SURT-sorted)
 * 3. Download only those blocks (independently gzip-compressed, ~2-3MB total)
 * 4. Parse CDX entries, extract unique company slugs
 */

import { parseAtsUrl } from './oss-lists.js';
import type { DiscoveryResult } from './types.js';
import { gunzipSync } from 'node:zlib';

const CC_BASE = 'https://data.commoncrawl.org/cc-index/collections';

// SURT prefixes for our ATS hostnames
const SURT_TARGETS: { prefix: string; ats_type: string }[] = [
  { prefix: 'io,greenhouse,boards)', ats_type: 'greenhouse' },
  { prefix: 'com,ashbyhq,jobs)', ats_type: 'ashby' },
  { prefix: 'com,workable,apply)', ats_type: 'workable' },
  { prefix: 'co,lever,jobs)', ats_type: 'lever' },
];

interface CdxBlock {
  shard: string;
  offset: number;
  length: number;
  surtPrefix: string;
}

async function downloadClusterIdx(collection: string): Promise<string> {
  const url = `${CC_BASE}/${collection}/indexes/cluster.idx`;
  console.log(`  Downloading cluster.idx from ${collection}...`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`cluster.idx: HTTP ${res.status}`);
  return res.text();
}

function findBlocks(clusterIdx: string, surtPrefix: string): CdxBlock[] {
  const blocks: CdxBlock[] = [];
  for (const line of clusterIdx.split('\n')) {
    if (!line.startsWith(surtPrefix)) continue;
    const parts = line.split('\t');
    if (parts.length < 4) continue;
    blocks.push({
      shard: parts[1],
      offset: parseInt(parts[2], 10),
      length: parseInt(parts[3], 10),
      surtPrefix,
    });
  }
  return blocks;
}

async function downloadBlock(collection: string, block: CdxBlock): Promise<string> {
  const url = `${CC_BASE}/${collection}/indexes/${block.shard}`;
  const end = block.offset + block.length - 1;
  const res = await fetch(url, {
    headers: { 'Range': `bytes=${block.offset}-${end}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Block download failed: HTTP ${res.status}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return gunzipSync(buf).toString('utf-8');
}

function extractSlugsFromCdx(cdxText: string): Map<string, { slug: string; ats_type: string; url: string }> {
  const results = new Map<string, { slug: string; ats_type: string; url: string }>();

  for (const line of cdxText.split('\n')) {
    if (!line.trim()) continue;
    // CDX format: SURT_key timestamp JSON_blob
    const jsonStart = line.indexOf('{');
    if (jsonStart < 0) continue;
    try {
      const json = JSON.parse(line.substring(jsonStart));
      const url = json.url;
      if (!url) continue;
      const parsed = parseAtsUrl(url);
      if (!parsed) continue;
      const key = `${parsed.ats_type}:${parsed.slug}`;
      if (!results.has(key)) {
        results.set(key, { slug: parsed.slug, ats_type: parsed.ats_type, url });
      }
    } catch { /* skip malformed */ }
  }

  return results;
}

export async function discoverFromCcDirect(
  collections?: string[],
): Promise<DiscoveryResult[]> {
  const targetCollections = collections || ['CC-MAIN-2026-12', 'CC-MAIN-2026-08'];
  const allSlugs = new Map<string, { slug: string; ats_type: string; url: string }>();

  for (const collection of targetCollections) {
    console.log(`  Collection: ${collection}`);
    let clusterIdx: string;
    try {
      clusterIdx = await downloadClusterIdx(collection);
    } catch (err: any) {
      console.log(`    Failed: ${err.message}`);
      continue;
    }
    console.log(`    cluster.idx: ${clusterIdx.split('\n').length} lines`);

    for (const target of SURT_TARGETS) {
      const blocks = findBlocks(clusterIdx, target.prefix);
      if (blocks.length === 0) {
        console.log(`    ${target.prefix}: no blocks found`);
        continue;
      }

      const totalBytes = blocks.reduce((s, b) => s + b.length, 0);
      console.log(`    ${target.prefix}: ${blocks.length} blocks, ${(totalBytes / 1024).toFixed(0)}KB`);

      for (const block of blocks) {
        try {
          const cdxText = await downloadBlock(collection, block);
          const slugs = extractSlugsFromCdx(cdxText);
          let newCount = 0;
          for (const [key, info] of slugs) {
            if (!allSlugs.has(key)) {
              allSlugs.set(key, info);
              newCount++;
            }
          }
          console.log(`      ${block.shard}@${block.offset}: ${slugs.size} URLs, ${newCount} new slugs`);
        } catch (err: any) {
          console.log(`      ${block.shard}@${block.offset}: ${err.message}`);
        }
      }
    }
  }

  const results: DiscoveryResult[] = [];
  for (const [, info] of allSlugs) {
    results.push({
      company: {
        name: info.slug,
        slug: info.slug,
        ats_type: info.ats_type,
        ats_url: info.url,
      },
      source_type: 'common_crawl',
      source_detail: 'cc-direct-cdx',
    });
  }

  console.log(`  Total CC slugs: ${results.length}`);
  return results;
}
