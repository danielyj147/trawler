import Database from 'better-sqlite3';
import type { CompanyRow, JobRow } from './schema.js';

export class Store {
  readonly db: Database.Database;

  constructor(path: string = 'trawler.db') {
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        ats_type TEXT NOT NULL CHECK(ats_type IN ('greenhouse', 'lever', 'ashby', 'workable')),
        ats_url TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        next_poll_at TEXT,
        poll_interval_ms INTEGER NOT NULL DEFAULT 900000,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        disabled_at TEXT,
        UNIQUE(ats_type, slug)
      );

      CREATE TABLE IF NOT EXISTS company_sources (
        company_id INTEGER NOT NULL REFERENCES companies(id),
        source_type TEXT NOT NULL,
        source_detail TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        PRIMARY KEY (company_id, source_type, source_detail)
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT NOT NULL,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        location TEXT,
        department TEXT,
        ats_posted_at TEXT,
        first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        UNIQUE(company_id, external_id)
      );

      CREATE TABLE IF NOT EXISTS poll_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL REFERENCES companies(id),
        attempted_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('success', 'error', 'timeout')),
        status_code INTEGER,
        latency_ms INTEGER NOT NULL,
        jobs_found INTEGER,
        error_message TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_companies_next_poll
        ON companies(next_poll_at) WHERE active = 1;

      CREATE INDEX IF NOT EXISTS idx_companies_disabled
        ON companies(disabled_at) WHERE active = 0;

      CREATE INDEX IF NOT EXISTS idx_jobs_company
        ON jobs(company_id);

      CREATE INDEX IF NOT EXISTS idx_poll_attempts_company
        ON poll_attempts(company_id, attempted_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  now(): string {
    return new Date().toISOString();
  }

  // --- Company: find-or-create with source tracking ---

  discoverCompany(
    company: { name: string; slug: string; ats_type: string; ats_url: string },
    source: { source_type: string; source_detail: string },
  ): number {
    const txn = this.db.transaction(() => {
      const now = this.now();
      const row = this.db.prepare(`
        INSERT INTO companies (name, slug, ats_type, ats_url, discovered_at)
        VALUES (@name, @slug, @ats_type, @ats_url, @discovered_at)
        ON CONFLICT(ats_type, slug) DO UPDATE SET
          ats_url = excluded.ats_url
        RETURNING id
      `).get({ ...company, discovered_at: now }) as { id: number };

      this.db.prepare(`
        INSERT OR IGNORE INTO company_sources (company_id, source_type, source_detail, discovered_at)
        VALUES (@company_id, @source_type, @source_detail, @discovered_at)
      `).run({ company_id: row.id, ...source, discovered_at: now });

      return row.id;
    });
    return txn();
  }

  getCompany(id: number): CompanyRow | undefined {
    return this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as CompanyRow | undefined;
  }

  // --- Jobs: upsert (never touches first_seen_at) ---

  upsertJob(job: {
    external_id: string;
    company_id: number;
    title: string;
    url: string;
    location: string | null;
    department: string | null;
    ats_posted_at: string | null;
    updated_at: string;
    raw_json: string;
  }): { id: number; is_new: boolean } {
    const existing = this.db.prepare(
      'SELECT id FROM jobs WHERE company_id = @company_id AND external_id = @external_id'
    ).get(job) as { id: number } | undefined;

    const row = this.db.prepare(`
      INSERT INTO jobs (external_id, company_id, title, url, location, department, ats_posted_at, updated_at, raw_json)
      VALUES (@external_id, @company_id, @title, @url, @location, @department, @ats_posted_at, @updated_at, @raw_json)
      ON CONFLICT(company_id, external_id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        location = excluded.location,
        department = excluded.department,
        ats_posted_at = excluded.ats_posted_at,
        updated_at = excluded.updated_at,
        raw_json = excluded.raw_json
      RETURNING id
    `).get(job) as { id: number };

    return { id: row.id, is_new: !existing };
  }

  getJob(id: number): JobRow | undefined {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
  }

  getJobByKey(company_id: number, external_id: string): JobRow | undefined {
    return this.db.prepare(
      'SELECT * FROM jobs WHERE company_id = ? AND external_id = ?'
    ).get(company_id, external_id) as JobRow | undefined;
  }

  // --- Poll tracking ---

  recordPollAttempt(attempt: {
    company_id: number;
    attempted_at: string;
    status: string;
    status_code: number | null;
    latency_ms: number;
    jobs_found: number | null;
    error_message: string | null;
  }): void {
    this.db.prepare(`
      INSERT INTO poll_attempts (company_id, attempted_at, status, status_code, latency_ms, jobs_found, error_message)
      VALUES (@company_id, @attempted_at, @status, @status_code, @latency_ms, @jobs_found, @error_message)
    `).run(attempt);
  }

  markPollSuccess(company_id: number, next_poll_at: string): void {
    this.db.prepare(`
      UPDATE companies SET
        consecutive_failures = 0,
        next_poll_at = @next_poll_at,
        disabled_at = NULL,
        active = 1
      WHERE id = @company_id
    `).run({ company_id, next_poll_at });
  }

  markPollFailure(company_id: number, max_failures: number = 5): void {
    this.db.prepare(`
      UPDATE companies SET
        consecutive_failures = consecutive_failures + 1,
        active = CASE WHEN consecutive_failures + 1 >= @max THEN 0 ELSE active END,
        disabled_at = CASE
          WHEN consecutive_failures + 1 >= @max AND disabled_at IS NULL
          THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          ELSE disabled_at
        END
      WHERE id = @id
    `).run({ id: company_id, max: max_failures });
  }

  // --- Scheduler queries ---

  getDueCompanies(limit: number): CompanyRow[] {
    return this.db.prepare(`
      SELECT * FROM companies
      WHERE active = 1
        AND (next_poll_at IS NULL OR next_poll_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ORDER BY next_poll_at ASC NULLS FIRST
      LIMIT ?
    `).all(limit) as CompanyRow[];
  }

  getDisabledCompanies(): (CompanyRow & { seconds_disabled: number })[] {
    return this.db.prepare(`
      SELECT *,
        (julianday('now') - julianday(disabled_at)) * 86400.0 as seconds_disabled
      FROM companies
      WHERE active = 0 AND disabled_at IS NOT NULL
    `).all() as (CompanyRow & { seconds_disabled: number })[];
  }

  getInFlightCount(): number {
    // Not tracked in DB — managed in-memory by the scheduler
    return 0;
  }

  // --- Metrics queries ---

  getCompanyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM companies').get() as { c: number }).c;
  }

  getActiveCompanyCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM companies WHERE active = 1').get() as { c: number }).c;
  }

  getJobCount(): number {
    return (this.db.prepare('SELECT COUNT(*) as c FROM jobs').get() as { c: number }).c;
  }

  getSourceTypes(): string[] {
    return (this.db.prepare(
      'SELECT DISTINCT source_type FROM company_sources ORDER BY source_type'
    ).all() as { source_type: string }[]).map(r => r.source_type);
  }

  getDiscoveryYield(source_type: string): number {
    return (this.db.prepare(
      'SELECT COUNT(DISTINCT company_id) as c FROM company_sources WHERE source_type = ?'
    ).get(source_type) as { c: number }).c;
  }

  getUniqueContribution(source_type: string): number {
    return (this.db.prepare(`
      SELECT COUNT(*) as c FROM companies c
      WHERE EXISTS (
        SELECT 1 FROM company_sources cs WHERE cs.company_id = c.id AND cs.source_type = @st
      )
      AND NOT EXISTS (
        SELECT 1 FROM company_sources cs WHERE cs.company_id = c.id AND cs.source_type != @st
      )
    `).get({ st: source_type }) as { c: number }).c;
  }

  getFirstDiscoveryBy(source_type: string): number {
    return (this.db.prepare(`
      SELECT COUNT(DISTINCT cs1.company_id) as c
      FROM company_sources cs1
      WHERE cs1.source_type = @st
        AND cs1.discovered_at = (
          SELECT MIN(cs2.discovered_at)
          FROM company_sources cs2
          WHERE cs2.company_id = cs1.company_id
        )
    `).get({ st: source_type }) as { c: number }).c;
  }

  getCompanyCountByAts(ats_type: string): number {
    return (this.db.prepare(
      'SELECT COUNT(*) as c FROM companies WHERE ats_type = ?'
    ).get(ats_type) as { c: number }).c;
  }
}
