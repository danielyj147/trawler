import type { CompanyInput } from '../schema.js';
import type { AtsType } from '../schema.js';
import { ATS_TYPES } from '../schema.js';
import type { DiscoveryResult } from './types.js';

// Known ATS URL patterns
const ATS_PATTERNS: { pattern: RegExp; ats_type: AtsType; buildUrl: (slug: string) => string }[] = [
  {
    pattern: /boards\.greenhouse\.io\/([a-z0-9_-]+)/i,
    ats_type: 'greenhouse',
    buildUrl: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`,
  },
  {
    pattern: /jobs\.lever\.co\/([a-z0-9_-]+)/i,
    ats_type: 'lever',
    buildUrl: (slug) => `https://api.lever.co/v0/postings/${slug}`,
  },
  {
    pattern: /jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i,
    ats_type: 'ashby',
    buildUrl: (slug) => `https://jobs.ashbyhq.com/api/non-user-graphql`,
  },
  // New format: apply.workable.com/{slug}/...
  {
    pattern: /apply\.workable\.com\/([a-z0-9_-]+)/i,
    ats_type: 'workable',
    buildUrl: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
  },
  // Old format: {slug}.workable.com — exclude "apply" and "www"
  {
    pattern: /(?!apply\.)(?!www\.)([a-z0-9_-]+)\.workable\.com/i,
    ats_type: 'workable',
    buildUrl: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
  },
];

/** Extract ATS type and slug from a URL. Returns null if no match. */
export function parseAtsUrl(url: string): { ats_type: AtsType; slug: string; ats_url: string } | null {
  for (const { pattern, ats_type, buildUrl } of ATS_PATTERNS) {
    const match = url.match(pattern);
    if (match && match[1]) {
      const slug = match[1].toLowerCase();
      return { ats_type, slug, ats_url: buildUrl(slug) };
    }
  }
  return null;
}

/**
 * Parse a markdown table row for ATS URLs.
 * Handles formats like: | [Company](https://boards.greenhouse.io/slug) | ... |
 * and: | Company | ... | [Apply](https://boards.greenhouse.io/slug/jobs/123) |
 */
function extractFromMarkdownRow(line: string): { name: string; ats_type: AtsType; slug: string; ats_url: string } | null {
  // Extract all URLs from the line
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  const urls = line.match(urlRegex) || [];

  for (const url of urls) {
    const parsed = parseAtsUrl(url);
    if (parsed) {
      // Try to extract company name from markdown link text: [Name](url)
      const nameMatch = line.match(/\|\s*\[([^\]]+)\]/);
      const name = nameMatch?.[1] ?? parsed.slug;
      return { name, ...parsed };
    }
  }
  return null;
}

/**
 * Parse a markdown document (like SimplifyJobs README) for companies with ATS URLs.
 */
export function parseMarkdownTable(markdown: string): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];
  const seen = new Set<string>();

  for (const line of markdown.split('\n')) {
    if (!line.includes('|')) continue;
    const found = extractFromMarkdownRow(line);
    if (!found) continue;

    const key = `${found.ats_type}:${found.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      company: {
        name: found.name,
        slug: found.slug,
        ats_type: found.ats_type,
        ats_url: found.ats_url,
      },
      source_type: 'oss_list',
      source_detail: '', // filled in by caller
    });
  }

  return results;
}

/**
 * Parse a JSON array of company objects. Expected format:
 * [{ "name": "...", "slug": "...", "ats_type": "...", "ats_url": "..." }, ...]
 */
export function parseCompanyJson(json: string): DiscoveryResult[] {
  const data = JSON.parse(json);
  if (!Array.isArray(data)) return [];

  const results: DiscoveryResult[] = [];
  const seen = new Set<string>();

  for (const item of data) {
    if (!item.slug || !item.ats_type || !item.ats_url) continue;
    if (!ATS_TYPES.includes(item.ats_type)) continue;

    const key = `${item.ats_type}:${item.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({
      company: {
        name: item.name || item.slug,
        slug: item.slug,
        ats_type: item.ats_type,
        ats_url: item.ats_url,
      },
      source_type: 'oss_list',
      source_detail: '',
    });
  }

  return results;
}

/**
 * Parse plain-text lines containing ATS URLs (one URL per line, or mixed text).
 */
export function parseUrlList(text: string): DiscoveryResult[] {
  const results: DiscoveryResult[] = [];
  const seen = new Set<string>();
  const urlRegex = /https?:\/\/[^\s)>\]"']+/g;

  for (const line of text.split('\n')) {
    const urls = line.match(urlRegex) || [];
    for (const url of urls) {
      const parsed = parseAtsUrl(url);
      if (!parsed) continue;

      const key = `${parsed.ats_type}:${parsed.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);

      results.push({
        company: {
          name: parsed.slug,
          slug: parsed.slug,
          ats_type: parsed.ats_type,
          ats_url: parsed.ats_url,
        },
        source_type: 'oss_list',
        source_detail: '',
      });
    }
  }

  return results;
}
