/**
 * Shakedown: run the scheduler against ~200 real companies for an extended period.
 *
 * Produces a structured report with per-ATS breakdown, anomalies, and AIMD state.
 *
 * Usage: npx tsx src/shakedown.ts [--companies 200] [--duration-hours 24]
 *
 * The shakedown writes to a separate DB (shakedown.db) so it doesn't pollute
 * the main trawler.db. Companies are copied from trawler.db.
 */

import { Store } from './store.js';
import { Scheduler } from './scheduler.js';
import { greenhouse } from './adapters/greenhouse.js';
import { lever } from './adapters/lever.js';
import { ashby } from './adapters/ashby.js';
import { workable } from './adapters/workable.js';
import { startDashboard } from './dashboard.js';
import type { AtsConfig } from './scheduler.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ADAPTERS = [greenhouse, lever, ashby, workable];

// Calibration-informed + operator-overridden settings
const ATS_CONFIGS: Record<string, AtsConfig> = {
  greenhouse: { ceiling_concurrent: 3, ceiling_interval_ms: 100 },
  lever:      { ceiling_concurrent: 2, ceiling_interval_ms: 500 },
  ashby:      { ceiling_concurrent: 1, ceiling_interval_ms: 3000 },
  workable:   { ceiling_concurrent: 1, ceiling_interval_ms: 1000 },
};

function parseArgs() {
  const args = process.argv.slice(2);
  let companies = 200;
  let durationHours = 24;
  let pollIntervalMin = 15;
  let reportIntervalMin = 30;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--companies' && args[i + 1]) companies = parseInt(args[++i], 10);
    if (args[i] === '--duration-hours' && args[i + 1]) durationHours = parseFloat(args[++i]);
    if (args[i] === '--poll-interval' && args[i + 1]) pollIntervalMin = parseInt(args[++i], 10);
    if (args[i] === '--report-interval' && args[i + 1]) reportIntervalMin = parseInt(args[++i], 10);
  }

  return { companies, durationHours, pollIntervalMin, reportIntervalMin };
}

function seedCompanies(sourceDb: Store, targetDb: Store, count: number, pollIntervalMs: number): number {
  // Copy companies from source (trawler.db) to target (shakedown.db), balanced by ATS
  const atsCounts: Record<string, number> = {};
  const atsTargets: Record<string, number> = {};

  // Get distribution from source
  for (const ats of ['greenhouse', 'lever', 'ashby']) {
    atsCounts[ats] = sourceDb.getCompanyCountByAts(ats);
  }

  const total = Object.values(atsCounts).reduce((a, b) => a + b, 0);
  let remaining = count;

  // Proportional allocation, minimum 5 per ATS
  for (const [ats, c] of Object.entries(atsCounts)) {
    const target = Math.max(5, Math.round((c / total) * count));
    atsTargets[ats] = Math.min(target, c, remaining);
    remaining -= atsTargets[ats];
  }

  let seeded = 0;
  for (const [ats, target] of Object.entries(atsTargets)) {
    const companies = sourceDb.db.prepare(
      'SELECT * FROM companies WHERE ats_type = ? ORDER BY RANDOM() LIMIT ?'
    ).all(ats, target) as any[];

    for (const c of companies) {
      targetDb.discoverCompany(
        { name: c.name, slug: c.slug, ats_type: c.ats_type, ats_url: c.ats_url },
        { source_type: 'shakedown', source_detail: `seeded from ${ats}` },
      );
      // Set poll interval
      targetDb.db.prepare('UPDATE companies SET poll_interval_ms = ? WHERE slug = ? AND ats_type = ?')
        .run(pollIntervalMs, c.slug, c.ats_type);
      seeded++;
    }
  }

  return seeded;
}

function generateReport(store: Store, startTime: number, scheduler: Scheduler): string {
  const elapsed = (Date.now() - startTime) / 1000;
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);

  const L: string[] = [];
  const RULE = '='.repeat(70);

  L.push('');
  L.push(RULE);
  L.push(`SHAKEDOWN REPORT -- ${new Date().toISOString()}`);
  L.push(RULE);
  L.push('');
  L.push(`  Duration:         ${hours}h ${mins}m`);
  L.push(`  Companies:        ${store.getCompanyCount()} (${store.getActiveCompanyCount()} active, ${store.getCompanyCount() - store.getActiveCompanyCount()} disabled)`);

  const totalPolls = (store.db.prepare('SELECT COUNT(*) as c FROM poll_attempts').get() as any).c;
  const successPolls = (store.db.prepare("SELECT COUNT(*) as c FROM poll_attempts WHERE status = 'success'").get() as any).c;
  const failedPolls = totalPolls - successPolls;
  const totalJobs = store.getJobCount();

  L.push(`  Total polls:      ${totalPolls} (${successPolls} ok, ${failedPolls} failed)`);
  L.push(`  Jobs discovered:  ${totalJobs}`);
  L.push(`  Scheduler:        ${scheduler.pollsCompleted} completed, ${scheduler.pollsFailed} failed, ${scheduler.inFlight} in-flight`);
  L.push('');

  // Per-ATS breakdown
  L.push('  PER-ATS BREAKDOWN');
  L.push('  ' + '-'.repeat(65));

  const atsTypes = ['greenhouse', 'lever', 'ashby', 'workable'];
  L.push('  ' + ['ATS', 'Companies', 'Polls OK', 'Polls Fail', 'Jobs', 'p50 lat', 'p95 lat', 'posted_at%'].map(h => h.padEnd(10)).join(''));

  for (const ats of atsTypes) {
    const companies = store.getCompanyCountByAts(ats);
    if (companies === 0) continue;

    const polls = store.db.prepare(`
      SELECT
        COUNT(CASE WHEN pa.status = 'success' THEN 1 END) as ok,
        COUNT(CASE WHEN pa.status != 'success' THEN 1 END) as fail
      FROM poll_attempts pa
      JOIN companies c ON c.id = pa.company_id
      WHERE c.ats_type = ?
    `).get(ats) as any;

    const latencies = store.db.prepare(`
      SELECT latency_ms FROM poll_attempts pa
      JOIN companies c ON c.id = pa.company_id
      WHERE c.ats_type = ? AND pa.status = 'success'
      ORDER BY latency_ms
    `).all(ats) as { latency_ms: number }[];

    const p50 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.5)]?.latency_ms ?? 0 : 0;
    const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)]?.latency_ms ?? 0 : 0;

    const jobsForAts = (store.db.prepare(`
      SELECT COUNT(*) as c FROM jobs j JOIN companies c ON c.id = j.company_id WHERE c.ats_type = ?
    `).get(ats) as any).c;

    const postedAt = store.db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(j.ats_posted_at) as with_posted
      FROM jobs j JOIN companies c ON c.id = j.company_id
      WHERE c.ats_type = ?
    `).get(ats) as any;

    const postedPct = postedAt.total > 0 ? Math.round((postedAt.with_posted / postedAt.total) * 100) : 0;

    L.push('  ' + [
      ats, companies, polls?.ok ?? 0, polls?.fail ?? 0,
      jobsForAts, p50 + 'ms', p95 + 'ms', postedPct + '%',
    ].map(v => String(v).padEnd(10)).join(''));
  }
  L.push('');

  // AIMD state
  L.push('  AIMD STATE');
  L.push('  ' + '-'.repeat(65));
  L.push('  ' + ['ATS', 'Curr Conc', 'Ceiling', 'Curr IntMs', 'Ceil IntMs', 'Clean Win'].map(h => h.padEnd(12)).join(''));
  for (const adapter of ADAPTERS) {
    const state = scheduler.getAtsState(adapter.ats_type);
    if (!state) continue;
    L.push('  ' + [
      adapter.ats_type,
      state.current_concurrent,
      state.config.ceiling_concurrent,
      state.current_interval_ms,
      state.config.ceiling_interval_ms,
      state.clean_window,
    ].map(v => String(v).padEnd(12)).join(''));
  }
  L.push('');

  // WHAT WENT WRONG
  L.push('  WHAT WENT WRONG');
  L.push('  ' + '-'.repeat(65));

  // Failed polls
  const failures = store.db.prepare(`
    SELECT pa.attempted_at, c.name, c.slug, c.ats_type, pa.status, pa.status_code, pa.error_message, pa.latency_ms
    FROM poll_attempts pa
    JOIN companies c ON c.id = pa.company_id
    WHERE pa.status != 'success'
    ORDER BY pa.attempted_at DESC
    LIMIT 50
  `).all() as any[];

  if (failures.length === 0) {
    L.push('  No failures recorded (this is suspicious if the run is >1h — check instrumentation)');
  } else {
    const errorTypes: Record<string, number> = {};
    for (const f of failures) {
      const key = `${f.ats_type}:${f.status}:${f.status_code || 'null'}`;
      errorTypes[key] = (errorTypes[key] || 0) + 1;
    }

    L.push('  Error summary:');
    for (const [key, count] of Object.entries(errorTypes).sort((a, b) => b[1] - a[1])) {
      L.push(`    ${key.padEnd(35)} ${count}x`);
    }
    L.push('');

    L.push('  Recent failures (last 20):');
    for (const f of failures.slice(0, 20)) {
      const msg = f.error_message ? f.error_message.substring(0, 60) : '';
      L.push(`    ${f.attempted_at}  ${f.ats_type.padEnd(12)} ${f.slug.padEnd(25)} ${f.status} ${f.status_code || ''} ${msg}`);
    }
  }
  L.push('');

  // Disabled companies
  const disabled = store.db.prepare(`
    SELECT name, slug, ats_type, consecutive_failures, disabled_at
    FROM companies WHERE active = 0
    ORDER BY disabled_at DESC
  `).all() as any[];

  if (disabled.length > 0) {
    L.push('  DISABLED COMPANIES');
    L.push('  ' + '-'.repeat(65));
    for (const c of disabled) {
      L.push(`    ${c.ats_type.padEnd(12)} ${c.slug.padEnd(25)} failures=${c.consecutive_failures}  disabled=${c.disabled_at}`);
    }
    L.push('');
  }

  // Anomalies
  L.push('  ANOMALIES');
  L.push('  ' + '-'.repeat(65));

  // Companies with 0 jobs after successful poll
  const emptyBoards = store.db.prepare(`
    SELECT c.slug, c.ats_type FROM companies c
    WHERE EXISTS (SELECT 1 FROM poll_attempts pa WHERE pa.company_id = c.id AND pa.status = 'success' AND pa.jobs_found = 0)
  `).all() as any[];
  if (emptyBoards.length > 0) {
    L.push(`  ${emptyBoards.length} companies returned 0 jobs after successful poll:`);
    for (const c of emptyBoards.slice(0, 10)) {
      L.push(`    ${c.ats_type.padEnd(12)} ${c.slug}`);
    }
    if (emptyBoards.length > 10) L.push(`    ... and ${emptyBoards.length - 10} more`);
    L.push('');
  }

  // Jobs missing ats_posted_at
  const missingPosted = store.db.prepare(`
    SELECT c.ats_type, COUNT(*) as c
    FROM jobs j JOIN companies c ON c.id = j.company_id
    WHERE j.ats_posted_at IS NULL
    GROUP BY c.ats_type
  `).all() as any[];
  if (missingPosted.length > 0) {
    L.push('  Jobs missing ats_posted_at:');
    for (const m of missingPosted) {
      L.push(`    ${m.ats_type.padEnd(12)} ${m.c} jobs`);
    }
    L.push('');
  }

  L.push(RULE);
  return L.join('\n');
}

async function main() {
  const { companies, durationHours, pollIntervalMin, reportIntervalMin } = parseArgs();
  const pollIntervalMs = pollIntervalMin * 60 * 1000;
  const durationMs = durationHours * 3600 * 1000;
  const reportIntervalMs = reportIntervalMin * 60 * 1000;
  const dbPath = 'shakedown.db';

  console.log('TRAWLER SHAKEDOWN');
  console.log('='.repeat(60));
  console.log(`  Target companies: ${companies}`);
  console.log(`  Duration: ${durationHours}h`);
  console.log(`  Poll interval: ${pollIntervalMin}min`);
  console.log(`  Report interval: ${reportIntervalMin}min`);
  console.log(`  DB: ${dbPath}`);
  console.log('');

  // Clean start
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  for (const ext of ['-wal', '-shm']) {
    const p = dbPath + ext;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const sourceDb = new Store(process.env.TRAWLER_DB || 'trawler.db');
  const store = new Store(dbPath);
  const seeded = seedCompanies(sourceDb, store, companies, pollIntervalMs);
  sourceDb.close();

  console.log(`  Seeded ${seeded} companies from universe`);
  const byAts = ['greenhouse', 'lever', 'ashby', 'workable'].map(ats =>
    `${ats}=${store.getCompanyCountByAts(ats)}`
  ).join(', ');
  console.log(`  Distribution: ${byAts}`);
  console.log('');

  const scheduler = new Scheduler(store, ADAPTERS, {
    ats_configs: ATS_CONFIGS,
    max_consecutive_failures: 5,
    request_timeout_ms: 30_000, // 30s for Lever
    recovery_sweep_interval_ms: 600_000,
  });

  // Start dashboard
  startDashboard({
    port: 3001,
    store,
    getAtsStates: () => {
      const states = new Map();
      for (const a of ADAPTERS) {
        const s = scheduler.getAtsState(a.ats_type);
        if (s) states.set(a.ats_type, s);
      }
      return states;
    },
    getSchedulerStats: () => ({
      inFlight: scheduler.inFlight,
      pollsCompleted: scheduler.pollsCompleted,
      pollsFailed: scheduler.pollsFailed,
    }),
  });

  const startTime = Date.now();
  const endTime = startTime + durationMs;
  const reportPath = path.join(import.meta.dirname, '..', 'shakedown-report.txt');

  // Periodic report generation
  const reportTimer = setInterval(() => {
    const report = generateReport(store, startTime, scheduler);
    fs.writeFileSync(reportPath, report);
    console.log(`\n--- Report updated: ${reportPath} ---`);
    console.log(`    Polls: ${scheduler.pollsCompleted} ok / ${scheduler.pollsFailed} failed / ${scheduler.inFlight} in-flight`);
    console.log(`    Jobs: ${store.getJobCount()}`);
    console.log(`    Active: ${store.getActiveCompanyCount()} / ${store.getCompanyCount()}`);
  }, reportIntervalMs);

  // Shutdown handler
  const shutdown = () => {
    console.log('\nShutting down...');
    scheduler.stop();
    clearInterval(reportTimer);
    const finalReport = generateReport(store, startTime, scheduler);
    fs.writeFileSync(reportPath, finalReport);
    console.log(finalReport);
    console.log(`\nFinal report written to: ${reportPath}`);
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Auto-stop after duration
  setTimeout(() => {
    console.log(`\nDuration (${durationHours}h) elapsed. Generating final report...`);
    shutdown();
  }, durationMs);

  console.log(`  Scheduler starting. Dashboard at http://localhost:3001`);
  console.log(`  Reports will be written to ${reportPath} every ${reportIntervalMin}min`);
  console.log(`  Will auto-stop after ${durationHours}h. Ctrl+C for early stop + report.`);
  console.log('');

  await scheduler.start();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
