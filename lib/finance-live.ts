// ─────────────────────────────────────────────────────────────────────────────
// FINANCE LIVE — pure helpers for the staff live dashboard (GET /api/finance/live)
//
// Kept pure (no Prisma/IO) so the classification is unit-testable. The route
// (routes/finance.ts) does the DB reads and calls classifyDayRows().
//
// The POS records no cover count (see TEBI.md), so "per meal" uses MEAL-type
// product quantities as the denominator — which is also exactly the per-meal
// spend staff can influence. Revenue is split food / drink / other / uncategorized
// off the Hub's financial Type (ProductDay.type). Classification mirrors the
// Hub's conventions in sering-hub/sources/tebi/type-mapping.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Tips/gratuity aren't sales — excluded from revenue entirely.
export const NON_REVENUE = /\btips?\b|fooi|gratuit/i;
// The Hub's zero-revenue sentinel (staff/volunteer meals, TT multi-course
// sub-components). Excluded from revenue, mirroring TypeDay/WeeklyRevenue.
export const STRUCTURAL_TYPE = '<structural>';
// "AF" = the alcohol-free drink Types (TT Homemade/bought AF) — drinks, not food.
export const DRINK_TYPE = /beer|wine|cocktail|mix|coffee|thee|\btea\b|soft|frisdrank|spirit|\bgin\b|tonic|juice|\bsap\b|limonade|pairing|token|borrel|\bbar\b|\baf\b|alcoholvrij|alcohol.?free/i;
// Room/space hire + event rental: real revenue but neither food nor drink.
// Checked AFTER drink so "SR Event tokens" still classifies as a drink (token).
export const OTHER_REVENUE = /event|space.?rental|verhuur|rental/i;
export const MEAL_TYPE = /lunch|dinner|diner|hoofd|\bmain\b|soup|soep|brunch|ontbijt|\bmenu\b/i;

export interface ProductRow { productName: string; type: string | null; qty: number; gross: number; net: number }
export interface ClassifiedProduct { name: string; qty: number; gross: number; bucket: 'food' | 'drink' | 'other' | 'uncategorized' }
export interface DaySummary {
  gross: number; net: number;
  foodGross: number; drinkGross: number; otherGross: number; uncategorizedGross: number;
  meals: number;
  products: ClassifiedProduct[];
}

export const r2 = (n: number): number => Math.round(n * 100) / 100;
export const perMeal = (v: number, meals: number): number | null => (meals > 0 ? r2(v / meals) : null);

function bucketOf(type: string | null): ClassifiedProduct['bucket'] {
  if (!type) return 'uncategorized';
  if (DRINK_TYPE.test(type)) return 'drink';
  if (OTHER_REVENUE.test(type)) return 'other';
  return 'food';
}

// Classify a day's ProductDay rows into a DaySummary. Tips and <structural>
// rows are dropped from all totals; everything else contributes to `gross`,
// split into food / drink / other / uncategorized. `meals` counts MEAL-type
// product quantities (the per-meal denominator).
export function classifyDayRows(rows: ProductRow[]): DaySummary {
  let gross = 0, net = 0, foodGross = 0, drinkGross = 0, otherGross = 0, uncategorizedGross = 0, meals = 0;
  const products: ClassifiedProduct[] = [];
  for (const row of rows) {
    const t = row.type;
    if (t && NON_REVENUE.test(t)) continue;     // tips/gratuity: not a sale
    if (t === STRUCTURAL_TYPE) continue;        // zero-revenue bookkeeping
    const g = Number(row.gross), n = Number(row.net);
    gross += g; net += n;
    const bucket = bucketOf(t);
    if (bucket === 'drink') drinkGross += g;
    else if (bucket === 'other') otherGross += g;
    else if (bucket === 'uncategorized') uncategorizedGross += g;
    else foodGross += g;
    if (t && MEAL_TYPE.test(t)) meals += row.qty;
    products.push({ name: row.productName, qty: Math.round(row.qty * 10) / 10, gross: r2(g), bucket });
  }
  return { gross, net, foodGross, drinkGross, otherGross, uncategorizedGross, meals, products };
}

// Cumulative gross-by-hour for the intraday curve. Accumulates same-hour rows
// (defensive — the route filters to one source, but summing never double-shows).
export function cumulativeByHour(rows: { hour: number; gross: unknown }[]): { hour: number; cum: number }[] {
  if (rows.length === 0) return [];
  const byHour = new Map<number, number>();
  for (const row of rows) byHour.set(row.hour, (byHour.get(row.hour) || 0) + Number(row.gross));
  const hours = rows.map((r) => r.hour);
  const minH = Math.min(...hours), maxH = Math.max(...hours);
  let cum = 0;
  const out: { hour: number; cum: number }[] = [];
  for (let h = minH; h <= maxH; h++) { cum += byHour.get(h) || 0; out.push({ hour: h, cum: r2(cum) }); }
  return out;
}

export function shiftDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Monday..Sunday of the ISO week containing dateStr.
export function isoWeekDates(dateStr: string): string[] {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // 0 = Monday
  return Array.from({ length: 7 }, (_, i) => shiftDate(dateStr, i - dow));
}

// ── Controllable targets (live dashboard step 2) ────────────────────────────
// DELIBERATELY permanent-only: finance has no event-location POS in v1 —
// temporary event locations (lib/locations.ts) are out of scope here.
export const VENUES = ['west', 'centraal', 'testtafel'] as const;
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; // getUTCDay() index → labourByDay key

export interface VenueTargets { foodPerMeal?: number; drinkPerMeal?: number; labourByDay?: Record<string, number> }
export type TargetsConfig = Record<string, VenueTargets>;
export interface ResolvedTargets { foodPerMeal: number | null; drinkPerMeal: number | null; labourToday: number | null }

const PER_MEAL_MAX = 1000;   // € spend-per-meal target ceiling
const LABOUR_MAX = 100000;   // € labour-per-day target ceiling

function boundedNum(v: unknown, max: number): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) return undefined;
  return Math.round(v * 100) / 100;
}

// Sanitize an arbitrary value (request body OR a DB JSON column) into a valid
// TargetsConfig: strict venue + weekday allowlist (prototype-pollution-proof),
// numbers bounded, out-of-range / wrong-shape silently dropped. The single
// source of truth for the shape — used by GET, POST and the /live resolver.
export function cleanTargetsConfig(raw: unknown): TargetsConfig {
  const out: TargetsConfig = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const body = raw as Record<string, unknown>;
  for (const venue of VENUES) {
    const vt = body[venue];
    if (!vt || typeof vt !== 'object' || Array.isArray(vt)) continue;
    const v = vt as Record<string, unknown>;
    const cleaned: VenueTargets = {};
    const f = boundedNum(v.foodPerMeal, PER_MEAL_MAX); if (f !== undefined) cleaned.foodPerMeal = f;
    const d = boundedNum(v.drinkPerMeal, PER_MEAL_MAX); if (d !== undefined) cleaned.drinkPerMeal = d;
    if (v.labourByDay && typeof v.labourByDay === 'object' && !Array.isArray(v.labourByDay)) {
      const src = v.labourByDay as Record<string, unknown>;
      const lbd: Record<string, number> = {};
      for (const wd of WEEKDAYS) { const n = boundedNum(src[wd], LABOUR_MAX); if (n !== undefined) lbd[wd] = n; }
      if (Object.keys(lbd).length) cleaned.labourByDay = lbd;
    }
    if (Object.keys(cleaned).length) out[venue] = cleaned;
  }
  return out;
}

// Resolve a venue's targets for a specific day (labour target keyed by weekday).
// date is an Amsterdam business-day string; getUTCDay() on a UTC-constructed
// midnight is DST-safe and matches the Sun-first WEEKDAYS index.
export function resolveTargetsForDay(config: TargetsConfig, venue: string, date: string): ResolvedTargets {
  const vt = config[venue] || {};
  const weekday = WEEKDAYS[new Date(date + 'T00:00:00Z').getUTCDay()];
  return {
    foodPerMeal: typeof vt.foodPerMeal === 'number' ? vt.foodPerMeal : null,
    drinkPerMeal: typeof vt.drinkPerMeal === 'number' ? vt.drinkPerMeal : null,
    labourToday: vt.labourByDay && typeof vt.labourByDay[weekday] === 'number' ? vt.labourByDay[weekday] : null,
  };
}
