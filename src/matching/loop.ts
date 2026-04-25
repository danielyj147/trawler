/**
 * Continuous matching loop. Runs alongside the polling scheduler so newly
 * ingested jobs get qualified without operator intervention.
 *
 * Tick logic:
 *   1. Read all pipeline-*.json results to find which (slug, title) pairs
 *      have been scored.
 *   2. Pull unscored jobs from the DB.
 *   3. If we have enough unscored jobs: BM25 + rerank to top-N, batch
 *      qualify with sonnet, write a new pipeline-{ts}.json. Done.
 *   4. If not enough unscored jobs left, sleep longer to give the polling
 *      scheduler time to discover new postings.
 *
 * The loop is single-threaded relative to itself — only one batch in flight.
 * It runs in the same process as the scheduler so a single `npm start` brings
 * the whole product online.
 */

import { Store } from '../store.js';
import { PROFILE } from './profile.js';
import { retrieveAndRerank } from './retriever.js';
import { ClaudeCliQualifier } from './qualifier.js';
import type { JobRow } from '../schema.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const RESULTS_DIR = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');

export interface MatchingLoopConfig {
  intervalMs?: number;       // base sleep between ticks. Default 5 min.
  idleIntervalMs?: number;   // longer sleep when nothing to do. Default 15 min.
  topK?: number;             // BM25 candidates per tick. Default 500.
  topN?: number;             // LLM-qualified jobs per tick. Default 30.
  batchSize?: number;        // qualifier batch size. Default 20.
  model?: string;            // qualifier model. Default 'sonnet'.
  minNewJobs?: number;       // skip the LLM stage if fewer unscored than this. Default 50.
}

export class MatchingLoop {
  private store: Store;
  private cfg: Required<MatchingLoopConfig>;
  private running = false;

  // Counters for observability
  ticks = 0;
  jobsQualified = 0;
  pushFound = 0;
  digestFound = 0;
  lastTickAt: number = 0;
  lastTickStatus: string = 'idle';

  constructor(store: Store, cfg: MatchingLoopConfig = {}) {
    this.store = store;
    this.cfg = {
      intervalMs: cfg.intervalMs ?? 5 * 60 * 1000,
      idleIntervalMs: cfg.idleIntervalMs ?? 15 * 60 * 1000,
      topK: cfg.topK ?? 500,
      topN: cfg.topN ?? 30,
      batchSize: cfg.batchSize ?? 20,
      model: cfg.model ?? 'sonnet',
      minNewJobs: cfg.minNewJobs ?? 50,
    };
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      const sleepMs = await this.tick();
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }

  stop(): void {
    this.running = false;
  }

  /** Returns how long to sleep before the next tick. */
  async tick(): Promise<number> {
    this.ticks++;
    this.lastTickAt = Date.now();

    try {
      const scored = this.loadScoredKeys();
      const all = this.store.db.prepare(`
        SELECT j.*, c.slug as company_slug, c.name as company_name, c.ats_type
        FROM jobs j JOIN companies c ON c.id = j.company_id
      `).all() as (JobRow & { company_slug: string; company_name: string; ats_type: string })[];

      const unscored = all.filter(j => !scored.has(j.company_slug + '/' + j.title));
      if (unscored.length < this.cfg.minNewJobs) {
        this.lastTickStatus = `idle: only ${unscored.length} unscored jobs (< ${this.cfg.minNewJobs}); waiting for poller`;
        console.log(`[matching-loop] ${this.lastTickStatus}`);
        return this.cfg.idleIntervalMs;
      }

      const candidates = retrieveAndRerank(PROFILE, unscored, this.cfg.topK, this.cfg.topN);
      if (candidates.length === 0) {
        this.lastTickStatus = `idle: BM25 found no candidates among ${unscored.length} unscored`;
        console.log(`[matching-loop] ${this.lastTickStatus}`);
        return this.cfg.idleIntervalMs;
      }

      console.log(`[matching-loop] qualifying ${candidates.length} new candidates from ${unscored.length} unscored jobs`);

      const qualifier = new ClaudeCliQualifier(this.cfg.model, this.cfg.batchSize);
      const candidateJobs = candidates.map(c => c.job);
      const t0 = Date.now();
      const results = await qualifier.qualifyBatch(PROFILE, candidateJobs);
      const elapsedS = ((Date.now() - t0) / 1000).toFixed(0);

      const shaped = results.map((r, i) => ({
        ...r,
        company_slug: (candidates[i].job as any).company_slug,
        title: candidates[i].job.title,
        url: candidates[i].job.url,
        location: candidates[i].job.location,
        features: candidates[i].features,
      }));

      if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
      const outFile = path.join(RESULTS_DIR, `pipeline-${Date.now()}.json`);
      fs.writeFileSync(outFile, JSON.stringify(shaped, null, 2));

      const push = results.filter(r => r.score >= 70).length;
      const digest = results.filter(r => r.score >= 40 && r.score < 70).length;
      this.jobsQualified += results.length;
      this.pushFound += push;
      this.digestFound += digest;
      this.lastTickStatus = `qualified ${results.length} in ${elapsedS}s — ${push} push, ${digest} digest`;
      console.log(`[matching-loop] ${this.lastTickStatus} -> ${path.basename(outFile)}`);

      return this.cfg.intervalMs;
    } catch (err: any) {
      this.lastTickStatus = `error: ${err.message?.substring(0, 120)}`;
      console.error(`[matching-loop] ${this.lastTickStatus}`);
      return this.cfg.intervalMs;
    }
  }

  private loadScoredKeys(): Set<string> {
    const seen = new Set<string>();
    if (!fs.existsSync(RESULTS_DIR)) return seen;
    for (const f of fs.readdirSync(RESULTS_DIR).filter(x => x.startsWith('pipeline-'))) {
      try {
        const arr = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf-8')) as any[];
        for (const r of arr) if (r.company_slug && r.title) seen.add(r.company_slug + '/' + r.title);
      } catch {}
    }
    return seen;
  }
}
