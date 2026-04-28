/**
 * Matching dashboard. Inbox-style triage:
 *   - Default view: unlabeled push matches, newest first.
 *   - Filter chips: All / Unlabeled / Applied+Interested / Passed.
 *   - Sort: Newest / Highest score.
 *   - Keyboard: J/K to navigate, A/I/N/F to label, U to undo, O to open URL.
 *   - Labels are optimistic; auto-refresh every 30s without page reload.
 *
 * The server returns a single JSON snapshot at /api/state; the client
 * renders. Keeps server simple (~one big GET, one POST per write).
 */

import { createServer } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Store } from '../store.js';
import { checkHardConstraints } from './hard-constraints.js';
import { PROFILE } from './profile.js';
import type { MatchingLoop } from './loop.js';

const RESULTS_DIR = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'results');
const LABELS_FILE = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'labels.json');
const LLM_LABELS_FILE = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'llm-labels.jsonl');
const STATE_FILE = path.join(import.meta.dirname, '..', '..', 'benchmarks', 'matching', 'dashboard-state.json');

type LabelValue = 'applied' | 'interested' | 'not_interested' | 'false_positive';

interface Label {
  key: string;
  value: LabelValue;
  timestamp: string;
}

interface DashboardState {
  last_viewed_at: string | null;
}

function loadLabels(): Record<string, Label> {
  if (!fs.existsSync(LABELS_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(LABELS_FILE, 'utf-8')); } catch { return {}; }
}

function saveLabels(labels: Record<string, Label>) {
  fs.writeFileSync(LABELS_FILE, JSON.stringify(labels, null, 2));
}

function loadLLMLabels(): Record<string, { verdict: 'fit' | 'borderline' | 'unfit'; rationale: string }> {
  if (!fs.existsSync(LLM_LABELS_FILE)) return {};
  const out: Record<string, { verdict: any; rationale: string }> = {};
  try {
    const lines = fs.readFileSync(LLM_LABELS_FILE, 'utf-8').split('\n').filter(Boolean);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        if (e.key) out[e.key] = { verdict: e.verdict, rationale: e.rationale || '' };
      } catch {}
    }
  } catch {}
  return out;
}

function loadState(): DashboardState {
  if (!fs.existsSync(STATE_FILE)) return { last_viewed_at: null };
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return { last_viewed_at: null }; }
}

function saveState(s: DashboardState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

/**
 * Pipeline-file parse cache, keyed by (filename, mtime). Without it, every
 * snapshot rebuild parses 11+ MB of JSON synchronously even though most
 * files are unchanged from the previous tick. Cache survives the process;
 * dropped on restart, which is when the parsing logic could change.
 */
const FILE_CACHE = new Map<string, { mtime: number; results: any[] }>();

/**
 * Hard-constraint re-validation cache. Per-(slug, title) jobs in the DB are
 * effectively immutable for our purposes — once a (slug, title) tuple has
 * been hard-checked we never need to re-check it (the constraint code is
 * unchanged for the life of the process). This avoids ~300 sqlite queries
 * on every cache miss.
 */
const HARD_CHECK_CACHE = new Map<string, { passed: boolean; failures: string[] }>();

function loadAllResults(): Array<any & { _added_at: number }> {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith('pipeline-')).sort();
  const seen = new Map<string, any & { _added_at: number }>();

  for (const file of files) {
    const full = path.join(RESULTS_DIR, file);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }

    let cached = FILE_CACHE.get(file);
    if (!cached || cached.mtime !== mtime) {
      try {
        const results = JSON.parse(fs.readFileSync(full, 'utf-8'));
        cached = { mtime, results };
        FILE_CACHE.set(file, cached);
      } catch { continue; }
    }
    for (const r of cached.results) {
      if (!r.company_slug || !r.title) continue;
      seen.set(r.company_slug + '/' + r.title, { ...r, _added_at: mtime });
    }
  }

  // Drop stale cache entries (files removed from disk)
  if (FILE_CACHE.size > files.length) {
    const live = new Set(files);
    for (const k of FILE_CACHE.keys()) if (!live.has(k)) FILE_CACHE.delete(k);
  }

  // Re-validate hard constraints for results that don't already carry a
  // hard_failures verdict, using the per-key cache so we hit sqlite at
  // most once per unique job over the process lifetime.
  const dbPath = process.env.TRAWLER_DB || 'trawler.db';
  if (fs.existsSync(dbPath)) {
    let store: Store | null = null;
    let stmt: any = null;
    for (const [k, r] of seen) {
      if (r.hard_failures && r.hard_failures.length > 0) continue;

      let check = HARD_CHECK_CACHE.get(k);
      if (!check) {
        if (!store) {
          store = new Store(dbPath);
          stmt = store.db.prepare(`
            SELECT j.raw_json FROM jobs j JOIN companies c ON c.id = j.company_id
            WHERE c.slug = ? AND j.title = ? LIMIT 1
          `);
        }
        const row = stmt.get(r.company_slug, r.title) as { raw_json: string } | undefined;
        if (!row) continue;
        const result = checkHardConstraints(PROFILE, r.title, row.raw_json || '');
        check = { passed: result.passed, failures: result.failures };
        HARD_CHECK_CACHE.set(k, check);
      }

      if (!check.passed) {
        seen.set(k, { ...r, score: 0, band: 'skip', hard_failures: check.failures });
      }
    }
    if (store) store.close();
  }
  return [...seen.values()];
}

// Snapshot cache. buildSnapshot does a per-result DB lookup for hard-constraint
// re-validation; with ~200 results that runs ~200 sqlite queries. Cheap on first
// call but Prometheus scrapes every 15s and this would dominate the metrics
// endpoint's latency. Cache for 20 s — fresh enough for both UI auto-refresh
// and Prometheus, far cheaper than recomputing on every request.
let SNAPSHOT_CACHE: { built_at: number; data: ReturnType<typeof buildSnapshotInner> } | null = null;
const SNAPSHOT_TTL_MS = 20_000;

function buildSnapshot(loop?: MatchingLoop) {
  if (SNAPSHOT_CACHE && Date.now() - SNAPSHOT_CACHE.built_at < SNAPSHOT_TTL_MS) {
    // Always re-attach live loop counters; everything else is cached
    return { ...SNAPSHOT_CACHE.data, loop: snapshotLoop(loop) };
  }
  const data = buildSnapshotInner(loop);
  SNAPSHOT_CACHE = { built_at: Date.now(), data };
  return data;
}

function snapshotLoop(loop?: MatchingLoop) {
  if (!loop) return null;
  return {
    ticks: loop.ticks,
    jobsQualified: loop.jobsQualified,
    pushFound: loop.pushFound,
    digestFound: loop.digestFound,
    lastTickAt: loop.lastTickAt,
    lastTickStatus: loop.lastTickStatus,
  };
}

function buildSnapshotInner(loop?: MatchingLoop) {
  const labels = loadLabels();
  const llmLabels = loadLLMLabels();
  const state = loadState();
  const lastViewedMs = state.last_viewed_at ? new Date(state.last_viewed_at).getTime() : 0;

  const all = loadAllResults();
  const startOfDayMs = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').getTime();
  const labelsToday = Object.values(labels).filter(l => new Date(l.timestamp).getTime() >= startOfDayMs).length;

  const matches = all.map(r => {
    const key = r.company_slug + '/' + r.title;
    return {
      key,
      score: r.score,
      band: r.band,
      company_slug: r.company_slug,
      title: r.title,
      url: r.url,
      location: r.location,
      reasoning: r.reasoning || '',
      hard_failures: r.hard_failures || [],
      added_at: r._added_at,
      label: labels[key]?.value ?? null,
      label_at: labels[key]?.timestamp ?? null,
      llm_verdict: llmLabels[key]?.verdict ?? null,
      llm_rationale: llmLabels[key]?.rationale ?? null,
      is_new: r._added_at > lastViewedMs,
    };
  });

  // Counts (all bands, all labels — let the client filter)
  const push = matches.filter(m => m.score >= 70 && m.hard_failures.length === 0);
  const digest = matches.filter(m => m.score >= 40 && m.score < 70 && m.hard_failures.length === 0);

  return {
    matches,
    labels,
    last_viewed_at: state.last_viewed_at,
    stats: {
      total: matches.length,
      push: push.length,
      digest: digest.length,
      unlabeled_push: push.filter(m => !m.label).length,
      unlabeled_digest: digest.filter(m => !m.label).length,
      labeled_total: Object.keys(labels).length,
      labeled_today: labelsToday,
      new_push: push.filter(m => m.is_new).length,
    },
    loop: snapshotLoop(loop),
    server_time: Date.now(),
  };
}

const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>Trawler</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d1117'/%3E%3Cg fill='none' stroke='%2358a6ff' stroke-width='3' stroke-linecap='round'%3E%3Cpath d='M14 22 L32 30 L50 22'/%3E%3Cpath d='M14 32 L32 40 L50 32'/%3E%3Cpath d='M14 42 L32 50 L50 42'/%3E%3C/g%3E%3Ccircle cx='32' cy='15' r='4' fill='%233fb950'/%3E%3C/svg%3E">
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --panel-2: #21262d; --border: #30363d;
      --text: #c9d1d9; --muted: #8b949e; --accent: #58a6ff;
      --green: #3fb950; --yellow: #d29922; --red: #f85149; --blue: #58a6ff;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
    .container { max-width: 920px; margin: 0 auto; padding: 1.5em; }

    /* HEADER */
    h1 { font-size: 1.4em; color: var(--accent); margin-bottom: 0.4em; display: flex; align-items: center; gap: 0.5em; }
    h1 .live { width: 8px; height: 8px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .subhead { color: var(--muted); font-size: 0.9em; margin-bottom: 1em; }
    .subhead code { background: var(--panel); padding: 0.1em 0.4em; border-radius: 3px; }

    /* STATS */
    .stats { display: flex; gap: 0.5em; flex-wrap: wrap; margin-bottom: 0.8em; }
    .stat { background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 0.4em 0.7em; font-size: 0.85em; }
    .stat .num { font-weight: 600; color: var(--text); margin-right: 0.3em; }
    .stat .lbl { color: var(--muted); }
    .stat.green .num { color: var(--green); }
    .stat.blue .num { color: var(--accent); }

    /* TOOLBAR */
    .toolbar { display: flex; gap: 0.4em; flex-wrap: wrap; align-items: center; padding: 0.6em; background: var(--panel); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1em; position: sticky; top: 0.5em; z-index: 10; backdrop-filter: blur(8px); }
    .toolbar-group { display: flex; gap: 0.2em; align-items: center; }
    .toolbar-label { font-size: 0.75em; color: var(--muted); margin-right: 0.3em; }
    .chip { background: transparent; border: 1px solid var(--border); border-radius: 999px; color: var(--text); padding: 0.25em 0.7em; font-size: 0.8em; cursor: pointer; }
    .chip:hover { background: var(--panel-2); }
    .chip.active { background: var(--accent); border-color: var(--accent); color: #fff; }
    .chip .ct { color: inherit; opacity: 0.65; margin-left: 0.3em; font-variant-numeric: tabular-nums; }
    .chip.active .ct { opacity: 0.9; }
    .toolbar select { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 0.25em 0.5em; font-size: 0.8em; }
    .help-btn { margin-left: auto; background: transparent; border: 1px solid var(--border); border-radius: 6px; color: var(--muted); padding: 0.25em 0.6em; cursor: pointer; font-size: 0.8em; }
    .help-btn:hover { color: var(--text); }

    /* HELP OVERLAY */
    .help { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 100; align-items: center; justify-content: center; }
    .help.open { display: flex; }
    .help-card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 1.5em; max-width: 480px; width: 90%; }
    .help-card h2 { color: var(--accent); margin-bottom: 0.8em; font-size: 1.1em; }
    .help-card kbd { background: var(--panel-2); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 0.05em 0.4em; font-family: monospace; font-size: 0.85em; }
    .help-card .row { display: flex; justify-content: space-between; padding: 0.3em 0; border-bottom: 1px dashed var(--border); }
    .help-card .row:last-child { border-bottom: none; }
    .help-card .row span:first-child { color: var(--muted); }

    /* CARDS */
    .list { display: flex; flex-direction: column; gap: 0.5em; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 8px; padding: 0.9em 1em; transition: border-color 0.1s, transform 0.1s; }
    .card.focused { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .card.labeled { opacity: 0.55; }
    .card.labeled.focused { opacity: 1; }
    .card.push { border-left: 3px solid var(--green); }
    .card.digest { border-left: 3px solid var(--yellow); }
    .card-row { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.3em; flex-wrap: wrap; }
    .score { background: var(--panel-2); color: var(--accent); padding: 0.1em 0.5em; border-radius: 4px; font-weight: 600; font-size: 0.85em; min-width: 2.4em; text-align: center; }
    .new-badge { background: rgba(63,185,80,0.15); color: var(--green); border: 1px solid var(--green); padding: 0.05em 0.45em; border-radius: 3px; font-size: 0.65em; font-weight: 600; letter-spacing: 0.05em; }
    .label-badge { padding: 0.05em 0.45em; border-radius: 3px; font-size: 0.7em; }
    .label-badge.applied { background: rgba(63,185,80,0.15); color: var(--green); }
    .label-badge.interested { background: rgba(88,166,255,0.15); color: var(--blue); }
    .label-badge.not_interested { background: rgba(248,81,73,0.15); color: var(--red); }
    .label-badge.false_positive { background: rgba(210,153,34,0.15); color: var(--yellow); }
    .llm-badge { padding: 0.05em 0.45em; border-radius: 3px; font-size: 0.65em; opacity: 0.7; border: 1px solid var(--border); color: var(--muted); }
    .llm-badge.fit { color: var(--green); border-color: rgba(63,185,80,0.4); }
    .llm-badge.unfit { color: var(--red); border-color: rgba(248,81,73,0.4); }
    .title { font-size: 1em; font-weight: 500; }
    .title a { color: var(--accent); text-decoration: none; }
    .title a:hover { text-decoration: underline; }
    .meta { color: var(--muted); font-size: 0.82em; }
    .reasoning { color: #b1bac4; font-size: 0.85em; line-height: 1.4; margin-top: 0.4em; max-height: 0; overflow: hidden; transition: max-height 0.15s; }
    .reasoning.open { max-height: 400px; }
    .actions { display: flex; gap: 0.3em; margin-top: 0.5em; flex-wrap: wrap; }
    .actions button { padding: 0.2em 0.6em; border: 1px solid var(--border); border-radius: 4px; background: transparent; color: var(--text); cursor: pointer; font-size: 0.78em; font-family: inherit; }
    .actions button:hover { background: var(--panel-2); }
    .actions kbd { font-size: 0.7em; opacity: 0.6; margin-left: 0.2em; }
    .btn-applied { border-color: rgba(63,185,80,0.5) !important; color: var(--green) !important; }
    .btn-interested { border-color: rgba(88,166,255,0.5) !important; color: var(--blue) !important; }
    .btn-not { border-color: rgba(248,81,73,0.5) !important; color: var(--red) !important; }
    .btn-fp { border-color: rgba(210,153,34,0.5) !important; color: var(--yellow) !important; }
    .btn-clear { border-color: var(--border) !important; color: var(--muted) !important; margin-left: auto; }

    .empty { background: var(--panel); border: 1px dashed var(--border); border-radius: 8px; padding: 2em; text-align: center; color: var(--muted); }
    .empty strong { color: var(--text); display: block; margin-bottom: 0.4em; }

    /* TOAST */
    .toast { position: fixed; bottom: 1em; left: 50%; transform: translateX(-50%); background: var(--panel); border: 1px solid var(--border); border-radius: 6px; padding: 0.5em 1em; color: var(--text); font-size: 0.85em; opacity: 0; transition: opacity 0.2s; pointer-events: none; }
    .toast.show { opacity: 1; }
    .toast .undo-link { color: var(--accent); cursor: pointer; margin-left: 0.6em; text-decoration: underline; }
  </style>
</head>
<body>
<div class="container">
  <h1><span class="live"></span> Trawler</h1>
  <div class="subhead" id="loop-status">connecting…</div>

  <div class="stats" id="stats"></div>

  <div class="toolbar">
    <div class="toolbar-group">
      <span class="toolbar-label">Show</span>
      <button class="chip" data-filter="unlabeled">Unlabeled <span class="ct" id="ct-unlabeled">0</span></button>
      <button class="chip" data-filter="all">All <span class="ct" id="ct-all">0</span></button>
      <button class="chip" data-filter="acted">Applied/Interested <span class="ct" id="ct-acted">0</span></button>
      <button class="chip" data-filter="passed">Passed <span class="ct" id="ct-passed">0</span></button>
    </div>
    <div class="toolbar-group">
      <span class="toolbar-label">Tier</span>
      <button class="chip" data-band="push">Push <span class="ct" id="ct-push">0</span></button>
      <button class="chip" data-band="digest">Digest <span class="ct" id="ct-digest">0</span></button>
      <button class="chip" data-band="both">Both</button>
    </div>
    <div class="toolbar-group">
      <span class="toolbar-label">Sort</span>
      <select id="sort">
        <option value="newest">Newest first</option>
        <option value="score">Highest score</option>
      </select>
    </div>
    <button class="help-btn" id="help-btn">? shortcuts</button>
  </div>

  <div class="list" id="list"></div>
</div>

<div class="help" id="help">
  <div class="help-card">
    <h2>Keyboard shortcuts</h2>
    <div class="row"><span>navigate</span><span><kbd>J</kbd> / <kbd>↓</kbd> next, <kbd>K</kbd> / <kbd>↑</kbd> prev</span></div>
    <div class="row"><span>label applied</span><span><kbd>A</kbd> or <kbd>1</kbd></span></div>
    <div class="row"><span>label interested</span><span><kbd>I</kbd> or <kbd>2</kbd></span></div>
    <div class="row"><span>label not interested</span><span><kbd>N</kbd> or <kbd>3</kbd></span></div>
    <div class="row"><span>label false positive</span><span><kbd>F</kbd> or <kbd>4</kbd></span></div>
    <div class="row"><span>clear label</span><span><kbd>0</kbd></span></div>
    <div class="row"><span>open job link</span><span><kbd>O</kbd> or <kbd>Enter</kbd></span></div>
    <div class="row"><span>toggle reasoning</span><span><kbd>Space</kbd></span></div>
    <div class="row"><span>refresh</span><span><kbd>R</kbd></span></div>
    <div class="row"><span>close help</span><span><kbd>Esc</kbd> or <kbd>?</kbd></span></div>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const STATE = { snapshot: null, filter: 'unlabeled', band: 'push', sort: 'newest', focusKey: null, view: [] };
const LABEL_KEYS = { applied: 'a', interested: 'i', not_interested: 'n', false_positive: 'f' };

// Persist UI prefs
const prefs = JSON.parse(localStorage.getItem('trawler-prefs') || '{}');
if (prefs.filter) STATE.filter = prefs.filter;
if (prefs.band) STATE.band = prefs.band;
if (prefs.sort) STATE.sort = prefs.sort;

function savePrefs() {
  localStorage.setItem('trawler-prefs', JSON.stringify({ filter: STATE.filter, band: STATE.band, sort: STATE.sort }));
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function timeAgo(ms) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function fetchState() {
  const res = await fetch('/api/state');
  if (!res.ok) return;
  STATE.snapshot = await res.json();
  render();
}

function applyFilters() {
  if (!STATE.snapshot) return [];
  let xs = STATE.snapshot.matches.filter(m => m.hard_failures.length === 0);

  if (STATE.band === 'push') xs = xs.filter(m => m.score >= 70);
  else if (STATE.band === 'digest') xs = xs.filter(m => m.score >= 40 && m.score < 70);
  else xs = xs.filter(m => m.score >= 40);

  if (STATE.filter === 'unlabeled') xs = xs.filter(m => !m.label);
  else if (STATE.filter === 'acted') xs = xs.filter(m => m.label === 'applied' || m.label === 'interested');
  else if (STATE.filter === 'passed') xs = xs.filter(m => m.label === 'not_interested' || m.label === 'false_positive');

  if (STATE.sort === 'newest') xs.sort((a, b) => b.added_at - a.added_at || b.score - a.score);
  else xs.sort((a, b) => b.score - a.score || b.added_at - a.added_at);

  return xs;
}

function counts() {
  if (!STATE.snapshot) return {};
  const all = STATE.snapshot.matches.filter(m => m.hard_failures.length === 0);
  const inBand = STATE.band === 'push' ? all.filter(m => m.score >= 70)
    : STATE.band === 'digest' ? all.filter(m => m.score >= 40 && m.score < 70)
    : all.filter(m => m.score >= 40);
  return {
    unlabeled: inBand.filter(m => !m.label).length,
    all: inBand.length,
    acted: inBand.filter(m => m.label === 'applied' || m.label === 'interested').length,
    passed: inBand.filter(m => m.label === 'not_interested' || m.label === 'false_positive').length,
    push: all.filter(m => m.score >= 70).length,
    digest: all.filter(m => m.score >= 40 && m.score < 70).length,
  };
}

function renderStats() {
  const s = STATE.snapshot.stats;
  document.getElementById('stats').innerHTML = [
    '<div class="stat"><span class="num">' + s.unlabeled_push + '</span><span class="lbl">to triage</span></div>',
    s.new_push > 0 ? '<div class="stat green"><span class="num">' + s.new_push + '</span><span class="lbl">new since visit</span></div>' : '',
    '<div class="stat blue"><span class="num">' + s.labeled_today + '</span><span class="lbl">labeled today</span></div>',
    '<div class="stat"><span class="num">' + s.push + '</span><span class="lbl">push</span></div>',
    '<div class="stat"><span class="num">' + s.digest + '</span><span class="lbl">digest</span></div>',
    '<div class="stat"><span class="num">' + s.labeled_total + '</span><span class="lbl">labeled total</span></div>',
  ].join('');

  const loop = STATE.snapshot.loop;
  if (loop) {
    const ago = loop.lastTickAt > 0 ? timeAgo(loop.lastTickAt) : 'pending';
    document.getElementById('loop-status').innerHTML =
      'matching loop: ticks=' + loop.ticks + ' · qualified=' + loop.jobsQualified +
      ' · push=' + loop.pushFound + ' · digest=' + loop.digestFound +
      ' · last tick ' + ago + ' (<code>' + escapeHtml(loop.lastTickStatus) + '</code>)';
  }
}

function renderToolbar() {
  document.querySelectorAll('[data-filter]').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === STATE.filter);
  });
  document.querySelectorAll('[data-band]').forEach(el => {
    el.classList.toggle('active', el.dataset.band === STATE.band);
  });
  document.getElementById('sort').value = STATE.sort;

  const c = counts();
  document.getElementById('ct-unlabeled').textContent = c.unlabeled;
  document.getElementById('ct-all').textContent = c.all;
  document.getElementById('ct-acted').textContent = c.acted;
  document.getElementById('ct-passed').textContent = c.passed;
  document.getElementById('ct-push').textContent = c.push;
  document.getElementById('ct-digest').textContent = c.digest;
}

function renderCard(m, focused) {
  const labelClass = m.label ? ('label-' + m.label) : '';
  const labelText = m.label ? m.label.replace('_', ' ') : '';
  const llm = m.llm_verdict ? '<span class="llm-badge ' + m.llm_verdict + '">opus: ' + m.llm_verdict + '</span>' : '';
  const newBadge = m.is_new ? '<span class="new-badge">NEW</span>' : '';
  const reasoning = m.reasoning ? '<div class="reasoning' + (focused ? ' open' : '') + '">' + escapeHtml(m.reasoning) + '</div>' : '';

  return '<div class="card ' + (m.score >= 70 ? 'push' : 'digest') + (focused ? ' focused' : '') + (m.label ? ' labeled' : '') + '" data-key="' + escapeHtml(m.key) + '">' +
    '<div class="card-row">' +
      '<span class="score">' + m.score + '</span>' +
      newBadge +
      (m.label ? '<span class="label-badge ' + labelClass + '">' + labelText + '</span>' : '') +
      llm +
    '</div>' +
    '<div class="card-row">' +
      '<span class="title"><a href="' + escapeHtml(m.url || '#') + '" target="_blank" rel="noopener">' + escapeHtml(m.title) + '</a></span>' +
    '</div>' +
    '<div class="meta">' + escapeHtml(m.company_slug) + (m.location ? ' · ' + escapeHtml(m.location) : '') + ' · added ' + timeAgo(m.added_at) + '</div>' +
    reasoning +
    '<div class="actions">' +
      '<button class="btn-applied" data-action="applied">Applied <kbd>A</kbd></button>' +
      '<button class="btn-interested" data-action="interested">Interested <kbd>I</kbd></button>' +
      '<button class="btn-not" data-action="not_interested">Not <kbd>N</kbd></button>' +
      '<button class="btn-fp" data-action="false_positive">FP <kbd>F</kbd></button>' +
      (m.label ? '<button class="btn-clear" data-action="clear">Clear <kbd>0</kbd></button>' : '') +
    '</div>' +
  '</div>';
}

function render() {
  if (!STATE.snapshot) return;
  renderStats();
  renderToolbar();

  STATE.view = applyFilters();
  if (STATE.view.length === 0) {
    const s = STATE.snapshot.stats;
    let title = 'Nothing matches your filters';
    let msg = 'Try a different filter or tier above.';
    let cta = '';

    if (STATE.filter === 'unlabeled' && STATE.band === 'push') {
      if (s.unlabeled_digest > 0) {
        title = 'All ' + s.push + ' push matches labeled';
        msg = s.unlabeled_digest + ' digest match' + (s.unlabeled_digest === 1 ? '' : 'es') + ' still waiting (40–69 score). Lower bar, but worth a look.';
        cta = '<button class="chip active" data-cta="digest" style="margin-top:0.8em">Show digest queue →</button>';
      } else {
        title = 'You\\'re caught up';
        msg = 'All ' + s.push + ' push and ' + s.digest + ' digest matches labeled. The matching loop is qualifying new jobs in the background — check back later or look at already-labeled jobs to revisit.';
      }
    } else if (STATE.filter === 'unlabeled' && s.unlabeled_push + s.unlabeled_digest === 0) {
      title = 'You\\'re caught up';
      msg = 'No unlabeled matches in any tier. The matching loop will surface new ones as they\\'re qualified.';
    } else if (STATE.filter !== 'all') {
      const filterName = { acted: 'applied/interested', passed: 'not interested/false positive', unlabeled: 'unlabeled' }[STATE.filter] || STATE.filter;
      msg = 'No ' + filterName + ' matches in the ' + STATE.band + ' tier.';
    }

    document.getElementById('list').innerHTML = '<div class="empty"><strong>' + title + '</strong>' + msg + cta + '</div>';
    STATE.focusKey = null;
    return;
  }

  // Maintain focus if possible
  if (!STATE.focusKey || !STATE.view.find(m => m.key === STATE.focusKey)) {
    STATE.focusKey = STATE.view[0].key;
  }

  document.getElementById('list').innerHTML = STATE.view.map(m => renderCard(m, m.key === STATE.focusKey)).join('');

  const focusEl = document.querySelector('.card.focused');
  if (focusEl) {
    const r = focusEl.getBoundingClientRect();
    if (r.top < 80 || r.bottom > window.innerHeight - 40) focusEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

let lastAction = null; // for undo

function showToast(msg, undoFn) {
  const t = document.getElementById('toast');
  t.innerHTML = escapeHtml(msg) + (undoFn ? ' <span class="undo-link" id="undo-link">undo</span>' : '');
  t.classList.add('show');
  if (undoFn) document.getElementById('undo-link').onclick = () => { undoFn(); t.classList.remove('show'); };
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => t.classList.remove('show'), 4000);
}

async function applyLabel(key, value) {
  const m = STATE.snapshot.matches.find(x => x.key === key);
  if (!m) return;
  const prev = m.label;
  m.label = value;
  STATE.snapshot.labels[key] = { key, value, timestamp: new Date().toISOString() };
  if (!prev) STATE.snapshot.stats.labeled_today++;
  STATE.snapshot.stats.labeled_total = Object.keys(STATE.snapshot.labels).length;

  // Move focus to next match in view BEFORE re-render so we follow through the queue
  const idx = STATE.view.findIndex(x => x.key === key);
  STATE.view = applyFilters();
  if (STATE.view.length > 0) {
    const next = STATE.view[Math.min(idx, STATE.view.length - 1)];
    STATE.focusKey = next?.key ?? null;
  } else {
    STATE.focusKey = null;
  }
  render();

  lastAction = { key, prev };
  showToast('Labeled "' + value.replace('_', ' ') + '"', () => {
    if (prev) clearLabel(key, prev);
    else clearLabel(key, null);
  });

  await fetch('/api/label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value }),
  });
}

async function clearLabel(key, restoreTo) {
  const m = STATE.snapshot.matches.find(x => x.key === key);
  if (!m) return;
  m.label = restoreTo || null;
  if (restoreTo) {
    STATE.snapshot.labels[key] = { key, value: restoreTo, timestamp: new Date().toISOString() };
    await fetch('/api/label', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: restoreTo }) });
  } else {
    delete STATE.snapshot.labels[key];
    STATE.snapshot.stats.labeled_total = Object.keys(STATE.snapshot.labels).length;
    await fetch('/api/label', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) });
  }
  render();
}

function navigate(delta) {
  if (STATE.view.length === 0) return;
  const idx = STATE.view.findIndex(m => m.key === STATE.focusKey);
  const next = Math.max(0, Math.min(STATE.view.length - 1, (idx < 0 ? 0 : idx) + delta));
  STATE.focusKey = STATE.view[next].key;
  render();
}

function openFocused() {
  const m = STATE.view.find(x => x.key === STATE.focusKey);
  if (m && m.url) window.open(m.url, '_blank', 'noopener');
}

function toggleReasoning() {
  const focused = document.querySelector('.card.focused .reasoning');
  if (focused) focused.classList.toggle('open');
}

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  const key = e.key.toLowerCase();
  if (key === '?' || (key === 'escape' && document.getElementById('help').classList.contains('open'))) {
    document.getElementById('help').classList.toggle('open');
    e.preventDefault(); return;
  }
  if (document.getElementById('help').classList.contains('open')) return;

  if (key === 'j' || key === 'arrowdown') { navigate(1); e.preventDefault(); }
  else if (key === 'k' || key === 'arrowup') { navigate(-1); e.preventDefault(); }
  else if (key === 'a' || key === '1') { if (STATE.focusKey) applyLabel(STATE.focusKey, 'applied'); e.preventDefault(); }
  else if (key === 'i' || key === '2') { if (STATE.focusKey) applyLabel(STATE.focusKey, 'interested'); e.preventDefault(); }
  else if (key === 'n' || key === '3') { if (STATE.focusKey) applyLabel(STATE.focusKey, 'not_interested'); e.preventDefault(); }
  else if (key === 'f' || key === '4') { if (STATE.focusKey) applyLabel(STATE.focusKey, 'false_positive'); e.preventDefault(); }
  else if (key === '0') { if (STATE.focusKey) clearLabel(STATE.focusKey, null); e.preventDefault(); }
  else if (key === 'o' || key === 'enter') { openFocused(); e.preventDefault(); }
  else if (key === ' ') { toggleReasoning(); e.preventDefault(); }
  else if (key === 'r') { fetchState(); e.preventDefault(); }
  else if (key === 'u' && lastAction) { clearLabel(lastAction.key, lastAction.prev); lastAction = null; e.preventDefault(); }
});

document.addEventListener('click', e => {
  const card = e.target.closest('.card');
  if (card) {
    STATE.focusKey = card.dataset.key;
    const action = e.target.dataset.action;
    if (action === 'clear') { clearLabel(STATE.focusKey, null); return; }
    if (action) { applyLabel(STATE.focusKey, action); return; }
    render();
  }
  const f = e.target.closest('[data-filter]');
  if (f) { STATE.filter = f.dataset.filter; savePrefs(); render(); }
  const b = e.target.closest('[data-band]');
  if (b) { STATE.band = b.dataset.band; savePrefs(); render(); }
  const cta = e.target.closest('[data-cta]');
  if (cta) {
    if (cta.dataset.cta === 'digest') { STATE.band = 'digest'; savePrefs(); render(); }
  }
});

document.getElementById('sort').addEventListener('change', e => {
  STATE.sort = e.target.value;
  savePrefs();
  render();
});

document.getElementById('help-btn').addEventListener('click', () => {
  document.getElementById('help').classList.toggle('open');
});
document.getElementById('help').addEventListener('click', e => {
  if (e.target.id === 'help') document.getElementById('help').classList.remove('open');
});

// Initial fetch + auto-refresh
fetchState();
setInterval(fetchState, 30_000);

// Mark seen on first interaction so the "new since visit" stat resets
let markedSeen = false;
function markSeen() {
  if (markedSeen) return;
  markedSeen = true;
  fetch('/api/seen', { method: 'POST' });
}
document.addEventListener('keydown', markSeen, { once: true });
document.addEventListener('click', markSeen, { once: true });
</script>
</body>
</html>`;

function renderMatchingPrometheus(loop?: MatchingLoop): string {
  const snap = buildSnapshot(loop);
  const out: string[] = [];

  function emit(name: string, type: string, help: string, samples: Array<{ labels?: Record<string, string>; value: number }>) {
    out.push(`# HELP ${name} ${help}`);
    out.push(`# TYPE ${name} ${type}`);
    for (const s of samples) {
      const ls = s.labels && Object.keys(s.labels).length
        ? '{' + Object.entries(s.labels).map(([k, v]) => `${k}="${v.replace(/"/g, '\\"')}"`).join(',') + '}' : '';
      out.push(`${name}${ls} ${s.value}`);
    }
  }

  // Loop counters (if attached)
  if (loop) {
    emit('trawler_matching_loop_ticks_total', 'counter', 'Matching loop ticks since process start.', [{ value: loop.ticks }]);
    emit('trawler_matching_loop_jobs_qualified_total', 'counter', 'Jobs qualified by the LLM since process start.', [{ value: loop.jobsQualified }]);
    emit('trawler_matching_loop_push_found_total', 'counter', 'Push matches found since process start.', [{ value: loop.pushFound }]);
    emit('trawler_matching_loop_digest_found_total', 'counter', 'Digest matches found since process start.', [{ value: loop.digestFound }]);
    if (loop.lastTickAt > 0) {
      emit('trawler_matching_loop_last_tick_seconds', 'gauge', 'Seconds since the last loop tick completed.',
        [{ value: Math.floor((Date.now() - loop.lastTickAt) / 1000) }]);
    }
  }

  // Match queue (the things the user actually sees)
  emit('trawler_matches_total', 'gauge', 'Total matches in the dashboard (push + digest + skip).', [{ value: snap.stats.total }]);
  emit('trawler_matches_push', 'gauge', 'Matches at push tier (score >= 70).', [{ value: snap.stats.push }]);
  emit('trawler_matches_digest', 'gauge', 'Matches at digest tier (40 <= score < 70).', [{ value: snap.stats.digest }]);
  emit('trawler_matches_unlabeled', 'gauge', 'Matches the user has not yet labeled.',
    [{ labels: { tier: 'push' }, value: snap.stats.unlabeled_push },
     { labels: { tier: 'digest' }, value: snap.stats.unlabeled_digest }]);
  emit('trawler_matches_new_since_view', 'gauge', 'New push matches since last_viewed_at.', [{ value: snap.stats.new_push }]);
  emit('trawler_labels_total', 'gauge', 'Total labels recorded.', [{ value: snap.stats.labeled_total }]);
  emit('trawler_labels_today', 'gauge', 'Labels recorded since UTC midnight today.', [{ value: snap.stats.labeled_today }]);

  return out.join('\n') + '\n';
}

export interface MatchingDashboardConfig {
  port?: number;
  host?: string;
  loop?: MatchingLoop;
}

export function startMatchingDashboard(cfg: MatchingDashboardConfig = {}): void {
  const port = cfg.port ?? 3002;
  const host = cfg.host ?? '127.0.0.1';
  const loop = cfg.loop;

  const server = createServer((req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url === '/matches')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    // /favicon.ico — most browsers ask for it independently of the <link>
    // we set in the page. Serve an inline SVG (same icon as the page <link>)
    // so it shows up in the tab even when the link header is ignored.
    if (req.method === 'GET' && req.url === '/favicon.ico') {
      const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0d1117"/><g fill="none" stroke="#58a6ff" stroke-width="3" stroke-linecap="round"><path d="M14 22 L32 30 L50 22"/><path d="M14 32 L32 40 L50 32"/><path d="M14 42 L32 50 L50 42"/></g><circle cx="32" cy="15" r="4" fill="#3fb950"/></svg>';
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(FAVICON);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(buildSnapshot(loop)));
      return;
    }

    // Prometheus exposition for matching subsystem
    if (req.method === 'GET' && req.url === '/metrics') {
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(renderMatchingPrometheus(loop));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/label') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { key, value } = JSON.parse(body);
          const labels = loadLabels();
          labels[key] = { key, value, timestamp: new Date().toISOString() };
          saveLabels(labels);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end('bad request');
        }
      });
      return;
    }

    if (req.method === 'DELETE' && req.url === '/api/label') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const { key } = JSON.parse(body);
          const labels = loadLabels();
          delete labels[key];
          saveLabels(labels);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch {
          res.writeHead(400); res.end('bad request');
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/api/seen') {
      saveState({ last_viewed_at: new Date().toISOString() });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(port, host, () => {
    console.log(`Trawler matches: http://${host}:${port}`);
  });
}

async function standalone() {
  const port = parseInt(process.argv.find(a => a.startsWith('--port'))?.split('=')[1] ?? '3002', 10);
  const host = process.argv.find(a => a.startsWith('--host'))?.split('=')[1] ?? '0.0.0.0';
  startMatchingDashboard({ port, host });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  standalone().catch(e => { console.error(e); process.exit(1); });
}
