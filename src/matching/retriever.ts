/**
 * Two-stage retrieval pipeline: BM25 → feature re-rank → LLM qualifier.
 *
 * Stage 1 (retrieve): BM25 with query expansion from profile. Scores all jobs
 *   in milliseconds. Returns top-K candidates. High recall, low precision.
 *
 * Stage 2 (rerank): Feature-based scoring on the top-K. Skill overlap,
 *   experience level match, location, department. Returns top-N for LLM.
 *
 * Stage 3 (qualify): LLM batch evaluation on top-N only.
 */

import type { Profile } from './profile.js';
import type { JobRow } from '../schema.js';
import { checkHardConstraints } from './hard-constraints.js';

/**
 * Yield to the Node event loop so HTTP servers running in the same process
 * can handle requests during long synchronous passes (filter / BM25 build /
 * BM25 score). Without these breakpoints a single tick blocks dashboards
 * for 60-120 seconds — the operator-visible "loading indefinitely" bug.
 */
const YIELD_EVERY = 5000;
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ── BM25 ──

interface BM25Index {
  docs: { id: number; termFreqs: Map<string, number>; length: number }[];
  df: Map<string, number>; // document frequency per term
  avgDl: number;
  N: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase()
    .replace(/<[^>]+>/g, ' ')       // strip HTML
    .replace(/[^a-z0-9+#./-]/g, ' ') // keep alphanumeric + common tech chars
    .split(/\s+/)
    .filter(t => t.length > 1);
}

async function buildBM25Index(docs: { id: number; text: string }[]): Promise<BM25Index> {
  const indexed: BM25Index['docs'] = [];
  const df = new Map<string, number>();

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i];
    const tokens = tokenize(doc.text);
    const termFreqs = new Map<string, number>();
    const seen = new Set<string>();

    for (const t of tokens) {
      termFreqs.set(t, (termFreqs.get(t) || 0) + 1);
      if (!seen.has(t)) { seen.add(t); df.set(t, (df.get(t) || 0) + 1); }
    }

    indexed.push({ id: doc.id, termFreqs, length: tokens.length });
    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  const avgDl = indexed.reduce((s, d) => s + d.length, 0) / (indexed.length || 1);
  return { docs: indexed, df, avgDl, N: indexed.length };
}

async function bm25Score(index: BM25Index, queryTerms: string[], k1 = 1.5, b = 0.75): Promise<{ id: number; score: number }[]> {
  const results: { id: number; score: number }[] = [];

  for (let i = 0; i < index.docs.length; i++) {
    const doc = index.docs[i];
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.termFreqs.get(term) || 0;
      if (tf === 0) continue;
      const docFreq = index.df.get(term) || 0;
      const idf = Math.log((index.N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * doc.length / index.avgDl));
      score += idf * tfNorm;
    }
    if (score > 0) results.push({ id: doc.id, score });
    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  return results.sort((a, b) => b.score - a.score);
}

// ── Query expansion ──

export function expandQuery(profile: Profile): string[] {
  const terms = new Set<string>();

  // Role targets
  for (const r of profile.role_targets) {
    for (const t of tokenize(r)) terms.add(t);
  }

  // Skills (all tiers)
  for (const s of [...profile.skills.strong, ...profile.skills.working]) {
    for (const t of tokenize(s)) terms.add(t);
  }

  // Common SWE terms derived from role targets
  const expansions = [
    'software', 'engineer', 'developer', 'backend', 'frontend', 'fullstack',
    'full-stack', 'devops', 'sre', 'platform', 'infrastructure', 'cloud',
    'machine', 'learning', 'data', 'security', 'new', 'grad', 'junior',
    'entry', 'associate',
  ];
  for (const t of expansions) terms.add(t);

  return [...terms];
}

// ── Feature re-ranking ──

interface RerankFeatures {
  bm25_score: number;
  skill_overlap: number;      // fraction of posting skills that match profile
  level_match: number;        // 1.0 = right level, 0.5 = stretch, 0 = wrong
  location_match: number;     // 1.0 = match or remote, 0.5 = relocate, 0 = no match
  title_relevance: number;    // 1.0 = direct SWE match, 0.5 = adjacent, 0 = unrelated
  has_description: number;    // 1.0 = yes, 0.3 = no
  combined: number;
}

const SENIOR_PATTERN = /\b(senior|sr\.?|staff|principal|lead|director|vp|head of|manager)\b/i;
const JUNIOR_PATTERN = /\b(junior|jr\.?|entry|associate|new grad|intern|early career|i\b|ii\b)\b/i;
const SWE_TITLE = /\b(software|swe|sde|backend|frontend|fullstack|full.?stack|devops|sre|platform|cloud|data|ai|ml|machine.?learn|security)\b/i;

function computeFeatures(
  profile: Profile,
  job: JobRow,
  bm25: number,
  maxBm25: number,
): RerankFeatures {
  const raw = JSON.parse(job.raw_json || '{}');
  const desc = (raw.content || raw.descriptionHtml || raw.descriptionPlain || raw.description || '').toLowerCase();
  const titleLower = job.title.toLowerCase();
  const combined = titleLower + ' ' + desc;

  // Skill overlap
  const allSkills = [...profile.skills.strong, ...profile.skills.working];
  let matched = 0;
  for (const skill of allSkills) {
    const terms = tokenize(skill);
    if (terms.some(t => combined.includes(t))) matched++;
  }
  const skill_overlap = allSkills.length > 0 ? matched / allSkills.length : 0;

  // Level match
  let level_match = 0.7; // default: unknown level
  if (JUNIOR_PATTERN.test(titleLower)) level_match = 1.0;
  else if (SENIOR_PATTERN.test(titleLower)) level_match = 0.1;
  else if (/\bengineeri?n?g?\b/i.test(titleLower) && !SENIOR_PATTERN.test(titleLower)) level_match = 0.8;

  // Check years requirement in description
  const yearMatch = desc.match(/(\d+)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience|professional)/i);
  if (yearMatch) {
    const years = parseInt(yearMatch[1], 10);
    if (years <= 3) level_match = Math.max(level_match, 0.9);
    else if (years <= 4) level_match = Math.max(level_match, 0.6);
    else level_match = Math.min(level_match, 0.1);
  }

  // Location match
  let location_match = 0.5; // default: relocate
  const locLower = (job.location || '').toLowerCase();
  if (locLower.includes('remote') || locLower === '') location_match = 1.0;
  else if (locLower.includes('new york') || locLower.includes('nyc')) location_match = 1.0;
  else if (locLower.includes('united states') || locLower.includes('us')) location_match = 0.8;

  // Title relevance
  let title_relevance = 0;
  if (SWE_TITLE.test(titleLower)) title_relevance = 1.0;
  else if (/engineer/i.test(titleLower)) title_relevance = 0.5;

  const has_description = desc.length > 50 ? 1.0 : 0.3;
  const normBm25 = maxBm25 > 0 ? bm25 / maxBm25 : 0;

  // Weighted combination — level_match is highest because wrong-level jobs
  // waste LLM budget and never convert to push
  const combined_score =
    normBm25 * 0.20 +
    skill_overlap * 0.25 +
    level_match * 0.25 +
    title_relevance * 0.15 +
    location_match * 0.10 +
    has_description * 0.05;

  return {
    bm25_score: bm25,
    skill_overlap,
    level_match,
    location_match,
    title_relevance,
    has_description,
    combined: combined_score,
  };
}

// ── Pipeline ──

export interface RetrievalResult {
  job: JobRow;
  features: RerankFeatures;
  stage: 'retrieved' | 'reranked';
}

/**
 * Retrieve and rerank jobs for a profile.
 *
 * @param profile - user profile
 * @param jobs - all jobs from the feed
 * @param topK - how many to return from BM25 (stage 1)
 * @param topN - how many to return after reranking (stage 2, sent to LLM)
 */
export async function retrieveAndRerank(
  profile: Profile,
  jobs: JobRow[],
  topK: number = 200,
  topN: number = 50,
): Promise<RetrievalResult[]> {
  // Stage 0: Hard-constraint pre-filter. Run in chunks with event-loop
  // yields so the same Node process can serve dashboard HTTP requests.
  const eligible: JobRow[] = [];
  for (let i = 0; i < jobs.length; i++) {
    if (checkHardConstraints(profile, jobs[i].title, jobs[i].raw_json || '').passed) {
      eligible.push(jobs[i]);
    }
    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  if (eligible.length === 0) return [];

  // Build searchable text — also chunked so 50K JSON.parse calls don't block.
  const docs: { id: number; text: string }[] = [];
  for (let i = 0; i < eligible.length; i++) {
    const job = eligible[i];
    const raw = JSON.parse(job.raw_json || '{}');
    const desc = raw.content || raw.descriptionHtml || raw.descriptionPlain || raw.description || '';
    const cleanDesc = desc.replace(/<[^>]+>/g, ' ');
    docs.push({
      id: i,
      text: `${job.title} ${job.location || ''} ${job.department || ''} ${cleanDesc}`,
    });
    if ((i + 1) % YIELD_EVERY === 0) await yieldToEventLoop();
  }

  // Stage 1: BM25 retrieval over hard-constraint-eligible corpus
  const queryTerms = expandQuery(profile);
  const index = await buildBM25Index(docs);
  const bm25Results = await bm25Score(index, queryTerms);
  const topKResults = bm25Results.slice(0, topK);

  if (topKResults.length === 0) return [];
  const maxBm25 = topKResults[0].score;

  // Stage 2: Feature re-ranking on eligible top-K (top-K is small, no yield needed)
  const reranked: RetrievalResult[] = topKResults.map(r => ({
    job: eligible[r.id],
    features: computeFeatures(profile, eligible[r.id], r.score, maxBm25),
    stage: 'reranked' as const,
  }));

  reranked.sort((a, b) => b.features.combined - a.features.combined);
  return reranked.slice(0, topN);
}
