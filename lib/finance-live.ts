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
