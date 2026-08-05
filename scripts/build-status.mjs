#!/usr/bin/env node
//
// Probes every dependency, folds in the data-integrity result, and updates
// status/history.json — the single file the status page renders from.
//
//   node scripts/build-status.mjs
//
// DESIGN NOTE: the status page is served from GitHub Pages and reads a static
// JSON file. It deliberately shares no infrastructure with the app it monitors.
// A status page that goes down with the service it reports on is decoration,
// not observability.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const HISTORY = 'status/history.json';
const PROJECT = process.env.FIREBASE_PROJECT_ID || 'expense-manager-204';
const BUCKET = `${PROJECT}.firebasestorage.app`;
const APP_URL = process.env.APP_URL || `https://${PROJECT}.web.app/`;
// ~90 days of 30-minute samples.
const MAX_SAMPLES = 4320;

const COMPONENTS = [
  {
    id: 'app',
    name: 'Web App',
    description: 'The FlatMate app itself, served from Firebase Hosting',
    url: APP_URL,
    okStatuses: [200],
  },
  {
    id: 'firestore',
    name: 'Database (Firestore)',
    description: 'Where every expense, deposit and bill is stored',
    url: `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/_health`,
    // 401/403 means "reachable and correctly refusing an unauthenticated
    // request" — which is exactly what a healthy, properly secured API does.
    okStatuses: [200, 401, 403],
  },
  {
    id: 'auth',
    name: 'Sign-In (Google)',
    description: 'Google authentication used to sign in',
    url: 'https://identitytoolkit.googleapis.com/v1/projects',
    okStatuses: [200, 401, 403],
  },
  {
    id: 'storage',
    name: 'Receipt Storage',
    description: 'Uploaded bill and receipt images',
    url: `https://firebasestorage.googleapis.com/v0/b/${BUCKET}/o?maxResults=1`,
    okStatuses: [200, 401, 403],
  },
];

async function probe(component) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(component.url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'flatmate-status-probe' },
    });
    const ms = Date.now() - started;
    const up = component.okStatuses.includes(res.status);
    return {
      state: up ? 'up' : 'down',
      httpStatus: res.status,
      latencyMs: ms,
      // A service that answers, but slowly, is degraded rather than down.
      degraded: up && ms > 3000,
    };
  } catch (err) {
    return {
      state: 'down',
      httpStatus: null,
      latencyMs: Date.now() - started,
      error: err.name === 'AbortError' ? 'timed out after 10s' : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

// Runs the integrity checker as a subprocess so its exit code (1 on failure)
// does not take this script down with it.
async function integrity() {
  try {
    const { stdout } = await run('node', ['scripts/integrity-check.mjs', '--json', '--publish'], {
      maxBuffer: 20 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (err) {
    // Exit code 1 = checks failed but the report is still valid JSON on stdout.
    if (err.stdout) {
      try { return JSON.parse(err.stdout); } catch { /* fall through */ }
    }
    const raw = (err.stderr || err.message || '').trim();
    // Translate the two failures that actually happen into something actionable,
    // rather than surfacing a Node stack trace on a status page.
    let reason;
    if (/ERR_MODULE_NOT_FOUND|Cannot find package/.test(raw)) {
      reason = 'Dependencies are not installed — run `npm install` before checking integrity.';
    } else if (/credential|GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_SERVICE_ACCOUNT|UNAUTHENTICATED|PERMISSION_DENIED/i.test(raw)) {
      reason = 'No usable Firebase credentials — set FIREBASE_SERVICE_ACCOUNT or GOOGLE_APPLICATION_CREDENTIALS (see SETUP.md).';
    } else {
      reason = raw.split('\n').filter(Boolean).slice(0, 2).join(' ').slice(0, 300);
    }
    return {
      status: 'unknown',
      checkedAt: new Date().toISOString(),
      error: reason,
      summary: { total: 0, passed: 0, warnings: 0, failures: 0 },
      checks: [],
    };
  }
}

async function main() {
  await mkdir('status', { recursive: true });

  let prev = { history: [], incidents: [] };
  if (existsSync(HISTORY)) {
    try { prev = JSON.parse(await readFile(HISTORY, 'utf8')); } catch { /* start fresh */ }
  }

  const now = new Date().toISOString();
  const results = {};
  for (const c of COMPONENTS) results[c.id] = await probe(c);

  const health = await integrity();

  // Overall status. Data integrity failing is a MAJOR issue even when every
  // endpoint is green: the app is up and confidently showing wrong numbers,
  // which is worse than being down, because nobody knows to distrust it.
  const anyDown = Object.values(results).some((r) => r.state === 'down');
  const anyDegraded = Object.values(results).some((r) => r.degraded);
  // 'unknown' counts as degraded, never as operational. Not knowing whether the
  // books reconcile is not the same as knowing they do.
  const overall =
    anyDown || health.status === 'fail'
      ? 'major_outage'
      : anyDegraded || health.status === 'warn' || health.status === 'unknown'
      ? 'degraded'
      : 'operational';

  const sample = {
    t: now,
    c: Object.fromEntries(
      Object.entries(results).map(([id, r]) => [id, r.state === 'up' ? (r.degraded ? 'deg' : 'up') : 'down'])
    ),
    i: health.status,
  };

  const history = [...(prev.history || []), sample].slice(-MAX_SAMPLES);

  // Incident tracking: record the transitions, not every sample.
  const incidents = [...(prev.incidents || [])];
  const lastSample = (prev.history || []).at(-1);
  for (const c of COMPONENTS) {
    const was = lastSample?.c?.[c.id];
    const is = sample.c[c.id];
    if (was && was !== 'down' && is === 'down') {
      incidents.unshift({
        component: c.id,
        componentName: c.name,
        startedAt: now,
        endedAt: null,
        detail: results[c.id].error || `HTTP ${results[c.id].httpStatus}`,
      });
    } else if (was === 'down' && is !== 'down') {
      const open = incidents.find((i) => i.component === c.id && !i.endedAt);
      if (open) open.endedAt = now;
    }
  }
  if (lastSample?.i !== 'fail' && sample.i === 'fail') {
    incidents.unshift({
      component: 'integrity',
      componentName: 'Data Integrity',
      startedAt: now,
      endedAt: null,
      detail: (health.checks || []).filter((c) => c.status === 'fail').map((c) => c.name).join('; ') || 'Integrity checks failing',
    });
  } else if (lastSample?.i === 'fail' && sample.i !== 'fail') {
    const open = incidents.find((i) => i.component === 'integrity' && !i.endedAt);
    if (open) open.endedAt = now;
  }

  // Uptime over the retained window.
  const uptime = {};
  for (const c of COMPONENTS) {
    const seen = history.filter((h) => h.c?.[c.id]);
    const up = seen.filter((h) => h.c[c.id] !== 'down').length;
    uptime[c.id] = seen.length ? Math.round((up / seen.length) * 10000) / 100 : 100;
  }

  const out = {
    updatedAt: now,
    project: PROJECT,
    overall,
    components: COMPONENTS.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      state: results[c.id].degraded ? 'degraded' : results[c.id].state,
      latencyMs: results[c.id].latencyMs,
      httpStatus: results[c.id].httpStatus,
      error: results[c.id].error || null,
      uptime90d: uptime[c.id],
    })),
    integrity: {
      status: health.status,
      checkedAt: health.checkedAt,
      summary: health.summary,
      totals: health.totals || null,
      failing: (health.checks || []).filter((c) => c.status !== 'pass')
        .map((c) => ({ name: c.name, status: c.status, detail: c.detail })),
      error: health.error || null,
    },
    incidents: incidents.slice(0, 50),
    history,
  };

  await writeFile(HISTORY, JSON.stringify(out, null, 2));

  console.log(`Status: ${overall.toUpperCase()}  (integrity: ${health.status})`);
  for (const c of out.components) {
    console.log(`  ${c.state === 'up' ? 'OK  ' : c.state === 'degraded' ? 'SLOW' : 'DOWN'} ` +
                `${c.name.padEnd(22)} ${String(c.latencyMs).padStart(5)}ms  ${c.uptime90d}% uptime`);
  }
  console.log(`\nWrote ${HISTORY} (${history.length} samples retained).`);
}

main().catch((err) => {
  console.error(`build-status failed: ${err.message}`);
  process.exit(1);
});
