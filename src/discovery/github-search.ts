/**
 * GitHub code search discovery: searches for ATS URLs in markdown files.
 *
 * Requires: `gh` CLI authenticated, or GITHUB_TOKEN env var.
 * Rate limit: 30 req/min unauthenticated, 5000/hr authenticated.
 */

import { parseAtsUrl } from './oss-lists.js';
import type { DiscoveryResult } from './types.js';
import { execSync } from 'node:child_process';

const SEARCH_QUERIES = [
  'greenhouse.io/jobs',
  'boards.greenhouse.io',
  'jobs.lever.co',
  'jobs.ashbyhq.com',
  'apply.workable.com',
];

function getGhToken(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execSync('gh auth token', { encoding: 'utf-8' }).trim();
  } catch {
    throw new Error('No GitHub token. Set GITHUB_TOKEN or authenticate via `gh auth login`.');
  }
}

async function searchGitHub(
  query: string,
  token: string,
  maxPages: number = 10,
): Promise<string[]> {
  const fragments: string[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=100&page=${page}`;

    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3.text-match+json',
        'User-Agent': 'trawler-discovery/0.1',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (res.status === 403) {
      const resetAt = res.headers.get('X-RateLimit-Reset');
      if (resetAt) {
        const waitMs = Math.max(0, parseInt(resetAt) * 1000 - Date.now()) + 1000;
        if (waitMs < 120_000) { // Wait up to 2 minutes
          console.log(`    Rate limited. Waiting ${Math.ceil(waitMs / 1000)}s for reset...`);
          await new Promise(r => setTimeout(r, waitMs));
          page--; // Retry this page
          continue;
        }
      }
      console.log(`    Rate limited. Reset too far out, moving on.`);
      break;
    }

    if (res.status === 422) {
      // Validation error — query returned too many results or timed out
      console.log(`    422 — query too broad or timed out`);
      break;
    }

    if (!res.ok) {
      console.log(`    HTTP ${res.status}`);
      break;
    }

    const data = await res.json() as any;
    const items = data.items || [];

    for (const item of items) {
      for (const tm of item.text_matches || []) {
        if (tm.fragment) fragments.push(tm.fragment);
      }
    }

    const totalCount = data.total_count || 0;
    const fetched = page * 100;
    if (fetched >= totalCount || items.length === 0) break;

    // Respect secondary rate limit
    await new Promise(r => setTimeout(r, 2000));
  }

  return fragments;
}

export async function discoverFromGitHub(): Promise<DiscoveryResult[]> {
  const token = getGhToken();
  const seen = new Set<string>();
  const results: DiscoveryResult[] = [];

  for (const query of SEARCH_QUERIES) {
    console.log(`  GitHub search: "${query}"`);
    const fragments = await searchGitHub(query, token);

    let newCount = 0;
    const urlRegex = /https?:\/\/[^\s)>\]"'`,]+/g;

    for (const fragment of fragments) {
      for (const match of fragment.matchAll(urlRegex)) {
        const url = match[0].replace(/[.)]+$/, '');
        const parsed = parseAtsUrl(url);
        if (!parsed) continue;
        const key = `${parsed.ats_type}:${parsed.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        newCount++;
        results.push({
          company: { name: parsed.slug, slug: parsed.slug, ats_type: parsed.ats_type, ats_url: parsed.ats_url },
          source_type: 'github',
          source_detail: `code-search:${query.split(' ')[0]}`,
        });
      }
    }

    console.log(`    ${fragments.length} fragments, ${newCount} new companies`);
    // Respect rate limits between queries
    await new Promise(r => setTimeout(r, 3000));
  }

  return results;
}
