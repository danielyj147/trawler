import type { CompanyRow } from './schema.js';
import type { Store } from './store.js';
import type { Adapter } from './adapters/types.js';

export interface AtsConfig {
  ceiling_concurrent: number;
  ceiling_interval_ms: number;
}

const DEFAULT_ATS_CONFIG: AtsConfig = {
  ceiling_concurrent: 2,
  ceiling_interval_ms: 500,
};

export interface AtsState {
  config: AtsConfig;
  current_concurrent: number;
  current_interval_ms: number;
  in_flight: number;
  last_request_at: number;
  clean_window: number;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface SchedulerConfig {
  global_max_in_flight?: number;
  max_consecutive_failures?: number;
  ats_configs?: Record<string, AtsConfig>;
  fetcher?: Fetcher;
  clean_window_threshold?: number;
  recovery_sweep_interval_ms?: number;
  request_timeout_ms?: number;
}

// Retry schedule: attempt at these elapsed-seconds after disabled_at.
// After the fixed points, retry every 86400s (24h).
const RETRY_POINTS_S = [600, 3600, 14400];

function shouldAttemptRecovery(secondsDisabled: number, sweepIntervalS: number): boolean {
  for (const t of RETRY_POINTS_S) {
    if (secondsDisabled >= t && secondsDisabled < t + sweepIntervalS) return true;
  }
  if (secondsDisabled >= 86400) {
    const tail = secondsDisabled - 86400;
    const mod = tail % 86400;
    if (mod < sweepIntervalS) return true;
  }
  return false;
}

export class Scheduler {
  private store: Store;
  private adapters: Map<string, Adapter>;
  private fetcher: Fetcher;
  private running = false;
  inFlight = 0;
  private globalMax: number;
  private maxFailures: number;
  private cleanWindowThreshold: number;
  private recoverySweepInterval: number;
  private requestTimeout: number;
  private atsStates: Map<string, AtsState> = new Map();
  private resolveCapacity: (() => void) | null = null;
  private lastRecoverySweep = 0;

  // Counters for benchmark observability
  pollsCompleted = 0;
  pollsFailed = 0;

  constructor(store: Store, adapters: Adapter[], config?: SchedulerConfig) {
    this.store = store;
    this.adapters = new Map(adapters.map(a => [a.ats_type, a]));
    this.fetcher = config?.fetcher ?? globalThis.fetch;
    this.globalMax = config?.global_max_in_flight ?? 100;
    this.maxFailures = config?.max_consecutive_failures ?? 5;
    this.cleanWindowThreshold = config?.clean_window_threshold ?? 10;
    this.recoverySweepInterval = config?.recovery_sweep_interval_ms ?? 600_000;
    this.requestTimeout = config?.request_timeout_ms ?? 15_000;

    for (const adapter of adapters) {
      const cfg = config?.ats_configs?.[adapter.ats_type] ?? DEFAULT_ATS_CONFIG;
      this.atsStates.set(adapter.ats_type, {
        config: { ...cfg },
        current_concurrent: Math.max(1, Math.floor(cfg.ceiling_concurrent / 2)),
        current_interval_ms: cfg.ceiling_interval_ms * 2,
        in_flight: 0,
        last_request_at: 0,
        clean_window: 0,
      });
    }
  }

  getAtsState(atsType: string): AtsState | undefined {
    return this.atsStates.get(atsType);
  }

  async start(): Promise<void> {
    this.running = true;
    while (this.running) {
      await this.tick();
    }
  }

  stop(): void {
    this.running = false;
    if (this.resolveCapacity) this.resolveCapacity();
  }

  /** Run exactly n ticks (for benchmarks). */
  async runTicks(n: number): Promise<void> {
    this.running = true;
    for (let i = 0; i < n && this.running; i++) {
      await this.tick();
    }
  }

  /** Wait for all in-flight polls to finish. */
  async drain(): Promise<void> {
    while (this.inFlight > 0) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }

  async tick(): Promise<void> {
    // Recovery sweep on interval
    const now = Date.now();
    if (now - this.lastRecoverySweep >= this.recoverySweepInterval) {
      this.lastRecoverySweep = now;
      await this.recoverySweep();
    }

    const capacity = this.globalMax - this.inFlight;
    if (capacity <= 0) {
      await new Promise<void>(resolve => {
        this.resolveCapacity = resolve;
        setTimeout(resolve, 100); // safety timeout
      });
      this.resolveCapacity = null;
      return;
    }

    const due = this.store.getDueCompanies(capacity * 3);
    if (due.length === 0) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return;
    }

    let dispatched = 0;
    for (const company of due) {
      if (dispatched >= capacity) break;

      const state = this.atsStates.get(company.ats_type);
      if (!state) continue;
      if (state.in_flight >= state.current_concurrent) continue;

      const sinceLast = Date.now() - state.last_request_at;
      if (sinceLast < state.current_interval_ms) continue;

      this.dispatch(company, state);
      dispatched++;
    }

    if (dispatched === 0) {
      await new Promise(resolve => setTimeout(resolve, 50));
    } else {
      await new Promise(resolve => setImmediate(resolve));
    }
  }

  private dispatch(company: CompanyRow, state: AtsState): void {
    this.inFlight++;
    state.in_flight++;
    state.last_request_at = Date.now();

    this.poll(company).finally(() => {
      this.inFlight--;
      state.in_flight--;
      if (this.resolveCapacity) this.resolveCapacity();
    });
  }

  private async poll(company: CompanyRow): Promise<void> {
    const adapter = this.adapters.get(company.ats_type);
    if (!adapter) return;

    const url = adapter.buildUrl(company.slug);
    const fetchInit = adapter.buildFetchInit?.(company.slug) ?? {};
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.requestTimeout);

      let response: Response;
      try {
        response = await this.fetcher(url, { ...fetchInit, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }

      // Rate-limit header signals
      const retryAfter = response.headers.get('Retry-After');
      const rlRemaining = response.headers.get('X-RateLimit-Remaining');
      const hasRateLimitSignal = retryAfter != null || rlRemaining === '0';

      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), {
          statusCode: response.status,
        });
      }

      const body = await response.text();
      const jobs = adapter.parse(body);

      // Fix URLs that need the company slug (e.g., Ashby parse doesn't have it)
      for (const job of jobs) {
        if (job.url.includes('/unknown/')) {
          job.url = job.url.replace('/unknown/', `/${company.slug}/`);
        }
      }

      const ts = new Date().toISOString();
      for (const job of jobs) {
        this.store.upsertJob({ ...job, company_id: company.id, updated_at: ts });
      }

      const nextPoll = new Date(Date.now() + company.poll_interval_ms).toISOString();
      this.store.markPollSuccess(company.id, nextPoll);

      this.store.recordPollAttempt({
        company_id: company.id,
        attempted_at: ts,
        status: 'success',
        status_code: response.status,
        latency_ms: Date.now() - start,
        jobs_found: jobs.length,
        error_message: null,
      });

      this.pollsCompleted++;

      if (hasRateLimitSignal) {
        this.aimdDecrease(company.ats_type);
      } else {
        this.aimdIncrease(company.ats_type);
      }
    } catch (err: any) {
      const ts = new Date().toISOString();
      const isTimeout = err.name === 'AbortError';

      this.store.recordPollAttempt({
        company_id: company.id,
        attempted_at: ts,
        status: isTimeout ? 'timeout' : 'error',
        status_code: err.statusCode ?? null,
        latency_ms: Date.now() - start,
        jobs_found: null,
        error_message: err.message ?? String(err),
      });

      this.store.markPollFailure(company.id, this.maxFailures);
      this.pollsFailed++;
      this.aimdDecrease(company.ats_type);
    }
  }

  private aimdIncrease(atsType: string): void {
    const s = this.atsStates.get(atsType);
    if (!s) return;
    s.clean_window++;
    if (s.clean_window >= this.cleanWindowThreshold) {
      s.current_concurrent = Math.min(s.config.ceiling_concurrent, s.current_concurrent + 1);
      s.current_interval_ms = Math.max(s.config.ceiling_interval_ms, s.current_interval_ms - 50);
      s.clean_window = 0;
    }
  }

  private aimdDecrease(atsType: string): void {
    const s = this.atsStates.get(atsType);
    if (!s) return;
    s.clean_window = 0;
    s.current_concurrent = Math.max(1, Math.floor(s.current_concurrent * 0.5));
    s.current_interval_ms = Math.min(
      s.config.ceiling_interval_ms * 10,
      s.current_interval_ms * 2,
    );
  }

  private async recoverySweep(): Promise<void> {
    const disabled = this.store.getDisabledCompanies();
    const sweepIntervalS = this.recoverySweepInterval / 1000;

    for (const company of disabled) {
      if (!shouldAttemptRecovery(company.seconds_disabled, sweepIntervalS)) continue;

      const adapter = this.adapters.get(company.ats_type);
      if (!adapter) continue;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.requestTimeout);
        const response = await this.fetcher(adapter.buildUrl(company.slug), {
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (response.ok) {
          const body = await response.text();
          adapter.parse(body); // validate
          const nextPoll = new Date(Date.now() + company.poll_interval_ms).toISOString();
          this.store.markPollSuccess(company.id, nextPoll);
        }
        // Failed response: leave disabled, backoff continues
      } catch {
        // Still broken — leave disabled
      }
    }
  }
}
