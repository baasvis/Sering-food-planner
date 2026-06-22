// ─────────────────────────────────────────────────────────────────────────────
// Fix-My-Menu snapshots
//
// Every time Fix My Menu runs we record three snapshots of the planner state —
// BEFORE the run, AFTER the run, and once more ~30 minutes later — so the
// before state, the algorithm's effect, and the cook's by-hand improvements can
// be compared afterwards. Snapshots are emitted as telemetry events (name
// 'fmm_snapshot', label = phase) with the menu in the data payload, and the
// +30min one is persisted in localStorage so it survives a reload.
// ─────────────────────────────────────────────────────────────────────────────
import { S } from './state';
import { trackEvent } from './telemetry';
import { getTotalStock } from './core';
import type { Batch } from '@shared/types';

const THIRTY_MIN_MS = 30 * 60 * 1000;
const PENDING_KEY = 'sering-fmm-pending-snap';

export interface MenuSnapshot {
  ts: string;
  batches: Array<{
    id: string;
    name: string;
    type: string;
    cookDate: string | null;
    recipeId: string | null;
    generated: boolean;
    liters: number;
    services: Array<{ loc: string; date: string; meal: string }>;
  }>;
  caterings: Array<{
    id: string;
    name: string;
    date: string | null;
    dishes: Array<{ dishId: string; name: string }>;
  }>;
}

/** A compact, comparable snapshot of the menu/plan (batches + caterings). */
export function captureMenuSnapshot(): MenuSnapshot {
  return {
    ts: new Date().toISOString(),
    batches: (S.batches || []).map((b: Batch) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      cookDate: b.cookDate,
      recipeId: b.recipeId,
      generated: !!b.generated,
      liters: Math.round(getTotalStock(b) * 10) / 10,
      services: (b.services || []).map(s => ({ loc: s.loc, date: s.date, meal: s.meal })),
    })),
    caterings: (S.caterings || []).map(c => ({
      id: c.id,
      name: c.name,
      date: c.date,
      dishes: (c.dishes || []).map(d => ({ dishId: d.dishId, name: d.name })),
    })),
  };
}

function emit(runId: string, phase: 'before' | 'after' | 'after30min', snap: MenuSnapshot): void {
  trackEvent('fmm_snapshot', phase, {
    runId,
    phase,
    batchCount: snap.batches.length,
    cateringCount: snap.caterings.length,
    snapshot: snap,
  });
}

interface Pending { runId: string; dueAt: number; }

function readPending(): Pending[] {
  try {
    const a = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(a) ? a : [];
  } catch (_e: unknown) {
    return [];
  }
}
function writePending(list: Pending[]): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); }
  catch (_e: unknown) { /* private-mode browsers throw — best effort only */ }
}

/** Fire the +30min snapshot for runId iff it's still pending (guards against a
 *  double-fire when both the in-session timer and a post-reload re-arm exist). */
function fireThirtyMin(runId: string): void {
  const list = readPending();
  if (!list.some(p => p.runId === runId)) return; // already fired / cancelled
  writePending(list.filter(p => p.runId !== runId));
  emit(runId, 'after30min', captureMenuSnapshot());
}

function schedule(runId: string, dueAt: number): void {
  const delay = Math.max(0, dueAt - Date.now());
  setTimeout(() => fireThirtyMin(runId), delay);
}

/** Called from Fix My Menu: emit the before + after snapshots now and schedule
 *  the +30min one. */
export function recordFixMyMenuSnapshots(before: MenuSnapshot, after: MenuSnapshot): void {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  emit(runId, 'before', before);
  emit(runId, 'after', after);
  const dueAt = Date.now() + THIRTY_MIN_MS;
  const list = readPending();
  list.push({ runId, dueAt });
  writePending(list);
  schedule(runId, dueAt);
}

/** Called at app init: re-arm (or immediately fire) any +30min snapshots that
 *  were still pending when the page last closed. */
export function checkPendingFmmSnapshots(): void {
  const now = Date.now();
  for (const p of readPending()) {
    if (p.dueAt <= now) fireThirtyMin(p.runId);
    else schedule(p.runId, p.dueAt);
  }
}
