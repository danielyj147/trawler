/**
 * Run calibration against live ATSes.
 *
 * Usage: npx tsx src/run-calibration.ts [--rung-duration 120] [--max-concurrent 10]
 *
 * Probes each ATS with companies from the real universe in the DB.
 * Outputs full ramp data and recommended ceilings.
 * Appends results to calibration/history.jsonl.
 */

import { Store } from './store.js';
import { greenhouse } from './adapters/greenhouse.js';
import { lever } from './adapters/lever.js';
import { ashby } from './adapters/ashby.js';
import { calibrate, appendCalibrationHistory } from './calibrator.js';
import type { CalibrationResult } from './calibrator.js';

const ADAPTERS = [greenhouse, lever, ashby];
// Skip workable — only 1 bogus company in universe

function parseArgs() {
  const args = process.argv.slice(2);
  let rungDuration = 120; // 2 minutes per rung
  let maxConcurrent = 10;
  let sampleSize = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--rung-duration' && args[i + 1]) rungDuration = parseInt(args[++i], 10);
    if (args[i] === '--max-concurrent' && args[i + 1]) maxConcurrent = parseInt(args[++i], 10);
    if (args[i] === '--sample-size' && args[i + 1]) sampleSize = parseInt(args[++i], 10);
  }

  return { rungDuration, maxConcurrent, sampleSize };
}

async function main() {
  const { rungDuration, maxConcurrent, sampleSize } = parseArgs();
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  const store = new Store(dbPath);

  console.log('TRAWLER LIVE CALIBRATION');
  console.log('='.repeat(60));
  console.log(`  DB: ${dbPath}`);
  console.log(`  Rung duration: ${rungDuration}s`);
  console.log(`  Max concurrent probe: ${maxConcurrent}`);
  console.log(`  Sample size: ${sampleSize}`);
  console.log('');

  const results: CalibrationResult[] = [];

  for (const adapter of ADAPTERS) {
    const count = store.getCompanyCountByAts(adapter.ats_type);
    if (count < 5) {
      console.log(`  Skipping ${adapter.ats_type}: only ${count} companies (need >= 5)`);
      continue;
    }

    console.log(`  Calibrating ${adapter.ats_type} (${count} companies in universe)...`);
    console.log('');

    try {
      const result = await calibrate(store, adapter, {
        rung_duration_s: rungDuration,
        max_probe_concurrent: maxConcurrent,
        intervals_to_probe: [500, 250, 100, 50, 25],
        sample_size: Math.min(sampleSize, count),
        baseline_requests: 10,
        request_timeout_ms: 15_000,
      });

      results.push(result);
      appendCalibrationHistory(result);

      // Print full ramp data
      console.log('');
      console.log(`  ${adapter.ats_type.toUpperCase()} CALIBRATION RESULTS`);
      console.log('  ' + '-'.repeat(50));
      console.log(`  Source IP:               ${result.source_ip}`);
      console.log(`  Sample size:             ${result.sample_size}`);
      console.log(`  Baseline p95:            ${result.baseline_p95_ms.toFixed(0)}ms`);
      console.log(`  Recommended concurrent:  ${result.recommended_concurrent}`);
      console.log(`  Recommended interval:    ${result.recommended_interval_ms}ms`);
      console.log('');

      console.log('  Concurrency ramp:');
      console.log('  ' + ['Level', 'Requests', 'p95ms', '429s', '5xx', 'Conn', 'RLHdr', 'Signal'].map(h => h.padStart(8)).join(''));
      for (const r of result.evidence.concurrency_ramp) {
        console.log('  ' + [
          r.concurrent, r.requests, r.p95_ms.toFixed(0),
          r.errors_429, r.errors_5xx, r.errors_conn,
          r.rate_limit_headers ? 'Y' : 'N', r.signal ? 'YES' : '',
        ].map(v => String(v).padStart(8)).join(''));
      }
      console.log('');

      console.log('  Interval ramp:');
      console.log('  ' + ['IntMs', 'Conc', 'Requests', 'p95ms', '429s', '5xx', 'Conn', 'RLHdr', 'Signal'].map(h => h.padStart(8)).join(''));
      for (const r of result.evidence.interval_ramp) {
        console.log('  ' + [
          r.interval_ms, r.concurrent, r.requests, r.p95_ms.toFixed(0),
          r.errors_429, r.errors_5xx, r.errors_conn,
          r.rate_limit_headers ? 'Y' : 'N', r.signal ? 'YES' : '',
        ].map(v => String(v).padStart(8)).join(''));
      }
      console.log('');

      // Sanity check
      if (result.recommended_concurrent <= 1) {
        console.log(`  WARNING: concurrent=1 may indicate the baseline itself is triggering limits.`);
        console.log(`  Check if the ATS is rate-limiting even sequential requests.`);
      }
      if (result.recommended_concurrent >= maxConcurrent) {
        console.log(`  NOTE: Hit max probe concurrent=${maxConcurrent}. Real ceiling may be higher.`);
      }

    } catch (err: any) {
      console.log(`  ERROR calibrating ${adapter.ats_type}: ${err.message}`);
    }

    console.log('');
  }

  // Summary
  console.log('='.repeat(60));
  console.log('CALIBRATION SUMMARY');
  console.log('='.repeat(60));
  console.log('');
  console.log('  ' + ['ATS', 'Concurrent', 'Interval ms', 'Baseline p95'].map(h => h.padEnd(15)).join(''));
  for (const r of results) {
    console.log('  ' + [
      r.ats_type, r.recommended_concurrent, r.recommended_interval_ms,
      r.baseline_p95_ms.toFixed(0) + 'ms',
    ].map(v => String(v).padEnd(15)).join(''));
  }
  console.log('');
  console.log(`  Results appended to calibration/history.jsonl`);
  console.log('='.repeat(60));

  store.close();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
