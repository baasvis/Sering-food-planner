// ─────────────────────────────────────────────────────────────────────────────
// LABOUR — pure helpers for the live dashboard's planned-labour block.
//
// Today's planned shifts come from the Notion "Sering Shifts" roster
// (lib/notion-shifts.ts does the I/O); this module is the pure maths so it's
// unit-testable. Cost = elapsed shift-hours × a BLENDED €/hr per venue (derived
// from the Hub's WeeklyHours actuals), because the Notion Role names don't line
// up with the Connecteam role names — a blended rate avoids fragile matching.
// "Labour % = hours worked up to this point ÷ revenue so far" (Daan's spec).
// ─────────────────────────────────────────────────────────────────────────────

export interface PlannedShift {
  org: string;       // west | centraal | testtafel
  role: string;
  person: string;
  startMin: number;  // minutes since local midnight
  endMin: number;    // minutes since local midnight; if <= startMin the shift crosses midnight
}

export interface LabourSummary {
  plannedHours: number;
  plannedCost: number | null;   // null when no blended rate is available
  hoursSoFar: number;
  costSoFar: number | null;
  pctOfRevenue: number | null;  // costSoFar / revenueSoFar, null if no revenue or no rate
  headcountOn: number;          // people currently on shift
  ratePerHour: number | null;
  shiftCount: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

// "HH:MM" → minutes since midnight, or null if unparseable.
export function parseHm(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Planned length of a shift in minutes; a shift whose end is <= start crosses
// midnight (e.g. 16:00 → 00:30) and gets +24h.
export function shiftLengthMin(startMin: number, endMin: number): number {
  const end = endMin <= startMin ? endMin + 1440 : endMin;
  return Math.max(0, end - startMin);
}

// Minutes of a shift elapsed by `nowMin` (also handling midnight crossing).
export function shiftElapsedMin(startMin: number, endMin: number, nowMin: number): number {
  const end = endMin <= startMin ? endMin + 1440 : endMin;
  return Math.max(0, Math.min(nowMin, end) - startMin);
}

// Blended €/hr = Σtotal ÷ Σhours over the supplied WeeklyHours rows (one org,
// one week). null if there are no paid hours.
export function blendedRate(rows: { hours: number; total: number }[]): number | null {
  let hours = 0, total = 0;
  for (const r of rows) { hours += r.hours; total += r.total; }
  return hours > 0 ? r2(total / hours) : null;
}

const NOTION_VENUE_TO_ORG: Record<string, string> = {
  'Sering West': 'west',
  'West-Event': 'west',
  'West-Admin': 'west',
  'Catering': 'west',      // catering is cooked/staffed out of West
  'Sering Centraal': 'centraal',
  'TestTafel': 'testtafel',
};

// Map a Notion "Venue" select value to a dashboard org, or null to exclude.
export function orgForNotionVenue(venue: unknown): string | null {
  return (typeof venue === 'string' && NOTION_VENUE_TO_ORG[venue]) || null;
}

// Roll up a venue's shifts into a labour summary at time `nowMin` (minutes
// since local midnight; use a large value to mean "day complete").
export function computeLabour(
  shifts: PlannedShift[],
  ratePerHour: number | null,
  nowMin: number,
  revenueSoFar: number,
): LabourSummary {
  let plannedMin = 0, elapsedMin = 0, headcountOn = 0;
  for (const s of shifts) {
    plannedMin += shiftLengthMin(s.startMin, s.endMin);
    const el = shiftElapsedMin(s.startMin, s.endMin, nowMin);
    elapsedMin += el;
    const end = s.endMin <= s.startMin ? s.endMin + 1440 : s.endMin;
    if (nowMin >= s.startMin && nowMin < end) headcountOn++;
  }
  const plannedHours = r2(plannedMin / 60);
  const hoursSoFar = r2(elapsedMin / 60);
  const plannedCost = ratePerHour != null ? r2(plannedHours * ratePerHour) : null;
  const costSoFar = ratePerHour != null ? r2(hoursSoFar * ratePerHour) : null;
  const pctOfRevenue = costSoFar != null && revenueSoFar > 0 ? r2((costSoFar / revenueSoFar) * 100) : null;
  return { plannedHours, plannedCost, hoursSoFar, costSoFar, pctOfRevenue, headcountOn, ratePerHour, shiftCount: shifts.length };
}
