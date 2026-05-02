// ─────────────────────────────────────────────────────────────────────────────
// LOCATION DISPLAY HELPERS
//
// `loc === 'west' ? 'Sering West' : 'Sering Centraal'` was duplicated 30+
// times across planner.ts, orders.ts, dashboard.ts. Single source here.
// ─────────────────────────────────────────────────────────────────────────────

import type { Location } from './types';

const LOCATION_LABELS: Record<Location, string> = {
  west: 'Sering West',
  centraal: 'Sering Centraal',
};

/** Display name for a location key. Accepts the raw `Location` literal or
 *  any string for legacy tolerance; returns the fallback "Sering Centraal"
 *  for unknown values to match the original ternary's behaviour. */
export function locName(loc: Location | string): string {
  if (loc === 'west' || loc === 'centraal') return LOCATION_LABELS[loc];
  // Legacy ternary returned 'Sering Centraal' for anything that wasn't 'west'.
  // Preserved here so swap-in doesn't change any rendered label by accident.
  return 'Sering Centraal';
}
