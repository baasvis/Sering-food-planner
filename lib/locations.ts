// ─────────────────────────────────────────────────────────────────────────────
// EVENT-LOCATION REGISTRY CACHE (backend)
//
// In-memory cache of the event_locations table so hot-path validators
// (validateBatch runs on every /api/data/patch) stay a pure Set lookup with
// no DB read. PURE CACHE — no prisma import here; lib/db.ts hydrates it
// (dbLoadEventLocations) at boot, after every registry write, and passively
// on every dbReadAll. Single-replica assumption (like the SSE registry and
// write locks — see CLAUDE.md's single-dyno list): another replica's registry
// write would not invalidate this process's cache.
//
// Two validity classes, used by the write-path validators:
//   KNOWN  = permanent ∪ ALL event slugs (incl. archived) — persisted state
//            (batch inventory/services/shipments, guest rows) must keep
//            validating after an event is archived.
//   ACTIVE = permanent ∪ non-archived slugs — targets for NEW writes (ship
//            toLoc, guest edits, ritual completions, supply stock moves).
// ─────────────────────────────────────────────────────────────────────────────

import type { EventLocationDTO } from '../shared/types';
import { PERMANENT_LOCATIONS, setLocationRegistry } from '../shared/location';

let _rows: EventLocationDTO[] = [];
let _knownSet = new Set<string>(PERMANENT_LOCATIONS);
let _activeSet = new Set<string>(PERMANENT_LOCATIONS);

/** Replace the cached registry (called by lib/db.ts dbLoadEventLocations and
 *  by tests for deterministic setup). Also refreshes the shared display-name
 *  registry so backend locName() calls resolve event names. */
export function setEventLocations(rows: EventLocationDTO[]): void {
  _rows = rows.slice();
  _knownSet = new Set<string>(PERMANENT_LOCATIONS);
  _activeSet = new Set<string>(PERMANENT_LOCATIONS);
  for (const r of _rows) {
    _knownSet.add(r.slug);
    if (!r.archived) _activeSet.add(r.slug);
  }
  setLocationRegistry(_rows);
}

/** Permanent ∪ all event slugs, incl. archived (see header). O(1). */
export function isKnownLocation(loc: string): boolean {
  return _knownSet.has(loc);
}

/** Permanent ∪ non-archived event slugs (see header). O(1). */
export function isActiveLocation(loc: string): boolean {
  return _activeSet.has(loc);
}

/** Non-archived event slugs, registry order. */
export function activeEventSlugs(): string[] {
  return _rows.filter(r => !r.archived).map(r => r.slug);
}

/** ALL event slugs incl. archived, registry order. */
export function allEventSlugs(): string[] {
  return _rows.map(r => r.slug);
}

export function eventLocationRows(): readonly EventLocationDTO[] {
  return _rows;
}

export function getEventLocation(slug: string): EventLocationDTO | undefined {
  return _rows.find(r => r.slug === slug);
}
