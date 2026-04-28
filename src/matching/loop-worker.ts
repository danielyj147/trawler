/**
 * Standalone child-process entry for the matching loop.
 *
 * Why a separate process: better-sqlite3 is fully synchronous. A 170K-row
 * iterate held the JS event loop for several seconds even with chunked
 * yields, dropping HTTP connections on the dashboard's accept queue.
 * Running the loop in its own OS process means the main process's HTTP
 * servers and polling scheduler never share an event loop with it.
 *
 * Communication: zero IPC. Pipeline-*.json on disk is the data channel
 * the dashboard already reads. Counters are written to loop-state.json
 * periodically so the dashboard can show ticks, push/digest counts,
 * last-tick status. Both directions are file-based, so a worker crash
 * doesn't hang the main process.
 *
 * Config is passed via TRAWLER_LOOP_CONFIG (JSON in the env).
 *
 * Usage: `npx tsx src/matching/loop-worker.ts`
 */

import { Store } from '../store.js';
import { MatchingLoop, type MatchingLoopConfig } from './loop.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const STATE_FILE = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'loop-state.json');

function readConfig(): MatchingLoopConfig {
  if (!process.env.TRAWLER_LOOP_CONFIG) return {};
  try { return JSON.parse(process.env.TRAWLER_LOOP_CONFIG); } catch { return {}; }
}

const dbPath = process.env.TRAWLER_DB || 'trawler.db';
const store = new Store(dbPath);
const loop = new MatchingLoop(store, readConfig());

function writeState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      ticks: loop.ticks,
      jobsQualified: loop.jobsQualified,
      pushFound: loop.pushFound,
      digestFound: loop.digestFound,
      lastTickAt: loop.lastTickAt,
      lastTickStatus: loop.lastTickStatus,
      pid: process.pid,
      updated_at: Date.now(),
    }, null, 2));
  } catch {}
}

setInterval(writeState, 5_000);
writeState();

const shutdown = () => { loop.stop(); writeState(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

loop.start().catch(err => {
  console.error('[matching-loop-worker] fatal:', err);
  process.exit(1);
});
