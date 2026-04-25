import type { Profile } from './profile.js';
import type { JobRow } from '../schema.js';
import { checkHardConstraints } from './hard-constraints.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface QualifyResult {
  qualified: boolean;
  score: number; // 0-100
  band: 'push' | 'digest' | 'skip';
  hard_failures: string[];
  reasoning: string;
  evidence: { from_posting: string[]; from_profile: string[] };
  latency_ms: number;
}

export interface Qualifier {
  qualify(profile: Profile, job: JobRow): Promise<QualifyResult>;
  qualifyBatch(profile: Profile, jobs: JobRow[]): Promise<QualifyResult[]>;
}

/**
 * The qualifier system prompt is split into a static rubric and a per-profile
 * "level context" block built from the loaded Profile. The rubric is
 * candidate-agnostic; what changes per operator is the experience years and
 * which postings count as "stretch" vs "reject" given that.
 */
function buildLevelContext(profile: Profile): string {
  const yrs = profile.experience_years;
  const stretchLow = yrs + 1;
  const stretchHigh = yrs + 3;
  const rejectAt = yrs + 2;
  return `CANDIDATE LEVEL CONTEXT (derived from profile). The candidate has ~${yrs} years of professional experience and is targeting ${profile.role_targets.join(', ')}.

- "New grad / class of ${profile.graduation}" postings — FIT.
- "1-2 years post-graduation" postings — FIT.
- "${yrs}+ years" postings — FIT.
- "Mid-level" or "${stretchLow}-${stretchHigh} years" postings — STRETCH. Cap at 60.
- "${rejectAt}+ years" or "senior" postings — REJECT. Cap at 40.

A role that redirects new grads to a separate listing is usually just separating grad-track hiring from post-grad hiring; that alone doesn't imply ${rejectAt}+ years. Look at what experience range is asked of THIS posting.`;
}

const RUBRIC = `You are a job qualification engine. You will receive a candidate profile and multiple job postings. Evaluate EACH job independently.

Output ONLY a valid JSON array. One object per job, in the same order as the input:
[
  {
    "job_id": 1,
    "qualified": true/false,
    "score": 0-100,
    "reasoning": "2-3 sentences citing specific evidence from the posting and profile",
    "evidence": {
      "from_posting": ["quoted requirements from the posting"],
      "from_profile": ["matching skills/experience from the profile"]
    }
  },
  ...
]

Scoring:
- 80-100: Right level, strong tech stack overlap, role matches targets. The candidate could credibly get this job.
- 70-79: Strong match, small caveats. Push-worthy.
- 55-69: Partial overlap. Digest-worthy but not push.
- 35-54: Stretch role. Some relevant skills but significant gaps or wrong level.
- 0-34: Wrong domain, wrong level, or missing critical requirements.

CRITICAL rules that override apparent stack match. A score at or above 70 requires ALL of these to be clean.

1. LEVEL MATCH. If the posting language strongly implies 3+ years expected — "mid-level" (typically 3-5 yrs), "mid to senior", "intermediate" with explicit years, "experienced engineer" as a required category, explicit "3+ years required" — cap score at 60. The candidate is early-career.
   OVERRIDE: Do NOT apply this cap if the posting EXPLICITLY welcomes entry-level, new-grad, 0-2 years, or "early career". A level-II/III title alone is NOT sufficient signal — many companies use those for 2-year targets. Look at what the description says about experience expectations, not the title.

2. DOMAIN MATCH. The candidate's experience is in web/product SWE: full-stack apps, backend APIs, ML/data pipelines, AWS cloud, security tooling. SWE roles in highly specialized domains (hardware/firmware, industrial/factory automation, game engines, quant trading, compilers/kernels, bioinformatics, etc.) require domain familiarity beyond shared languages. If the role's primary work is in such a domain AND the candidate shows no signal for it, cap at 60. Common web/cloud/data product domains do NOT trigger this.

3. PRIMARY LANGUAGE. If the posting's PRIMARY required language (Go, Rust, C#, Scala, Swift, Kotlin, etc.) is NOT in the candidate's skills, cap score at 35 regardless of domain overlap.

4. ROLE TYPE. Security operations, compliance admin, vulnerability management, DevSecOps tooling admin — these are NOT software engineering. Cap score at 25. The candidate's cybersecurity background is a BONUS for SWE-in-security-domain roles; it does NOT qualify them for security-ops/admin roles.

5. LOCATION. Any US location is acceptable — New York, Remote-US, and other US metros (Boston, SF, LA, Seattle, Chicago, Austin, etc.) are all fair game. Non-US locations are already filtered by hard constraints upstream. Do NOT apply a generic non-NY penalty.

6. NICHE DOMAIN ENTHUSIASM. "Passionate about crypto/blockchain/Web3", "obsessed with climate", "religious about open-source", etc. — if the posting signals niche domain loyalty the candidate has no signal for, lower score.

If no description is available, score on title/location/department only and cap at 55.`;

function buildProfileBlock(profile: Profile): string {
  return `## Candidate Profile
Name: ${profile.name}
Degree: ${profile.degree} (graduating ${profile.graduation})
Experience: ${profile.experience_years} years
Citizenship: ${profile.citizenship.join(', ')}
Location: ${profile.location_preference.join(', ')}
Role targets: ${profile.role_targets.join(', ')}
Strong skills: ${profile.skills.strong.join(', ')}
Working knowledge: ${profile.skills.working.join(', ')}
Highlights:
${profile.highlights.map(h => '- ' + h).join('\n')}`;
}

function buildJobBlock(job: JobRow, id: number): string {
  const raw = JSON.parse(job.raw_json || '{}');
  const desc = raw.descriptionHtml || raw.descriptionPlain || raw.description || raw.content || '';
  const clean = desc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const trunc = clean.length > 2000 ? clean.substring(0, 2000) + '...' : clean;

  return `### Job ${id}
Title: ${job.title}
Location: ${job.location || 'Not specified'}
Department: ${job.department || 'Not specified'}
${trunc || '(No description available)'}`;
}

function parseBand(score: number): 'push' | 'digest' | 'skip' {
  if (score >= 65) return 'push';
  if (score >= 40) return 'digest';
  return 'skip';
}

/**
 * Find the outermost balanced JSON array in `s`. The naive greedy regex
 * `\[[\s\S]*\]` matched from the first `[` (often inside prose) to the last
 * `]`, which then failed to JSON.parse. Scan-based extraction is robust to
 * prose around the array — including markdown fences and inline brackets.
 *
 * Returns the substring `s.slice(start, end+1)` containing exactly the
 * outermost array, or null if no balanced array was found.
 */
function extractJsonArray(s: string): string | null {
  // Strip markdown fences first — claude often wraps JSON in ```json ... ```
  const cleaned = s.replace(/```(?:json)?\s*/g, '').replace(/```/g, '');

  for (let start = 0; start < cleaned.length; start++) {
    if (cleaned[start] !== '[') continue;
    // Walk forward tracking string state and bracket depth
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          const candidate = cleaned.slice(start, i + 1);
          // Smoke test — must look like a JSON array with at least one object
          if (candidate.includes('{')) return candidate;
          break; // not the array we want; try next `[`
        }
      }
    }
  }
  return null;
}

function parseBatchOutput(raw: string, count: number): Omit<QualifyResult, 'hard_failures' | 'band' | 'latency_ms'>[] {
  const candidate = extractJsonArray(raw);
  if (!candidate) {
    return Array(count).fill({
      qualified: false, score: 0,
      reasoning: 'Failed to parse batch output',
      evidence: { from_posting: [], from_profile: [] },
    });
  }

  try {
    const parsed = JSON.parse(candidate);
    if (!Array.isArray(parsed)) throw new Error('Not an array');

    return parsed.map((item: any) => ({
      qualified: item.qualified ?? false,
      score: typeof item.score === 'number' ? Math.min(100, Math.max(0, item.score)) : 0,
      reasoning: item.reasoning || '',
      evidence: {
        from_posting: Array.isArray(item.evidence?.from_posting) ? item.evidence.from_posting : [],
        from_profile: Array.isArray(item.evidence?.from_profile) ? item.evidence.from_profile : [],
      },
    }));
  } catch {
    return Array(count).fill({
      qualified: false, score: 0,
      reasoning: 'Failed to parse batch JSON',
      evidence: { from_posting: [], from_profile: [] },
    });
  }
}

// Title pre-filters
const RELEVANT_TITLE = /engineer|developer|swe\b|sde\b|backend|frontend|fullstack|full.?stack|devops|sre|platform|infrastructure|cloud|ai\b|ml\b|machine.?learn|data.?scien|software/i;
const IRRELEVANT_TITLE = /recruiter|coordinator|sales|marketing|account.?exec|operations.?manager|customer.?success|analyst(?!.*data)|designer(?!.*system)|nurse|physician|mechanic|electrician|cook|driver|warehouse/i;

function isTitleRelevant(title: string): boolean {
  if (IRRELEVANT_TITLE.test(title)) return false;
  return RELEVANT_TITLE.test(title);
}

export class ClaudeCliQualifier implements Qualifier {
  private model: string;
  private batchSize: number;

  constructor(model: string = 'sonnet', batchSize: number = 15) {
    this.model = model;
    this.batchSize = batchSize;
  }

  async qualify(profile: Profile, job: JobRow): Promise<QualifyResult> {
    return (await this.qualifyBatch(profile, [job]))[0];
  }

  async qualifyBatch(profile: Profile, jobs: JobRow[]): Promise<QualifyResult[]> {
    const results: QualifyResult[] = new Array(jobs.length);
    const llmJobs: { index: number; job: JobRow }[] = [];

    // Phase 1: deterministic filters (instant)
    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];

      // Hard constraints
      const constraints = checkHardConstraints(profile, job.title, job.raw_json || '');
      if (!constraints.passed) {
        results[i] = {
          qualified: false, score: 0, band: 'skip',
          hard_failures: constraints.failures,
          reasoning: 'Hard constraint: ' + constraints.failures.join('; '),
          evidence: { from_posting: [], from_profile: [] },
          latency_ms: 0,
        };
        continue;
      }

      // Title filter
      if (!isTitleRelevant(job.title)) {
        results[i] = {
          qualified: false, score: 0, band: 'skip',
          hard_failures: [],
          reasoning: `Title "${job.title}" not SWE-relevant`,
          evidence: { from_posting: [], from_profile: [] },
          latency_ms: 0,
        };
        continue;
      }

      llmJobs.push({ index: i, job });
    }

    // Phase 2: batch LLM qualification
    const profileBlock = buildProfileBlock(profile);
    const levelContext = buildLevelContext(profile);

    for (let batchStart = 0; batchStart < llmJobs.length; batchStart += this.batchSize) {
      const batch = llmJobs.slice(batchStart, batchStart + this.batchSize);
      const jobBlocks = batch.map((b, idx) => buildJobBlock(b.job, idx + 1)).join('\n\n');

      const prompt = `${RUBRIC}\n\n${levelContext}\n\n${profileBlock}\n\n## Job Postings (${batch.length} jobs to evaluate)\n\n${jobBlocks}`;

      const t0 = performance.now();
      try {
        const { stdout } = await execFileAsync('claude', [
          '-p', prompt,
          '--output-format', 'text',
          '--model', this.model,
        ], {
          encoding: 'utf-8',
          timeout: 600_000, // 10 min for large batches
          maxBuffer: 10 * 1024 * 1024,
        });

        const latency_ms = performance.now() - t0;
        const perJob = latency_ms / batch.length;
        const parsed = parseBatchOutput(stdout, batch.length);

        for (let i = 0; i < batch.length; i++) {
          const p = parsed[i] || { qualified: false, score: 0, reasoning: 'Missing from batch output', evidence: { from_posting: [], from_profile: [] } };
          results[batch[i].index] = {
            ...p,
            band: parseBand(p.score),
            hard_failures: [],
            latency_ms: perJob,
          };
        }
      } catch (err: any) {
        const latency_ms = performance.now() - t0;
        for (const b of batch) {
          results[b.index] = {
            qualified: false, score: 0, band: 'skip',
            hard_failures: [],
            reasoning: `Batch error: ${err.message?.substring(0, 100)}`,
            evidence: { from_posting: [], from_profile: [] },
            latency_ms,
          };
        }
      }
    }

    return results;
  }
}
