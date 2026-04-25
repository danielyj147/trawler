import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { greenhouse } from './adapters/greenhouse.js';
import { lever } from './adapters/lever.js';
import { ashby } from './adapters/ashby.js';
import { workable } from './adapters/workable.js';
import { startDashboard } from './dashboard.js';
import { MatchingLoop } from './matching/loop.js';
import { startMatchingDashboard } from './matching/serve.js';
import type { AtsConfig } from './scheduler.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ADAPTERS = [greenhouse, lever, ashby, workable];

// Load calibrated ATS configs if available
function loadAtsConfigs(): Record<string, AtsConfig> | undefined {
  const historyPath = path.join(import.meta.dirname, '..', 'calibration', 'history.jsonl');
  if (!fs.existsSync(historyPath)) return undefined;

  const lines = fs.readFileSync(historyPath, 'utf-8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return undefined;

  // Use latest calibration for each ATS
  const configs: Record<string, AtsConfig> = {};
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.ats_type && entry.recommended_concurrent && entry.recommended_interval_ms) {
        configs[entry.ats_type] = {
          ceiling_concurrent: entry.recommended_concurrent,
          ceiling_interval_ms: entry.recommended_interval_ms,
        };
      }
    } catch { /* skip malformed entries */ }
  }

  return Object.keys(configs).length > 0 ? configs : undefined;
}

async function main() {
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  const dashboardPort = parseInt(process.env.TRAWLER_PORT || '3000', 10);
  const matchingPort = parseInt(process.env.TRAWLER_MATCHING_PORT || '3002', 10);
  const enableMatching = process.env.TRAWLER_NO_MATCHING !== '1';
  const bindHost = process.env.TRAWLER_BIND || '0.0.0.0'; // listen on all interfaces for mesh access

  console.log('Trawler starting...');
  console.log(`  Database: ${dbPath}`);
  console.log(`  Health dashboard: http://${bindHost}:${dashboardPort}`);
  if (enableMatching) console.log(`  Matching dashboard: http://${bindHost}:${matchingPort}`);

  const store = new Store(dbPath);

  // Load calibrated configs
  const atsConfigs = loadAtsConfigs();
  if (atsConfigs) {
    console.log('  ATS configs: loaded from calibration history');
    for (const [ats, cfg] of Object.entries(atsConfigs)) {
      console.log(`    ${ats}: concurrent=${cfg.ceiling_concurrent}, interval=${cfg.ceiling_interval_ms}ms`);
    }
  } else {
    console.log('  ATS configs: using conservative defaults (run calibrate to tune)');
  }

  const scheduler = new Scheduler(store, ADAPTERS, {
    ats_configs: atsConfigs,
  });

  // Start health dashboard (port 3000)
  startDashboard({
    port: dashboardPort,
    host: bindHost,
    store,
    getAtsStates: () => {
      const states = new Map();
      for (const adapter of ADAPTERS) {
        const state = scheduler.getAtsState(adapter.ats_type);
        if (state) states.set(adapter.ats_type, state);
      }
      return states;
    },
    getSchedulerStats: () => ({
      inFlight: scheduler.inFlight,
      pollsCompleted: scheduler.pollsCompleted,
      pollsFailed: scheduler.pollsFailed,
    }),
  });

  // Start continuous matching loop + matching dashboard (port 3002)
  let matchingLoop: MatchingLoop | undefined;
  if (enableMatching) {
    // Loop knobs via env so we can tune without redeploys
    matchingLoop = new MatchingLoop(store, {
      intervalMs: process.env.TRAWLER_MATCH_INTERVAL_MS ? parseInt(process.env.TRAWLER_MATCH_INTERVAL_MS, 10) : undefined,
      idleIntervalMs: process.env.TRAWLER_MATCH_IDLE_MS ? parseInt(process.env.TRAWLER_MATCH_IDLE_MS, 10) : undefined,
      topK: process.env.TRAWLER_MATCH_TOPK ? parseInt(process.env.TRAWLER_MATCH_TOPK, 10) : undefined,
      topN: process.env.TRAWLER_MATCH_TOPN ? parseInt(process.env.TRAWLER_MATCH_TOPN, 10) : undefined,
      batchSize: process.env.TRAWLER_MATCH_BATCH ? parseInt(process.env.TRAWLER_MATCH_BATCH, 10) : undefined,
      model: process.env.TRAWLER_MATCH_MODEL,
      minNewJobs: process.env.TRAWLER_MATCH_MIN_NEW ? parseInt(process.env.TRAWLER_MATCH_MIN_NEW, 10) : undefined,
    });
    startMatchingDashboard({ port: matchingPort, host: bindHost, loop: matchingLoop });
  }

  // Handle shutdown
  const shutdown = () => {
    console.log('\nShutting down...');
    scheduler.stop();
    matchingLoop?.stop();
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Report initial state
  const companies = store.getCompanyCount();
  const active = store.getActiveCompanyCount();
  const jobs = store.getJobCount();
  console.log(`  Universe: ${companies} companies (${active} active), ${jobs} jobs`);

  if (active === 0) {
    console.log('');
    console.log('  No active companies in universe. Run discovery first:');
    console.log('    npx tsx src/discover.ts');
    console.log('');
  }

  // Defer the matching loop a few seconds so the polling scheduler has time to
  // ingest a fresh batch of jobs before we waste an LLM tick on stale data.
  if (matchingLoop) {
    console.log('  Matching loop starting (continuous qualification of new jobs)...');
    setTimeout(() => {
      matchingLoop!.start().catch(err => console.error('[matching-loop] fatal:', err));
    }, 30_000);
  }

  // Start polling — this blocks the main task forever
  console.log('  Scheduler starting...');
  await scheduler.start();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
