import { createServer } from 'node:http';
import type { Store } from './store.js';
import type { AtsState } from './scheduler.js';

export interface DashboardConfig {
  port?: number;
  host?: string;
  store: Store;
  getAtsStates?: () => Map<string, AtsState>;
  getSchedulerStats?: () => { inFlight: number; pollsCompleted: number; pollsFailed: number };
}

export function startDashboard(config: DashboardConfig): void {
  const { store, port = 3000, host = '127.0.0.1' } = config;

  const server = createServer((req, res) => {
    if (req.url === '/' || req.url === '/dashboard') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDashboard(store, config));
      return;
    }

    if (req.url === '/api/metrics') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(collectMetrics(store, config), null, 2));
      return;
    }

    // Prometheus exposition format. Scraped by the local Prometheus.
    if (req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(renderPrometheus(store, config));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, host, () => {
    console.log(`Dashboard running at http://${host}:${port}`);
  });
}

function collectMetrics(store: Store, config: DashboardConfig) {
  const atsStates = config.getAtsStates?.() ?? new Map();
  const schedulerStats = config.getSchedulerStats?.() ?? { inFlight: 0, pollsCompleted: 0, pollsFailed: 0 };

  // Universe
  const companyCount = store.getCompanyCount();
  const activeCount = store.getActiveCompanyCount();
  const jobCount = store.getJobCount();

  // Per-ATS company counts
  const atsCounts: Record<string, number> = {};
  for (const ats of ['greenhouse', 'lever', 'ashby', 'workable']) {
    atsCounts[ats] = store.getCompanyCountByAts(ats);
  }

  // Discovery sources
  const sources = store.getSourceTypes();
  const sourceMetrics: Record<string, { yield: number; unique: number; first: number }> = {};
  for (const src of sources) {
    sourceMetrics[src] = {
      yield: store.getDiscoveryYield(src),
      unique: store.getUniqueContribution(src),
      first: store.getFirstDiscoveryBy(src),
    };
  }

  // AIMD state
  const aimdState: Record<string, { current_concurrent: number; ceiling_concurrent: number; current_interval_ms: number; ceiling_interval_ms: number; clean_window: number }> = {};
  for (const [ats, state] of atsStates) {
    aimdState[ats] = {
      current_concurrent: state.current_concurrent,
      ceiling_concurrent: state.config.ceiling_concurrent,
      current_interval_ms: state.current_interval_ms,
      ceiling_interval_ms: state.config.ceiling_interval_ms,
      clean_window: state.clean_window,
    };
  }

  // Recent poll attempts
  const recentPolls = store.db.prepare(`
    SELECT pa.*, c.name as company_name, c.ats_type
    FROM poll_attempts pa
    JOIN companies c ON c.id = pa.company_id
    ORDER BY pa.attempted_at DESC LIMIT 20
  `).all();

  // Disabled companies
  const disabled = store.db.prepare(`
    SELECT id, name, slug, ats_type, consecutive_failures, disabled_at
    FROM companies WHERE active = 0
    ORDER BY disabled_at DESC LIMIT 20
  `).all();

  // Freshness (production metric: first_seen_at - ats_posted_at)
  const freshness = store.db.prepare(`
    SELECT
      ats_type,
      COUNT(*) as total,
      COUNT(ats_posted_at) as with_posted_at,
      ROUND(AVG(CASE WHEN ats_posted_at IS NOT NULL
        THEN (julianday(first_seen_at) - julianday(ats_posted_at)) * 86400000
        ELSE NULL END)) as avg_lag_ms
    FROM jobs j
    JOIN companies c ON c.id = j.company_id
    GROUP BY ats_type
  `).all();

  return {
    timestamp: new Date().toISOString(),
    universe: { total: companyCount, active: activeCount, by_ats: atsCounts },
    jobs: { total: jobCount },
    discovery: sourceMetrics,
    scheduler: { ...schedulerStats, aimd: aimdState },
    recent_polls: recentPolls,
    disabled_companies: disabled,
    freshness,
  };
}

/**
 * Prometheus exposition format. Each metric has HELP/TYPE comments
 * followed by samples. We expose the same observables as collectMetrics()
 * but in line-per-sample text so promtool / promql can consume them.
 *
 * Naming: trawler_<subsystem>_<name>_<unit>. Counters end in _total.
 */
function renderPrometheus(store: Store, config: DashboardConfig): string {
  const m = collectMetrics(store, config);
  const out: string[] = [];

  function metric(name: string, type: 'gauge' | 'counter', help: string, samples: Array<{ labels?: Record<string, string>; value: number }>): void {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const s of samples) {
      const labelStr = s.labels && Object.keys(s.labels).length > 0
        ? '{' + Object.entries(s.labels).map(([k, v]) => `${k}="${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',') + '}'
        : '';
      out.push(`${name}${labelStr} ${s.value}`);
    }
  }

  // Universe — total / active companies, by ATS
  metric('trawler_companies_total', 'gauge', 'Total companies discovered.',
    [{ value: m.universe.total }]);
  metric('trawler_companies_active', 'gauge', 'Active (not auto-disabled) companies.',
    [{ value: m.universe.active }]);
  metric('trawler_companies_disabled', 'gauge', 'Auto-disabled companies (consecutive-failures threshold reached).',
    [{ value: m.universe.total - m.universe.active }]);
  metric('trawler_companies_by_ats', 'gauge', 'Companies per ATS.',
    Object.entries(m.universe.by_ats).map(([ats, n]) => ({ labels: { ats }, value: n })));

  // Jobs
  metric('trawler_jobs_total', 'gauge', 'Total job rows in DB.', [{ value: m.jobs.total }]);

  // Discovery
  metric('trawler_discovery_yield', 'gauge', 'Companies attributed to a discovery source.',
    Object.entries(m.discovery).map(([src, d]) => ({ labels: { source: src }, value: d.yield })));
  metric('trawler_discovery_unique_contribution', 'gauge', 'Companies uniquely contributed by a discovery source.',
    Object.entries(m.discovery).map(([src, d]) => ({ labels: { source: src }, value: d.unique })));

  // Scheduler
  metric('trawler_scheduler_in_flight', 'gauge', 'Polls currently in flight.', [{ value: m.scheduler.inFlight }]);
  metric('trawler_scheduler_polls_total', 'counter', 'Cumulative polls (success+fail) since process start.',
    [{ labels: { result: 'success' }, value: m.scheduler.pollsCompleted },
     { labels: { result: 'fail' }, value: m.scheduler.pollsFailed }]);

  // AIMD per-ATS
  for (const key of ['current_concurrent', 'ceiling_concurrent', 'current_interval_ms', 'ceiling_interval_ms', 'clean_window'] as const) {
    metric(`trawler_aimd_${key}`, 'gauge', `AIMD: ${key}.`,
      Object.entries(m.scheduler.aimd).map(([ats, s]) => ({ labels: { ats }, value: (s as any)[key] })));
  }

  // Freshness — convert avg_lag_ms (sometimes null/string) to numeric
  metric('trawler_freshness_jobs_total', 'gauge', 'Jobs in DB per ATS (denominator for the next two).',
    (m.freshness as any[]).map(f => ({ labels: { ats: f.ats_type }, value: f.total })));
  metric('trawler_freshness_with_posted_at', 'gauge', 'Jobs that have an ats_posted_at timestamp.',
    (m.freshness as any[]).map(f => ({ labels: { ats: f.ats_type }, value: f.with_posted_at })));
  const lagSamples = (m.freshness as any[])
    .filter(f => f.avg_lag_ms != null && Number.isFinite(Number(f.avg_lag_ms)))
    .map(f => ({ labels: { ats: f.ats_type }, value: Number(f.avg_lag_ms) }));
  if (lagSamples.length > 0) {
    metric('trawler_freshness_avg_lag_ms', 'gauge', 'Average ATS-publish-to-ingest lag in ms (only for ATSes that expose posted_at).',
      lagSamples);
  }

  // Recent poll error rate (within last 20)
  const recent = m.recent_polls as any[];
  const errors = recent.filter(p => p.status !== 'success').length;
  metric('trawler_recent_poll_errors', 'gauge', 'Errors in the last 20 logged poll attempts.',
    [{ value: errors }]);

  return out.join('\n') + '\n';
}

function renderDashboard(store: Store, config: DashboardConfig): string {
  const m = collectMetrics(store, config);

  return `<!DOCTYPE html>
<html>
<head>
  <title>Trawler Dashboard</title>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="30">
  <style>
    body { font-family: monospace; background: #0d1117; color: #c9d1d9; margin: 2em; }
    h1 { color: #58a6ff; font-size: 1.4em; }
    h2 { color: #8b949e; font-size: 1.1em; margin-top: 2em; border-bottom: 1px solid #21262d; padding-bottom: 0.3em; }
    table { border-collapse: collapse; margin: 0.5em 0; }
    th, td { text-align: left; padding: 0.3em 1.2em 0.3em 0; }
    th { color: #8b949e; }
    .ok { color: #3fb950; }
    .warn { color: #d29922; }
    .fail { color: #f85149; }
    .num { text-align: right; }
    .pill { display: inline-block; padding: 0.1em 0.5em; border-radius: 3px; font-size: 0.85em; }
    .pill-green { background: #0d2818; color: #3fb950; }
    .pill-red { background: #2d0a0a; color: #f85149; }
    .pill-yellow { background: #2d1f00; color: #d29922; }
  </style>
</head>
<body>
  <h1>Trawler Dashboard</h1>
  <p style="color:#8b949e">${m.timestamp} -- auto-refreshes every 30s</p>

  <h2>Universe</h2>
  <table>
    <tr><th>Companies</th><td class="num">${m.universe.total}</td></tr>
    <tr><th>Active</th><td class="num">${m.universe.active}</td></tr>
    <tr><th>Jobs</th><td class="num">${m.jobs.total}</td></tr>
    ${Object.entries(m.universe.by_ats).map(([ats, n]) =>
      `<tr><th>${ats}</th><td class="num">${n}</td></tr>`
    ).join('\n    ')}
  </table>

  <h2>Discovery Sources</h2>
  <table>
    <tr><th>Source</th><th class="num">Yield</th><th class="num">Unique</th><th class="num">First</th></tr>
    ${Object.entries(m.discovery).map(([src, d]) =>
      `<tr><td>${src}</td><td class="num">${d.yield}</td><td class="num">${d.unique}</td><td class="num">${d.first}</td></tr>`
    ).join('\n    ')}
  </table>

  <h2>Scheduler</h2>
  <table>
    <tr><th>In-flight</th><td class="num">${m.scheduler.inFlight}</td></tr>
    <tr><th>Completed</th><td class="num">${m.scheduler.pollsCompleted}</td></tr>
    <tr><th>Failed</th><td class="num">${m.scheduler.pollsFailed}</td></tr>
  </table>

  <h2>AIMD Rate Control</h2>
  <table>
    <tr><th>ATS</th><th>Concurrent</th><th>Ceiling</th><th>Interval ms</th><th>Ceiling ms</th><th>Clean window</th></tr>
    ${Object.entries(m.scheduler.aimd).map(([ats, s]) =>
      `<tr><td>${ats}</td><td class="num">${s.current_concurrent}</td><td class="num">${s.ceiling_concurrent}</td><td class="num">${s.current_interval_ms}</td><td class="num">${s.ceiling_interval_ms}</td><td class="num">${s.clean_window}</td></tr>`
    ).join('\n    ')}
  </table>

  <h2>Freshness</h2>
  <table>
    <tr><th>ATS</th><th class="num">Jobs</th><th class="num">With posted_at</th><th class="num">Avg lag ms</th></tr>
    ${(m.freshness as any[]).map((f: any) =>
      `<tr><td>${f.ats_type}</td><td class="num">${f.total}</td><td class="num">${f.with_posted_at}</td><td class="num">${f.avg_lag_ms ?? '--'}</td></tr>`
    ).join('\n    ')}
  </table>

  <h2>Recent Polls (last 20)</h2>
  <table>
    <tr><th>Time</th><th>Company</th><th>ATS</th><th>Status</th><th class="num">Latency</th><th class="num">Jobs</th></tr>
    ${(m.recent_polls as any[]).map((p: any) => {
      const cls = p.status === 'success' ? 'ok' : 'fail';
      return `<tr><td>${p.attempted_at}</td><td>${p.company_name}</td><td>${p.ats_type}</td><td class="${cls}">${p.status}</td><td class="num">${p.latency_ms}ms</td><td class="num">${p.jobs_found ?? '--'}</td></tr>`;
    }).join('\n    ')}
  </table>

  ${(m.disabled_companies as any[]).length > 0 ? `
  <h2>Disabled Companies</h2>
  <table>
    <tr><th>Name</th><th>ATS</th><th class="num">Failures</th><th>Disabled at</th></tr>
    ${(m.disabled_companies as any[]).map((c: any) =>
      `<tr><td>${c.name}</td><td>${c.ats_type}</td><td class="num">${c.consecutive_failures}</td><td>${c.disabled_at}</td></tr>`
    ).join('\n    ')}
  </table>
  ` : ''}

  <p style="color:#484f58;margin-top:3em">Trawler v${process.env.npm_package_version || '0.0.1'}</p>
</body>
</html>`;
}
