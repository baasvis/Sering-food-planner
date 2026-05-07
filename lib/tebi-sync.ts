// ─────────────────────────────────────────────────────────────────────────────
// TEBI SYNC — shared spawn helper for the Playwright scraper.
//
// Both the manual POST /api/finance/sync handler (routes/finance.ts) and the
// nightly cron (server.ts) call this helper. It owns:
//   • spawning scripts/tebi-sync-worker.js with the right env
//   • capturing stdout/stderr tails so failures are diagnosable
//   • emitting telemetry events on completion (success or failure)
//   • tracking in-memory state for /sync-status and cancel
//
// Failures used to be silent: the spawned process would exit non-zero, the
// stderr would be written to the Railway container log only, and nothing
// reached the AI insights pipeline or the Finance UI. After the 2026-03-26
// sync stopped working, the next 31 days of cron runs and 10 manual clicks
// produced zero telemetry signals. This module fixes that observability gap.
// ─────────────────────────────────────────────────────────────────────────────

import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import { addBackendEvent } from '../routes/telemetry';
import { prisma } from './db';
import { redactSecrets } from './config';

export type SyncSource = 'manual' | 'cron';

interface SyncState {
  process: ChildProcess | null;
  timeout: ReturnType<typeof setTimeout> | null;
  output: string;             // accumulated stdout+stderr (capped)
  startedAt: number;          // ms epoch of current run
  source: SyncSource;
  start: string;              // YYYY-MM-DD
  end: string;                // YYYY-MM-DD
  lastSyncAt: string | null;          // ISO timestamp of last successful run
  lastSyncError: string | null;       // human-readable error from last run
  lastSyncErrorDetails: {             // structured detail for AI/devs
    code: number | null;
    stderrTail: string;
    stdoutTail: string;
    durationMs: number;
    source: SyncSource;
    finishedAt: string;
  } | null;
  // Tail of stdout from the most recent SUCCESSFUL run. Persisted alongside
  // `finance_sync_complete` telemetry events so we can diagnose silent
  // partial-failures (where the worker exits 0 but the per-call ✓/✗ logs
  // would tell us something is wrong). Without this, the only place per-call
  // detail lived was Railway container stdout, which evicts after a few days.
  lastSuccessOutputTail: string | null;
}

const state: SyncState = {
  process: null,
  timeout: null,
  output: '',
  startedAt: 0,
  source: 'manual',
  start: '',
  end: '',
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncErrorDetails: null,
  lastSuccessOutputTail: null,
};

// Cap the captured output. The scraper can produce hundreds of KB of debug
// output for a 14-day backfill; keeping the full buffer in memory until the
// next call would slowly leak. Tail is what matters for diagnosis.
const OUTPUT_TAIL_CHARS = 4000;

// Manual-sync timeout. Cron runs aren't bounded — the comment in the previous
// server.ts cron path explicitly says backfills can take several minutes, and
// stale crons are simply replaced by the next nightly tick.
const MANUAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes; was 2 min — too tight for a 14-day backfill

function appendOutput(chunk: string): void {
  state.output += chunk;
  if (state.output.length > OUTPUT_TAIL_CHARS * 2) {
    state.output = state.output.slice(-OUTPUT_TAIL_CHARS * 2);
  }
}

function tail(s: string, n: number): string {
  return s.length <= n ? s : s.slice(-n);
}

export function isSyncing(): boolean {
  return !!state.process;
}

// Hydration cache: a single-flight load of last sync state from telemetry
// after a server restart. Without this, /sync-status returns blank fields
// until the next manual click — exactly the failure mode that hid the
// 31-day silent breakage.
let hydratedOnce = false;
let hydratePromise: Promise<void> | null = null;

async function hydrateFromTelemetry(): Promise<void> {
  if (hydratedOnce) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    // If a sync has already completed in this process, in-memory state is
    // the source of truth — don't read possibly-stale events from DB. The
    // telemetry buffer flushes every 60s, so DB always trails memory.
    if (state.lastSyncAt || state.lastSyncError || state.process) {
      hydratedOnce = true;
      return;
    }
    try {
      // Look back 60 days. Anything older isn't actionable.
      const since = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const lastSuccess = await prisma.telemetryEvent.findFirst({
        where: { type: 'feature_use', name: 'finance_sync_complete', timestamp: { gte: since } },
        orderBy: { timestamp: 'desc' },
      });
      const lastFailure = await prisma.telemetryEvent.findFirst({
        where: {
          type: 'error',
          name: { in: ['finance_sync_failed', 'finance_sync_spawn_error', 'finance_sync_cancelled'] },
          timestamp: { gte: since },
        },
        orderBy: { timestamp: 'desc' },
      });
      if (lastSuccess && (!lastFailure || lastSuccess.timestamp > lastFailure.timestamp)) {
        state.lastSyncAt = lastSuccess.timestamp.toISOString();
        state.lastSyncError = null;
        state.lastSyncErrorDetails = null;
        const successData = (lastSuccess.data as Record<string, unknown> | null) || {};
        state.lastSuccessOutputTail =
          typeof successData.stdoutTail === 'string' ? successData.stdoutTail : null;
      } else if (lastFailure) {
        const d = (lastFailure.data as Record<string, unknown> | null) || {};
        const code = typeof d.code === 'number' ? d.code : null;
        const stderrTail = typeof d.stderrTail === 'string' ? d.stderrTail : '';
        const stdoutTail = typeof d.stdoutTail === 'string' ? d.stdoutTail : '';
        const durationMs = typeof d.durationMs === 'number' ? d.durationMs : 0;
        const source = (d.source === 'cron' ? 'cron' : 'manual') as SyncSource;
        const reason = typeof d.reason === 'string' ? d.reason : null;
        state.lastSyncAt = lastSuccess ? lastSuccess.timestamp.toISOString() : null;
        state.lastSyncError = reason
          ? reason
          : code !== null
            ? `Sync failed (exit code ${code}). ${tail(stderrTail || stdoutTail, 500)}`.trim()
            : `Sync failed (${lastFailure.name})`;
        state.lastSyncErrorDetails = {
          code,
          stderrTail,
          stdoutTail,
          durationMs,
          source,
          finishedAt: lastFailure.timestamp.toISOString(),
        };
      }
    } catch (e) {
      // Hydration is best-effort. If telemetry table isn't reachable, fall
      // through to the empty state that the manual sync flow will fill in.
      console.error('[finance] Hydrate from telemetry failed:', e instanceof Error ? e.message : String(e));
    } finally {
      hydratedOnce = true;
    }
  })();
  return hydratePromise;
}

export async function getStatus(): Promise<{
  syncing: boolean;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorDetails: SyncState['lastSyncErrorDetails'];
  lastSuccessOutputTail: string | null;
  tebiConfigured: boolean;
}> {
  await hydrateFromTelemetry();
  return {
    syncing: !!state.process,
    lastSyncAt: state.lastSyncAt,
    lastSyncError: state.lastSyncError,
    lastSyncErrorDetails: state.lastSyncErrorDetails,
    lastSuccessOutputTail: state.lastSuccessOutputTail,
    tebiConfigured: !!(process.env.TEBI_EMAIL && process.env.TEBI_PASSWORD),
  };
}

export function cancelSync(reason: string): boolean {
  if (!state.process) return false;
  if (state.timeout) { clearTimeout(state.timeout); state.timeout = null; }
  console.log(`[finance] Cancelling sync: ${reason}`);
  // Record the cancellation as a failure so it shows up in the same surface
  // as a real error. The user-facing error message makes it clear this was
  // intentional.
  state.lastSyncError = reason;
  state.lastSyncErrorDetails = {
    code: null,
    stderrTail: '',
    stdoutTail: tail(state.output, OUTPUT_TAIL_CHARS),
    durationMs: state.startedAt ? Date.now() - state.startedAt : 0,
    source: state.source,
    finishedAt: new Date().toISOString(),
  };
  addBackendEvent('error', 'finance_sync_cancelled', {
    reason,
    source: state.source,
    durationMs: state.lastSyncErrorDetails.durationMs,
    start: state.start,
    end: state.end,
  });
  try { state.process.kill('SIGKILL'); } catch (_e) { /* already dead */ }
  state.process = null;
  return true;
}

export interface RunOpts {
  start: string;     // YYYY-MM-DD
  end: string;       // YYYY-MM-DD
  source: SyncSource;
}

export type RunResult =
  | { ok: true; pid?: number }
  | { ok: false; error: string };

/**
 * Spawn the Tebi scraper worker. Returns immediately — the child runs detached.
 * Use getStatus() / addBackendEvent listeners to learn the outcome.
 *
 * Returns ok=false synchronously only when we refuse to start (already running,
 * missing credentials). All runtime errors come through telemetry + getStatus.
 */
export function runTebiSync(opts: RunOpts): RunResult {
  if (state.process) {
    return { ok: false, error: 'Sync already in progress' };
  }
  if (!process.env.TEBI_EMAIL || !process.env.TEBI_PASSWORD) {
    return { ok: false, error: 'TEBI_EMAIL and TEBI_PASSWORD not configured' };
  }

  const workerPath = path.join(process.cwd(), 'scripts', 'tebi-sync-worker.js');
  const args = [workerPath, opts.start, opts.end];

  console.log(`[finance] Starting sync (${opts.source}): ${opts.start} → ${opts.end}`);
  // Reset transient run state. lastSyncAt/lastSyncError stay set from the
  // previous run until this one resolves, so the UI never blanks out.
  state.output = '';
  state.startedAt = Date.now();
  state.source = opts.source;
  state.start = opts.start;
  state.end = opts.end;

  const child = spawn('node', args, {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  state.process = child;

  let stdoutTail = '';
  let stderrTail = '';

  // Worker stdout/stderr is captured here so getStatus() can show diagnostic
  // detail. The Playwright scraper occasionally echoes login form contents
  // (and Tebi's API can echo request bodies in error responses), so we redact
  // password/secret/token patterns before persisting or surfacing.
  child.stdout!.on('data', (data: Buffer) => {
    const s = redactSecrets(data.toString());
    stdoutTail = tail(stdoutTail + s, OUTPUT_TAIL_CHARS);
    appendOutput(s);
    s.trim().split('\n').forEach((line) => { if (line) console.log(`[finance] ${line}`); });
  });

  child.stderr!.on('data', (data: Buffer) => {
    const s = redactSecrets(data.toString());
    stderrTail = tail(stderrTail + s, OUTPUT_TAIL_CHARS);
    appendOutput(s);
    console.error(`[finance] ${s.trim()}`);
  });

  child.on('close', (code: number | null) => {
    if (state.timeout) { clearTimeout(state.timeout); state.timeout = null; }
    const durationMs = Date.now() - state.startedAt;
    console.log(`[finance] Sync finished (${opts.source}, ${durationMs}ms) with code ${code}`);

    if (code === 0) {
      state.lastSyncAt = new Date().toISOString();
      state.lastSyncError = null;
      state.lastSyncErrorDetails = null;
      state.lastSuccessOutputTail = stdoutTail;
      // Carry the per-call ✓/✗ scraper logs into the telemetry event so a
      // silent partial-failure (e.g. only ledger-aggregate rows reaching the
      // DB while per-location and product fetches return empty) is visible
      // post-hoc, even though the worker exited 0.
      addBackendEvent('feature_use', 'finance_sync_complete', {
        source: opts.source,
        durationMs,
        start: opts.start,
        end: opts.end,
        stdoutTail,
        stderrTail,
      });
    } else {
      // Don't overwrite a cancellation message that was set by cancelSync().
      const alreadyCancelled = state.lastSyncErrorDetails?.code === null
        && state.lastSyncErrorDetails?.finishedAt
        && Date.now() - new Date(state.lastSyncErrorDetails.finishedAt).getTime() < 5000;
      if (!alreadyCancelled) {
        state.lastSyncError = `Sync failed (exit code ${code}). ${tail(stderrTail || stdoutTail, 500)}`.trim();
        state.lastSyncErrorDetails = {
          code,
          stderrTail,
          stdoutTail,
          durationMs,
          source: opts.source,
          finishedAt: new Date().toISOString(),
        };
        addBackendEvent('error', 'finance_sync_failed', {
          code,
          source: opts.source,
          durationMs,
          start: opts.start,
          end: opts.end,
          stderrTail,
          stdoutTail,
        });
      }
    }
    state.process = null;
  });

  child.on('error', (e: Error) => {
    // A spawn-time failure (e.g. node not on PATH) — not a child-exit. The
    // close handler still fires after this, so don't double-emit.
    console.error(`[finance] Spawn error: ${e.message}`);
    state.lastSyncError = `Spawn error: ${e.message}`;
    state.lastSyncErrorDetails = {
      code: null,
      stderrTail: e.message,
      stdoutTail,
      durationMs: Date.now() - state.startedAt,
      source: opts.source,
      finishedAt: new Date().toISOString(),
    };
    addBackendEvent('error', 'finance_sync_spawn_error', {
      message: e.message,
      source: opts.source,
      start: opts.start,
      end: opts.end,
    });
  });

  // Manual syncs get a hard timeout; cron runs don't, since a 14-day backfill
  // can legitimately exceed a few minutes and the next nightly tick will
  // start a fresh run anyway.
  if (opts.source === 'manual') {
    state.timeout = setTimeout(() => {
      cancelSync(`Sync timed out after ${Math.round(MANUAL_TIMEOUT_MS / 1000)}s`);
    }, MANUAL_TIMEOUT_MS);
  }

  return { ok: true, pid: child.pid };
}
