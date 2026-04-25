/**
 * Independent LLM labeler for the matching benchmark testset.
 *
 * Why a separate labeler:
 * - User labels are authoritative but scarce (~9 right now). Too few to
 *   statistically validate generalization of qualifier prompt changes.
 * - An independent LLM produces hundreds of labels cheaply. We treat them as a
 *   noisy ground truth — calibrated against the user labels we DO have.
 *
 * Why this won't game the qualifier:
 * - Different model (Opus vs Sonnet qualifier) — separate failure modes.
 * - Different prompt: a richer narrative profile + a ternary fit / borderline /
 *   unfit judgment, not a 0–100 score. The labeler is asked "would the
 *   candidate credibly land this job?", not "rank this for the qualifier".
 * - Persisted append-only. Re-running the bench is free unless we change
 *   the labeler version.
 *
 * Calibration: agreement with user labels is reported on every run. If it
 * drops below the threshold the labeler's prompt or model is wrong; do not
 * trust the rest of the metrics until that's resolved.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { JobRow } from '../schema.js';
import { PROFILE, type Profile } from './profile.js';

export type LabelerVerdict = 'fit' | 'borderline' | 'unfit';

export interface LabelerEntry {
  key: string;
  verdict: LabelerVerdict;
  rationale: string;
  labeler_id: string;
  labeled_at: string;
}

const LABELER_ID = 'opus-v1';

// Narrative profile — built from PROFILE data so it stays in sync with the
// operator's actual configuration without hardcoding identity strings.
function buildNarrative(p: Profile): string {
  const exclude = p.hard_constraints.find(c => c.type === 'exclude_pattern')?.value ?? '';
  const minYears = p.hard_constraints.find(c => c.type === 'min_years')?.value;
  const usOnly = p.hard_constraints.find(c => c.type === 'location_us_only')?.value === 'true';
  const visa = p.hard_constraints.find(c => c.type === 'visa')?.value;

  return `You are evaluating job postings on behalf of an early-career software engineer.

CANDIDATE BACKGROUND
- Education: ${p.degree}${p.graduation ? ` (graduating ${p.graduation})` : ''}.
- Effective experience: ~${p.experience_years} years.
- Citizenship / work auth: ${p.citizenship.join(', ')}${visa ? ` (${visa})` : ''}.
- Location preference: ${p.location_preference.join(', ')}.${usOnly ? ' US only.' : ''}
- Role targets: ${p.role_targets.join(', ')}.
- Excludes title patterns: ${exclude || '(none)'}.${minYears ? ` Reject postings requiring ${minYears}+ years.` : ''}

STACK
- Strong: ${p.skills.strong.join(', ')}.
- Working knowledge: ${p.skills.working.join(', ')}.
- Light exposure: ${p.skills.exposure.join(', ')}.

HIGHLIGHTS
${p.highlights.map(h => '- ' + h).join('\n')}

The candidate is stronger than a typical new grad if highlights show production work or specialized credentials, but is NOT mid-level. Roles asking for 3+ years are stretches; 4+ years is a rejection.`.trim();
}

const NARRATIVE_PROFILE = buildNarrative(PROFILE);

const SYSTEM = `You are an experienced engineering hiring manager evaluating job postings for the candidate described below. For each posting you receive, decide whether the candidate could credibly land this role and would actually want it given the stated preferences.

Use only THREE verdicts:

- "fit"        — Strong match. Level fits (entry-level / 1-2 yrs / 2+ yrs / new-grad-friendly), domain matches the role targets, stack overlaps materially. The candidate has a real shot at getting this and would likely apply.
- "borderline" — Close but with material caveats. Examples: requires 3-4 years (one stretch beyond the candidate's experience); domain is adjacent but not central; primary language is unfamiliar but learnable. Could be in a digest, not a push alert.
- "unfit"      — Wrong level (senior/staff/4+ years), wrong domain (highly specialized: hardware firmware, factory automation, kernels, quant trading, etc.) without candidate experience, primary language the candidate doesn't know, or a non-SWE role.

Output ONLY a valid JSON array, in input order. One object per job:
[
  { "job_id": 1, "verdict": "fit" | "borderline" | "unfit", "rationale": "1-2 sentences citing specific evidence" },
  ...
]

Hard rules (override stack/domain match):
- Postings explicitly requiring 4+ years, or titled senior / staff / principal / director / VP / head-of → "unfit".
- Non-US locations only → "unfit" (when the candidate is US-only).
- Security operations / vulnerability management / compliance admin → "unfit" — those are not software engineering roles even when "engineer" is in the title.

Be honest. The candidate needs accurate signal, not optimism.`;

function jobBlock(job: JobRow, idx: number): string {
  const raw = JSON.parse(job.raw_json || '{}');
  const desc = raw.descriptionHtml || raw.descriptionPlain || raw.description || raw.content || '';
  const clean = desc.replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
  const trunc = clean.length > 1500 ? clean.substring(0, 1500) + '...' : clean;
  return `### Job ${idx}
Title: ${job.title}
Location: ${job.location || 'Not specified'}
Department: ${job.department || 'Not specified'}
${trunc || '(No description available)'}`;
}

function parseLabelerOutput(raw: string, count: number): LabelerVerdict[] {
  // Strip markdown fences if present
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) return Array(count).fill('borderline');
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return Array(count).fill('borderline');
    return arr.map((x: any) => {
      const v = (x?.verdict || '').toLowerCase();
      if (v === 'fit' || v === 'borderline' || v === 'unfit') return v;
      return 'borderline';
    });
  } catch {
    return Array(count).fill('borderline');
  }
}

function parseLabelerOutputWithRationale(raw: string, count: number): { verdict: LabelerVerdict; rationale: string }[] {
  const cleaned = raw.replace(/```(?:json)?/g, '').trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  const fallback = () => Array(count).fill({ verdict: 'borderline' as const, rationale: 'parse error' });
  if (!m) return fallback();
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return fallback();
    return arr.map((x: any) => {
      const v = (x?.verdict || '').toLowerCase();
      const verdict: LabelerVerdict = (v === 'fit' || v === 'unfit') ? v : 'borderline';
      return { verdict, rationale: typeof x?.rationale === 'string' ? x.rationale.slice(0, 400) : '' };
    });
  } catch {
    return fallback();
  }
}

export class OpusLabeler {
  private model: string;
  private batchSize: number;

  constructor(model: string = 'opus', batchSize: number = 10) {
    this.model = model;
    this.batchSize = batchSize;
  }

  async labelBatch(jobs: (JobRow & { company_slug: string })[]): Promise<{ verdict: LabelerVerdict; rationale: string }[]> {
    const out: { verdict: LabelerVerdict; rationale: string }[] = new Array(jobs.length);
    for (let s = 0; s < jobs.length; s += this.batchSize) {
      const batch = jobs.slice(s, s + this.batchSize);
      const blocks = batch.map((j, i) => jobBlock(j, i + 1)).join('\n\n');
      const prompt = `${SYSTEM}\n\n## Candidate\n${NARRATIVE_PROFILE}\n\n## Job Postings (${batch.length} jobs)\n\n${blocks}`;

      try {
        const { stdout } = await execFileAsync('claude', [
          '-p', prompt,
          '--output-format', 'text',
          '--model', this.model,
        ], { encoding: 'utf-8', timeout: 600_000, maxBuffer: 10 * 1024 * 1024 });
        const parsed = parseLabelerOutputWithRationale(stdout, batch.length);
        for (let i = 0; i < batch.length; i++) out[s + i] = parsed[i];
      } catch (err: any) {
        for (let i = 0; i < batch.length; i++) out[s + i] = { verdict: 'borderline', rationale: `labeler error: ${err.message?.substring(0, 80)}` };
      }
    }
    return out;
  }
}

// Persistence
const LABELS_FILE = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'llm-labels.jsonl');

export function loadLabelerEntries(): Map<string, LabelerEntry> {
  if (!fs.existsSync(LABELS_FILE)) return new Map();
  const out = new Map<string, LabelerEntry>();
  const lines = fs.readFileSync(LABELS_FILE, 'utf-8').split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as LabelerEntry;
      if (e.labeler_id === LABELER_ID) out.set(e.key, e); // last entry wins
    } catch {}
  }
  return out;
}

export function appendLabelerEntries(entries: LabelerEntry[]): void {
  const dir = path.dirname(LABELS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const blob = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(LABELS_FILE, blob);
}

export const LABELER_VERSION = LABELER_ID;
export const LABELS_PATH = LABELS_FILE;
