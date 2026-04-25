/**
 * Hacker News "Who's Hiring" discovery: extracts ATS URLs from monthly threads.
 *
 * Uses the Algolia HN API (free, no auth) to fetch "Who's Hiring" threads
 * from the last 12 months. Each comment typically contains a company name
 * and a job/careers link.
 */

import { parseAtsUrl } from './oss-lists.js';
import type { DiscoveryResult } from './types.js';

const HN_ALGOLIA = 'https://hn.algolia.com/api/v1';

interface HnItem {
  objectID: string;
  title?: string;
  story_text?: string;
  comment_text?: string;
  created_at?: string;
  children?: HnItem[];
}

/**
 * Find "Ask HN: Who is hiring?" threads from the last 12 months.
 */
async function findWhosHiringThreads(months: number = 12): Promise<string[]> {
  const cutoff = Math.floor(Date.now() / 1000) - months * 30 * 86400;
  const url = `${HN_ALGOLIA}/search?query=%22who%20is%20hiring%22&tags=story&numericFilters=created_at_i>${cutoff}&hitsPerPage=20`;

  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    console.log(`    HN search error: ${res.status}`);
    return [];
  }

  const data = await res.json() as any;
  const storyIds: string[] = [];

  for (const hit of data.hits || []) {
    const title = (hit.title || '').toLowerCase();
    if (title.includes('who is hiring') && !title.includes('who wants')) {
      storyIds.push(hit.objectID);
    }
  }

  return storyIds;
}

/**
 * Fetch all comments for a HN thread.
 */
async function fetchThreadComments(storyId: string): Promise<string[]> {
  const url = `${HN_ALGOLIA}/search?tags=comment,story_${storyId}&hitsPerPage=1000`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return [];

  const data = await res.json() as any;
  return (data.hits || []).map((h: any) => h.comment_text || '').filter(Boolean);
}

export async function discoverFromHn(months: number = 12): Promise<DiscoveryResult[]> {
  console.log(`  Searching HN "Who is Hiring" threads (last ${months} months)...`);

  const threadIds = await findWhosHiringThreads(months);
  console.log(`    Found ${threadIds.length} threads`);

  const seen = new Set<string>();
  const results: DiscoveryResult[] = [];
  const urlRegex = /https?:\/\/[^\s<)>\]"'`,]+/g;

  for (const threadId of threadIds) {
    const comments = await fetchThreadComments(threadId);
    let threadNew = 0;

    for (const comment of comments) {
      // Strip HTML tags
      const text = comment.replace(/<[^>]+>/g, ' ');

      for (const match of text.matchAll(urlRegex)) {
        const url = match[0].replace(/[.)]+$/, '');
        const parsed = parseAtsUrl(url);
        if (!parsed) continue;
        const key = `${parsed.ats_type}:${parsed.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        threadNew++;
        results.push({
          company: { name: parsed.slug, slug: parsed.slug, ats_type: parsed.ats_type, ats_url: parsed.ats_url },
          source_type: 'hn',
          source_detail: `whos-hiring:${threadId}`,
        });
      }
    }

    console.log(`    Thread ${threadId}: ${comments.length} comments, ${threadNew} new companies`);
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}
