// ─────────────────────────────────────────────────────────────────────────────
// FINANCE FORMAT — pure presentation helpers for the live dashboard.
// No DOM / state / module imports, so they're unit-testable (test/finance-
// dashboard.test.ts), mirroring chunk-guide.ts / ritual.ts.
// ─────────────────────────────────────────────────────────────────────────────

export const eur2 = (n: number | null | undefined): string => (n == null || isNaN(Number(n)) ? '–' : '€' + Number(n).toFixed(2));
export const eur0 = (n: number | null | undefined): string => (n == null || isNaN(Number(n)) ? '–' : '€' + Math.round(Number(n)).toLocaleString('nl-NL'));

export function pctDelta(now: number | null, prev: number | null): number | null {
  if (now == null || prev == null || prev === 0) return null;
  return Math.round(((now - prev) / prev) * 100);
}

export function deltaChip(delta: number | null, goodIsUp = true): string {
  if (delta == null) return '<span class="fin-chip fin-chip-neutral">– vs last wk</span>';
  const up = delta > 0, flat = delta === 0;
  const good = flat ? false : (up === goodIsUp);
  const cls = flat ? 'fin-chip-neutral' : (good ? 'fin-chip-good' : 'fin-chip-bad');
  const arrow = flat ? '→' : (up ? '↑' : '↓');
  return `<span class="fin-chip ${cls}">${arrow} ${Math.abs(delta)}% vs last wk</span>`;
}

// Spend targets: higher is better → meeting/above target is good.
export function targetChip(actual: number | null, target: number | null): string {
  if (target == null) return '';
  if (actual == null) return `<span class="fin-chip fin-chip-neutral">target ${eur2(target)}</span>`;
  const cls = actual >= target ? 'fin-chip-good' : 'fin-chip-bad';
  return `<span class="fin-chip ${cls}">${actual >= target ? '✓' : '↓'} target ${eur2(target)}</span>`;
}

// Intraday SVG sparkline (today vs last week, cumulative).
export function sparkline(today: { hour: number; cum: number }[], prior: { hour: number; cum: number }[]): string {
  const all = [...today, ...prior];
  if (all.length === 0) return '<div class="fin-spark-empty">No hourly data yet</div>';
  const hours = all.map((p) => p.hour);
  const minH = Math.min(...hours), maxH = Math.max(...hours);
  const maxV = Math.max(1, ...all.map((p) => p.cum));
  const W = 320, H = 90, padX = 4, padY = 6;
  const x = (h: number) => padX + (maxH === minH ? 0 : ((h - minH) / (maxH - minH)) * (W - 2 * padX));
  const y = (v: number) => H - padY - (v / maxV) * (H - 2 * padY);
  const path = (pts: { hour: number; cum: number }[]) => pts.length ? 'M' + pts.map((p) => `${x(p.hour).toFixed(1)},${y(p.cum).toFixed(1)}`).join(' L') : '';
  return `<svg class="fin-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Cumulative revenue today vs last week">
    <path d="${path(prior)}" fill="none" stroke="var(--fin-muted, #888)" stroke-width="1.5" stroke-dasharray="4 3"/>
    <path d="${path(today)}" fill="none" stroke="var(--fin-accent, #185FA5)" stroke-width="2"/>
  </svg>`;
}

// Mon..Sun week strip; byDay is a Mon-first contiguous prefix (Mon..today),
// padded to 7 cells. Heights are normalised; empty days render unfilled.
export function renderWeekStrip(byDay: { date: string; gross: number }[]): string {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = Math.max(1, ...byDay.map((d) => d.gross));
  const cells = labels.map((lab, i) => {
    const day = byDay[i];
    const h = day ? Math.max(2, Math.round((day.gross / max) * 100)) : 0;
    const filled = day && day.gross > 0;
    return `<div class="fin-wk-cell"><div class="fin-wk-bar ${filled ? 'filled' : ''}" style="height:${h}%" title="${day ? eur0(day.gross) : ''}"></div><span class="fin-wk-lab">${lab}</span></div>`;
  }).join('');
  return `<div class="fin-wk">${cells}</div>`;
}
