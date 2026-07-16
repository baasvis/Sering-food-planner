// ─────────────────────────────────────────────────────────────────────────────
// LOCATION HELPERS — display names + the event-location registry
//
// `loc === 'west' ? 'Sering West' : 'Sering Centraal'` was duplicated 30+
// times across planner.ts, orders.ts, dashboard.ts. Single source here.
//
// Since the event-locations feature, "location" is no longer a closed
// two-value union: temporary event locations (festivals, big caterings) are
// created at runtime and identified by an immutable "ev-…" slug. This module
// holds a process-local copy of those registry rows so locName() can resolve
// their display names. Each bundle (backend CJS, frontend Vite) has its own
// instance: the backend hydrates it at boot + on registry writes
// (lib/locations.ts setEventLocations), the frontend from GET /api/data and
// SSE patches (utils.ts).
// ─────────────────────────────────────────────────────────────────────────────

import type { EventLocationDTO, Location, PermanentLocation } from './types';
export type { EventLocationDTO } from './types';

export const PERMANENT_LOCATIONS: readonly PermanentLocation[] = ['west', 'centraal'] as const;

// Keys that may never be used as an event-location slug. 'testtafel' is the
// finance/Hub venue key (lib/finance-live.ts) — not a planner location, but
// reserved so it can never collide in location-keyed JSON.
export const RESERVED_LOCATION_KEYS: readonly string[] = ['west', 'centraal', 'testtafel'];

export function isPermanentLocation(loc: string): loc is PermanentLocation {
  return loc === 'west' || loc === 'centraal';
}

const LOCATION_LABELS: Record<PermanentLocation, string> = {
  west: 'Sering West',
  centraal: 'Sering Centraal',
};

// Process-local event-location registry.
let _registry: readonly EventLocationDTO[] = [];

export function setLocationRegistry(rows: EventLocationDTO[]): void {
  _registry = rows.slice();
}

export function getLocationRegistry(): readonly EventLocationDTO[] {
  return _registry;
}

/** Display name for a location key. west/centraal keep their fixed labels
 *  (bit-identical to the pre-registry behaviour); event-location slugs
 *  (active OR archived) resolve to the registry row's name; anything unknown
 *  renders as its raw key. (The pre-registry fallback was 'Sering Centraal'
 *  — it only ever fired for values that can't occur in west/centraal call
 *  sites, and a raw key beats silently mislabelling an event as Centraal.) */
export function locName(loc: Location | string): string {
  if (isPermanentLocation(loc)) return LOCATION_LABELS[loc];
  const row = _registry.find(r => r.slug === loc);
  return row ? row.name : String(loc);
}

/** Compact label for chips and tight UI: 'W', 'C', or a 2-char uppercase
 *  abbreviation of the event name (initials of the first two words, else the
 *  first two characters — "Landjuweel 2026" → "L2", "Festival" → "FE"). */
export function shortLocName(loc: Location | string): string {
  if (loc === 'west') return 'W';
  if (loc === 'centraal') return 'C';
  const row = _registry.find(r => r.slug === loc);
  const name = (row ? row.name : String(loc).replace(/^ev-/, '')).trim();
  const words = name.split(/\s+/).filter(Boolean);
  const abbrev = words.length >= 2 ? words[0].charAt(0) + words[1].charAt(0) : name.slice(0, 2);
  return abbrev.toUpperCase() || '?';
}
