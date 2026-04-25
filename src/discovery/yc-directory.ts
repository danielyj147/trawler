/**
 * YC directory discovery: fetches companies from ycombinator.com/companies API.
 *
 * The YC directory has a public JSON API used by its frontend. We paginate
 * through it and check each company's website for ATS URL patterns.
 */

import { parseAtsUrl } from './oss-lists.js';
import type { DiscoveryResult } from './types.js';

const YC_API = 'https://45bwzj1sgc-dsn.algolia.net/1/indexes/YCCompany_production';
const ALGOLIA_APP_ID = '45BWZJ1SGC';
const ALGOLIA_API_KEY = 'NzllNTY5MzJiZGM2OTY2ZTQwMDEzOTNhYWZiZGRjODlhYzVkNjBmOGRjNzJiMWM4ZTU0ZDlhYTZjOTJiMjlhMWFuYWx5dGljc1RhZ3M9eWNkYyZyZXN0cmljdEluZGljZXM9WUNDb21wYW55X3Byb2R1Y3Rpb24lMkNZQ0NvbXBhbnlfQnlfTGF1bmNoX0RhdGVfcHJvZHVjdGlvbiZ0YWdGaWx0ZXJzPSU1QiUyMnljZGNfcHVibGljJTIyJTVE';

interface YcCompany {
  name: string;
  slug: string;
  website?: string;
  long_description?: string;
  one_liner?: string;
  team_size?: number;
  highlight_black?: boolean;
  batch?: string;
  status?: string;
  industries?: string[];
  regions?: string[];
  all_locations?: string[];
}

/**
 * Fetch YC companies via Algolia (the same API the YC website uses).
 * Returns raw company data; ATS URL extraction happens separately.
 */
async function fetchYcCompanies(): Promise<YcCompany[]> {
  const companies: YcCompany[] = [];

  // First, get all batch names via facets
  const facetRes = await fetch(
    `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Algolia-Application-Id': ALGOLIA_APP_ID,
        'X-Algolia-API-Key': ALGOLIA_API_KEY,
      },
      body: JSON.stringify({ requests: [{ indexName: 'YCCompany_production', params: 'hitsPerPage=0&facets=["batch"]' }] }),
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!facetRes.ok) { console.log(`    YC facet query failed: ${facetRes.status}`); return companies; }
  const facetData = await facetRes.json() as any;
  const batches = Object.keys(facetData.results?.[0]?.facets?.batch || {});
  console.log(`    ${batches.length} batches, querying each...`);

  // Query each batch (all under 400 companies, well within 1000-record limit)
  for (const batch of batches) {
    const params = `hitsPerPage=1000&page=0&facetFilters=${encodeURIComponent(JSON.stringify([["batch:" + batch]]))}`;
    const res = await fetch(
      `https://${ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/*/queries`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Algolia-Application-Id': ALGOLIA_APP_ID,
          'X-Algolia-API-Key': ALGOLIA_API_KEY,
        },
        body: JSON.stringify({ requests: [{ indexName: 'YCCompany_production', params }] }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!res.ok) { console.log(`    batch "${batch}": error ${res.status}`); continue; }
    const data = await res.json() as any;
    const hits = data.results?.[0]?.hits || [];
    for (const hit of hits) {
      companies.push({
        name: hit.name, slug: hit.slug, website: hit.website,
        long_description: hit.long_description, one_liner: hit.one_liner,
        team_size: hit.team_size, batch: hit.batch, status: hit.status,
        industries: hit.industries, regions: hit.regions, all_locations: hit.all_locations,
      });
    }
    await new Promise(r => setTimeout(r, 100));
  }

  console.log(`    Total: ${companies.length} companies`);
  return companies;
}

/**
 * For each YC company with a website, check if it matches an ATS pattern.
 * Also checks long_description for ATS URLs.
 */
function extractAtsFromYc(companies: YcCompany[]): DiscoveryResult[] {
  const seen = new Set<string>();
  const results: DiscoveryResult[] = [];
  const urlRegex = /https?:\/\/[^\s)>\]"'`,]+/g;

  for (const company of companies) {
    // Check website URL directly
    const urlsToCheck = [company.website, company.long_description, company.one_liner]
      .filter(Boolean)
      .join(' ');

    for (const match of urlsToCheck.matchAll(urlRegex)) {
      const url = match[0].replace(/[.)]+$/, '');
      const parsed = parseAtsUrl(url);
      if (!parsed) continue;
      const key = `${parsed.ats_type}:${parsed.slug}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({
        company: {
          name: company.name,
          slug: parsed.slug,
          ats_type: parsed.ats_type,
          ats_url: parsed.ats_url,
        },
        source_type: 'yc',
        source_detail: `yc:${company.batch || 'unknown'}`,
      });
    }
  }

  return results;
}

/**
 * For YC companies whose websites don't contain ATS URLs directly,
 * probe known ATS patterns with the company slug.
 */
async function probeYcCompanies(
  companies: YcCompany[],
  existingSlugs: Set<string>,
): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  const probePatterns = [
    { ats_type: 'greenhouse' as const, url: (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs` },
    { ats_type: 'ashby' as const, url: (_slug: string) => 'https://jobs.ashbyhq.com/api/non-user-graphql' },
    { ats_type: 'lever' as const, url: (slug: string) => `https://api.lever.co/v0/postings/${slug}` },
  ];

  // Only probe companies we haven't found via URL extraction
  const toProbe = companies.filter(c => {
    const slug = c.slug?.toLowerCase().replace(/[^a-z0-9-]/g, '');
    return slug && !existingSlugs.has(`greenhouse:${slug}`) && !existingSlugs.has(`ashby:${slug}`) && !existingSlugs.has(`lever:${slug}`);
  });

  console.log(`    Probing ${toProbe.length} YC companies for ATS boards...`);

  let probed = 0;
  for (const company of toProbe) {
    const slug = company.slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!slug) continue;

    // Try Greenhouse (most common for YC)
    try {
      const res = await fetch(probePatterns[0].url(slug), { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as any;
        if (data.jobs) {
          existingSlugs.add(`greenhouse:${slug}`);
          results.push({
            company: { name: company.name, slug, ats_type: 'greenhouse', ats_url: probePatterns[0].url(slug) },
            source_type: 'yc',
            source_detail: `yc-probe:${company.batch || 'unknown'}`,
          });
          probed++;
          if (probed % 200 === 0) console.log(`    Probed ${probed} total, found ${results.length} boards`);
          await new Promise(r => setTimeout(r, 50));
          continue; // Found on Greenhouse, skip other ATSes
        }
      }
    } catch {}

    // Try Lever
    try {
      const res = await fetch(probePatterns[2].url(slug), { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as any;
        if (Array.isArray(data)) {
          existingSlugs.add(`lever:${slug}`);
          results.push({
            company: { name: company.name, slug, ats_type: 'lever', ats_url: probePatterns[2].url(slug) },
            source_type: 'yc',
            source_detail: `yc-probe:${company.batch || 'unknown'}`,
          });
        }
      }
    } catch {}

    probed++;
    if (probed % 200 === 0) console.log(`    Probed ${probed} total, found ${results.length} boards`);
    await new Promise(r => setTimeout(r, 50));
  }

  return results;
}

export async function discoverFromYc(): Promise<DiscoveryResult[]> {
  console.log('  Fetching YC directory via Algolia...');
  const companies = await fetchYcCompanies();
  console.log(`    Total YC companies: ${companies.length}`);

  // Extract ATS URLs from company metadata
  const directResults = extractAtsFromYc(companies);
  console.log(`    Direct ATS URL matches: ${directResults.length}`);

  // Probe remaining companies
  const existingSlugs = new Set(directResults.map(r => `${r.company.ats_type}:${r.company.slug}`));
  const probeResults = await probeYcCompanies(companies, existingSlugs);
  console.log(`    Probe matches: ${probeResults.length}`);

  return [...directResults, ...probeResults];
}
