import type { Store } from './store.js';
import type { Adapter } from './adapters/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { networkInterfaces } from 'node:os';

export interface CalibrationResult {
  ats_type: string;
  source_ip: string;
  sample_size: number;
  baseline_p95_ms: number;
  recommended_concurrent: number;
  recommended_interval_ms: number;
  evidence: {
    concurrency_ramp: ConcurrencyRung[];
    interval_ramp: IntervalRung[];
  };
}

interface ConcurrencyRung {
  concurrent: number;
  duration_s: number;
  requests: number;
  p95_ms: number;
  errors_429: number;
  errors_5xx: number;
  errors_conn: number;
  rate_limit_headers: boolean;
  signal: boolean;
}

interface IntervalRung {
  interval_ms: number;
  concurrent: number;
  duration_s: number;
  requests: number;
  p95_ms: number;
  errors_429: number;
  errors_5xx: number;
  errors_conn: number;
  rate_limit_headers: boolean;
  signal: boolean;
}

export interface CalibratorConfig {
  max_probe_concurrent?: number;
  intervals_to_probe?: number[];
  rung_duration_s?: number;
  baseline_requests?: number;
  sample_size?: number;
  request_timeout_ms?: number;
  fetcher?: (url: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_CONFIG: Required<CalibratorConfig> = {
  max_probe_concurrent: 20,
  intervals_to_probe: [1000, 500, 250, 100, 50],
  rung_duration_s: 120, // 2 minutes per rung
  baseline_requests: 20,
  sample_size: 20,
  request_timeout_ms: 15000,
  fetcher: globalThis.fetch,
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function getSourceIp(): string {
  const ifaces = networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'unknown';
}

function hasSignal(
  p95: number,
  baselineP95: number,
  errors429: number,
  errors5xx: number,
  errorsConn: number,
  rateLimitHeaders: boolean,
): boolean {
  return (
    errors429 > 0 ||
    errors5xx > 2 ||
    errorsConn > 0 ||
    rateLimitHeaders ||
    p95 > baselineP95 * 2
  );
}

// Single request, returns latency_ms and signal info
async function probe(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<{ latency_ms: number; status: number; is429: boolean; is5xx: boolean; connError: boolean; rateLimitHeader: boolean }> {
  const start = performance.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetcher(url, { signal: controller.signal });
    clearTimeout(timer);
    const latency_ms = performance.now() - start;

    const retryAfter = res.headers.get('Retry-After');
    const rlRemaining = res.headers.get('X-RateLimit-Remaining');

    return {
      latency_ms,
      status: res.status,
      is429: res.status === 429,
      is5xx: res.status >= 500,
      connError: false,
      rateLimitHeader: retryAfter != null || rlRemaining === '0',
    };
  } catch (err: any) {
    return {
      latency_ms: performance.now() - start,
      status: 0,
      is429: false,
      is5xx: false,
      connError: true,
      rateLimitHeader: false,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Sustain `concurrent` requests at `intervalMs` spacing against `urls` for `durationS` seconds.
 * Returns aggregated stats.
 */
async function sustain(
  urls: string[],
  concurrent: number,
  intervalMs: number,
  durationS: number,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<{ latencies: number[]; errors429: number; errors5xx: number; errorsConn: number; rateLimitHeaders: boolean }> {
  const latencies: number[] = [];
  let errors429 = 0;
  let errors5xx = 0;
  let errorsConn = 0;
  let rateLimitHeaders = false;

  const endTime = Date.now() + durationS * 1000;
  let inFlight = 0;
  let urlIndex = 0;

  const doRequest = async () => {
    const url = urls[urlIndex % urls.length];
    urlIndex++;
    inFlight++;
    try {
      const r = await probe(url, timeoutMs, fetcher);
      latencies.push(r.latency_ms);
      if (r.is429) errors429++;
      if (r.is5xx) errors5xx++;
      if (r.connError) errorsConn++;
      if (r.rateLimitHeader) rateLimitHeaders = true;
    } finally {
      inFlight--;
    }
  };

  while (Date.now() < endTime) {
    // Launch up to `concurrent` requests
    while (inFlight < concurrent && Date.now() < endTime) {
      doRequest(); // fire-and-forget
      if (intervalMs > 0) await sleep(intervalMs);
    }
    // Wait for some to complete before launching more
    await sleep(Math.max(10, intervalMs));
  }

  // Wait for remaining in-flight
  while (inFlight > 0) await sleep(10);

  return { latencies, errors429, errors5xx, errorsConn, rateLimitHeaders };
}

export async function calibrate(
  store: Store,
  adapter: Adapter,
  config?: CalibratorConfig,
): Promise<CalibrationResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const sourceIp = getSourceIp();

  // Get a sample of companies for this ATS
  const companies = store.db.prepare(
    'SELECT * FROM companies WHERE ats_type = ? AND active = 1 ORDER BY RANDOM() LIMIT ?'
  ).all(adapter.ats_type, cfg.sample_size) as { slug: string }[];

  if (companies.length === 0) {
    throw new Error(`No active companies found for ATS type: ${adapter.ats_type}`);
  }

  const urls = companies.map(c => adapter.buildUrl(c.slug));

  // Phase 1: baseline (sequential, one request at a time, generous spacing)
  console.log(`  [${adapter.ats_type}] Measuring baseline (${cfg.baseline_requests} requests, sequential)...`);
  const baselineLatencies: number[] = [];
  for (let i = 0; i < cfg.baseline_requests; i++) {
    const url = urls[i % urls.length];
    const r = await probe(url, cfg.request_timeout_ms, cfg.fetcher);
    baselineLatencies.push(r.latency_ms);
    await sleep(1000);
  }
  baselineLatencies.sort((a, b) => a - b);
  const baselineP95 = percentile(baselineLatencies, 95);
  console.log(`  [${adapter.ats_type}] Baseline p95: ${baselineP95.toFixed(0)}ms`);

  // Phase 2: ramp concurrency
  // Use a short interval so requests actually overlap. At 1000ms with fast responses
  // you never build up concurrency. Interval = max(10, baseline/4) is fast enough
  // for overlap but not a burst.
  const concurrencyInterval = Math.max(10, Math.floor(baselineP95 / 4));
  console.log(`  [${adapter.ats_type}] Ramping concurrency (interval=${concurrencyInterval}ms)...`);
  const concurrencyRamp: ConcurrencyRung[] = [];
  let recommendedConcurrent = 1;

  for (let c = 1; c <= cfg.max_probe_concurrent; c++) {
    console.log(`  [${adapter.ats_type}] Testing concurrency=${c}...`);
    const stats = await sustain(urls, c, concurrencyInterval, cfg.rung_duration_s, cfg.request_timeout_ms, cfg.fetcher);
    stats.latencies.sort((a, b) => a - b);
    const p95 = percentile(stats.latencies, 95);

    const signal = hasSignal(p95, baselineP95, stats.errors429, stats.errors5xx, stats.errorsConn, stats.rateLimitHeaders);

    concurrencyRamp.push({
      concurrent: c,
      duration_s: cfg.rung_duration_s,
      requests: stats.latencies.length,
      p95_ms: p95,
      errors_429: stats.errors429,
      errors_5xx: stats.errors5xx,
      errors_conn: stats.errorsConn,
      rate_limit_headers: stats.rateLimitHeaders,
      signal,
    });

    if (signal) {
      recommendedConcurrent = Math.max(1, c - 1);
      console.log(`  [${adapter.ats_type}] Signal at concurrency=${c}. Recommended: ${recommendedConcurrent}`);
      break;
    }
    recommendedConcurrent = c;
  }

  // Phase 3: ramp interval at recommended concurrency
  console.log(`  [${adapter.ats_type}] Ramping request rate at concurrency=${recommendedConcurrent}...`);
  const intervalRamp: IntervalRung[] = [];
  let recommendedInterval = cfg.intervals_to_probe[0];
  let prevInterval = cfg.intervals_to_probe[0];

  for (const interval of cfg.intervals_to_probe) {
    console.log(`  [${adapter.ats_type}] Testing interval=${interval}ms...`);
    const stats = await sustain(urls, recommendedConcurrent, interval, cfg.rung_duration_s, cfg.request_timeout_ms, cfg.fetcher);
    stats.latencies.sort((a, b) => a - b);
    const p95 = percentile(stats.latencies, 95);

    const signal = hasSignal(p95, baselineP95, stats.errors429, stats.errors5xx, stats.errorsConn, stats.rateLimitHeaders);

    intervalRamp.push({
      interval_ms: interval,
      concurrent: recommendedConcurrent,
      duration_s: cfg.rung_duration_s,
      requests: stats.latencies.length,
      p95_ms: p95,
      errors_429: stats.errors429,
      errors_5xx: stats.errors5xx,
      errors_conn: stats.errorsConn,
      rate_limit_headers: stats.rateLimitHeaders,
      signal,
    });

    if (signal) {
      recommendedInterval = prevInterval;
      console.log(`  [${adapter.ats_type}] Signal at interval=${interval}ms. Recommended: ${recommendedInterval}ms`);
      break;
    }
    recommendedInterval = interval;
    prevInterval = interval;
  }

  return {
    ats_type: adapter.ats_type,
    source_ip: sourceIp,
    sample_size: companies.length,
    baseline_p95_ms: baselineP95,
    recommended_concurrent: recommendedConcurrent,
    recommended_interval_ms: recommendedInterval,
    evidence: {
      concurrency_ramp: concurrencyRamp,
      interval_ramp: intervalRamp,
    },
  };
}

// -- History --

const CALIBRATION_HISTORY = path.join(import.meta.dirname, '..', 'calibration', 'history.jsonl');

export function appendCalibrationHistory(result: CalibrationResult): void {
  const entry = {
    timestamp: new Date().toISOString(),
    ...result,
  };
  const dir = path.dirname(CALIBRATION_HISTORY);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(CALIBRATION_HISTORY, JSON.stringify(entry) + '\n');
}
