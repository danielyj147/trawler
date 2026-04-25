import { parseAtsUrl } from './oss-lists.js';
import type { DiscoveryResult } from './types.js';

/**
 * Query the Common Crawl Index Server for URLs matching ATS patterns.
 *
 * The CC index is available at:
 *   https://index.commoncrawl.org/CC-MAIN-{collection}-index?url={pattern}&output=json
 *
 * Each result line is a JSON object with at least: { url, ... }
 * We extract the ATS slug from the URL and produce a DiscoveryResult.
 */

// ATS URL patterns to search the CC index for
const CC_PATTERNS = [
  'boards.greenhouse.io/*',
  'boards-api.greenhouse.io/*',
  'jobs.lever.co/*',
  'jobs.ashbyhq.com/*',
  '*.workable.com/j/*',
  '*.workable.com/jobs/*',
];

export interface CommonCrawlConfig {
  /** CC collection to search, e.g. "CC-MAIN-2026-09". Defaults to latest. */
  collection?: string;
  /** Max pages to fetch per pattern (CC index paginates). */
  maxPages?: number;
  /** Custom fetch function for testing. */
  fetcher?: (url: string) => Promise<Response>;
}

/**
 * Parse a line of CC index JSON output. Returns a DiscoveryResult or null.
 */
function parseCcIndexLine(line: string): DiscoveryResult | null {
  try {
    const entry = JSON.parse(line);

    // Real discovery output has explicit slug/ats_type fields
    const atsUrl = entry.ats_url || entry.url;
    if (entry.slug && entry.ats_type && atsUrl) {
      return {
        company: {
          name: entry.slug,
          slug: entry.slug,
          ats_type: entry.ats_type,
          ats_url: atsUrl,
        },
        source_type: entry.source?.startsWith?.('github:') ? 'github' : (entry.source === 'common_crawl' ? 'common_crawl' : 'oss_list'),
        source_detail: entry.source || 'discovery',
      };
    }

    // CC index format: extract slug from URL
    const url = entry.url;
    if (!url || typeof url !== 'string') return null;
    const parsed = parseAtsUrl(url);
    if (!parsed) return null;
    return {
      company: {
        name: parsed.slug,
        slug: parsed.slug,
        ats_type: parsed.ats_type,
        ats_url: parsed.ats_url,
      },
      source_type: 'common_crawl',
      source_detail: entry.collection || 'CC-MAIN',
    };
  } catch {
    return null;
  }
}

/**
 * Parse CC index JSONL (the format returned by the CC Index Server API
 * and used for fixtures). Each line is a JSON object with at least { url }.
 */
export function parseCcIndexJsonl(jsonl: string): DiscoveryResult[] {
  const seen = new Set<string>();
  const results: DiscoveryResult[] = [];

  for (const line of jsonl.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const result = parseCcIndexLine(trimmed);
    if (!result) continue;
    const key = `${result.company.ats_type}:${result.company.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(result);
  }

  return results;
}

/**
 * Fetch from the CC Index Server API (production use).
 * Returns JSONL string of matching URLs.
 */
export async function fetchCcIndex(
  pattern: string,
  config?: CommonCrawlConfig,
): Promise<string> {
  const fetcher = config?.fetcher ?? globalThis.fetch;
  const collection = config?.collection ?? 'CC-MAIN-2026-09';
  const maxPages = config?.maxPages ?? 5;

  let allLines = '';
  let page = 0;

  while (page < maxPages) {
    const url = `https://index.commoncrawl.org/${collection}-index?url=${encodeURIComponent(pattern)}&output=json&page=${page}`;
    const response = await fetcher(url);

    if (!response.ok) {
      if (response.status === 404) break; // no more pages
      throw new Error(`CC index query failed: ${response.status} for ${pattern}`);
    }

    const text = await response.text();
    if (!text.trim()) break;
    allLines += text + '\n';
    page++;
  }

  return allLines;
}

/**
 * Discover companies from Common Crawl for all known ATS patterns.
 */
export async function discoverFromCommonCrawl(
  config?: CommonCrawlConfig,
): Promise<DiscoveryResult[]> {
  const allResults: DiscoveryResult[] = [];
  const seen = new Set<string>();

  for (const pattern of CC_PATTERNS) {
    try {
      const jsonl = await fetchCcIndex(pattern, config);
      const results = parseCcIndexJsonl(jsonl);
      for (const r of results) {
        const key = `${r.company.ats_type}:${r.company.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        allResults.push(r);
      }
    } catch (err) {
      console.error(`Warning: CC index query failed for ${pattern}: ${err}`);
    }
  }

  return allResults;
}
