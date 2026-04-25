import { Store } from '../../src/store.js';
import { greenhouse } from '../../src/adapters/greenhouse.js';
import { calibrate } from '../../src/calibrator.js';
import type { CalibrationResult } from '../../src/calibrator.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

const HISTORY = path.join(import.meta.dirname, 'history.jsonl');
const EMPTY_GH = JSON.stringify({ jobs: [], meta: { total: 0 } });

// -- Simulated ATSes --

function startServer(handler: (req: any, res: any) => void): Promise<{ server: Server; port: number }> {
  return new Promise(resolve => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

/** Simulated ATS with ONLY a concurrency limit. No rate limit. */
function concurrencyOnlyHandler(maxConcurrent: number, responseMs: number) {
  let inFlight = 0;
  return (req: any, res: any) => {
    if (inFlight >= maxConcurrent) {
      res.writeHead(429, { 'Retry-After': '1' });
      res.end('Too many concurrent');
      return;
    }
    inFlight++;
    setTimeout(() => {
      inFlight--;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(EMPTY_GH);
    }, responseMs);
  };
}

/** Simulated ATS with ONLY a rate limit (sliding window). No concurrency limit. */
function rateOnlyHandler(maxPerSecond: number) {
  const timestamps: number[] = [];
  return (req: any, res: any) => {
    const now = Date.now();
    // Clean window
    while (timestamps.length > 0 && timestamps[0] < now - 1000) timestamps.shift();
    if (timestamps.length >= maxPerSecond) {
      res.writeHead(429, { 'Retry-After': '1', 'X-RateLimit-Remaining': '0' });
      res.end('Rate limited');
      return;
    }
    timestamps.push(now);
    // Fast response -- rate limit is the only constraint
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(EMPTY_GH);
  };
}

// -- Test helpers --

function makeSimAdapter(port: number) {
  return {
    ...greenhouse,
    buildUrl(slug: string): string {
      return `http://127.0.0.1:${port}/${slug}`;
    },
  };
}

function makeStore(port: number, n: number = 20): Store {
  const store = new Store(':memory:');
  for (let i = 0; i < n; i++) {
    store.discoverCompany(
      { name: `sim-${i}`, slug: `sim-${i}`, ats_type: 'greenhouse', ats_url: `http://127.0.0.1:${port}/sim-${i}` },
      { source_type: 'bench', source_detail: 'calibration-bench' },
    );
  }
  return store;
}

interface BenchResult {
  test: string;
  known: number;
  found: number;
  within_tolerance: boolean;
  time_s: number;
}

// -- Tests --

async function testConcurrencyLimit(knownMax: number, tolerance: number = 0.5): Promise<BenchResult> {
  // Response time 500ms so requests overlap at moderate intervals
  const { server, port } = await startServer(concurrencyOnlyHandler(knownMax, 500));
  const store = makeStore(port);
  const adapter = makeSimAdapter(port);

  const t0 = performance.now();
  let result: CalibrationResult;
  try {
    result = await calibrate(store, adapter, {
      max_probe_concurrent: knownMax + 5,
      intervals_to_probe: [200, 100, 50, 25],
      rung_duration_s: 3,
      baseline_requests: 3,
      sample_size: 20,
      request_timeout_ms: 5000,
    });
  } finally {
    server.close();
    store.close();
  }

  const diff = Math.abs(result.recommended_concurrent - knownMax) / knownMax;
  return {
    test: 'concurrency_limit',
    known: knownMax,
    found: result.recommended_concurrent,
    within_tolerance: diff <= tolerance,
    time_s: (performance.now() - t0) / 1000,
  };
}

async function testRateLimit(knownMaxPerSec: number, tolerance: number = 0.5): Promise<BenchResult> {
  const { server, port } = await startServer(rateOnlyHandler(knownMaxPerSec));
  const store = makeStore(port);
  const adapter = makeSimAdapter(port);

  // Known interval = 1000/maxPerSec
  const knownInterval = Math.round(1000 / knownMaxPerSec);

  const t0 = performance.now();
  let result: CalibrationResult;
  try {
    result = await calibrate(store, adapter, {
      max_probe_concurrent: 5,
      intervals_to_probe: [500, 250, 100, 50, 25, 10],
      rung_duration_s: 3,
      baseline_requests: 3,
      sample_size: 20,
      request_timeout_ms: 5000,
    });
  } finally {
    server.close();
    store.close();
  }

  // The recommended_interval_ms should be >= knownInterval
  const diff = result.recommended_interval_ms < knownInterval
    ? (knownInterval - result.recommended_interval_ms) / knownInterval
    : 0; // found a more conservative interval, which is fine

  return {
    test: 'rate_limit',
    known: knownInterval,
    found: result.recommended_interval_ms,
    within_tolerance: diff <= tolerance,
    time_s: (performance.now() - t0) / 1000,
  };
}

// -- Formatting --

function format(results: BenchResult[]): string {
  const L: string[] = [];
  const RULE = '='.repeat(56);
  L.push('');
  L.push(RULE);
  L.push(`  CALIBRATION BENCHMARK -- ${new Date().toISOString()}`);
  L.push(RULE);
  L.push('');
  for (const r of results) {
    const status = r.within_tolerance ? 'ok' : 'FAIL';
    L.push(`  ${r.test.padEnd(24)} known=${String(r.known).padEnd(6)} found=${String(r.found).padEnd(6)} ${status}  (${r.time_s.toFixed(1)}s)`);
  }
  L.push('');
  L.push(RULE);
  return L.join('\n');
}

function getCommit(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return 'no-commit'; }
}

function appendHistory(results: BenchResult[], note: string): void {
  const entry = { timestamp: new Date().toISOString(), commit: getCommit(), benchmark: 'calibration', results, note };
  fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n');
}

// -- Main --
async function main() {
  const note = process.argv.slice(2).join(' ') || 'no note';

  console.log('Calibration benchmark: testing against simulated ATSes with known limits');
  console.log('');

  const results: BenchResult[] = [];

  console.log('Test 1: Concurrency limit = 3 (no rate limit)');
  results.push(await testConcurrencyLimit(3));

  console.log('');
  console.log('Test 2: Rate limit = 10 req/sec (no concurrency limit)');
  results.push(await testRateLimit(10));

  console.log(format(results));
  appendHistory(results, note);
  console.log(`  History -> ${path.relative(process.cwd(), HISTORY)}`);
}

main().catch(err => { console.error(err); process.exit(1); });
