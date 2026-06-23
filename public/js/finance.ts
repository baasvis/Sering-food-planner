import { S } from './state';
import { canEditScreen } from './state';
import { apiGet, apiPost, toast, toastError } from './utils';
import { esc } from './modal';
import { showModal, closeModal } from './modal';
import { getCurrentScreen } from './navigate';
import { registerRenderer } from './navigate';
import { formatIso as fmtDate, shortDayMonth as fmtDateShort } from '@shared/dates';

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — live staff dashboard (Sering Hub-fed). One venue at a time; live
// pulse + today scorecard + week-to-date, scored against the controllable
// targets (spend-per-meal, labour). Data from GET /api/finance/live.
// ─────────────────────────────────────────────────────────────────────────────

export { fmtDate, fmtDateShort };

export function fmtEuro(n: unknown): string {
  if (n == null || isNaN(Number(n))) return '–';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
export function fmtEuroFull(n: unknown): string {
  if (n == null || isNaN(Number(n))) return '–';
  return '€' + Number(n).toLocaleString('nl-NL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const eur2 = (n: number | null | undefined): string => (n == null || isNaN(Number(n)) ? '–' : '€' + Number(n).toFixed(2));
const eur0 = (n: number | null | undefined): string => (n == null || isNaN(Number(n)) ? '–' : '€' + Math.round(Number(n)).toLocaleString('nl-NL'));

const VENUE_TABS = [
  { key: 'west', label: 'Sering West' },
  { key: 'centraal', label: 'Centraal' },
  { key: 'testtafel', label: 'TestTafel' },
];

interface LiveTargets { foodPerMeal: number | null; drinkPerMeal: number | null; labourToday: number | null }
interface LiveLabour { plannedHours: number; plannedCost: number | null; hoursSoFar: number; costSoFar: number | null; pctOfRevenue: number | null; headcountOn: number; ratePerHour: number | null; shiftCount: number }
interface LiveData {
  venue: string; date: string; updatedAt: string | null;
  today: { revenueGross: number; revenueNet: number; revenueFood: number; revenueDrink: number; revenueOther: number; revenueUncategorized: number; meals: number; sales: number; spendPerMeal: number | null; foodPerMeal: number | null; drinkPerMeal: number | null };
  lastWeek: { date: string; revenueGross: number; meals: number; spendPerMeal: number | null };
  topProducts: { name: string; qty: number; gross: number; bucket: string }[];
  targets: LiveTargets;
  labour: LiveLabour | null;
  intraday: { today: { hour: number; cum: number }[]; lastWeek: { hour: number; cum: number }[] };
  weekToDate: { gross: number; byDay: { date: string; gross: number }[] };
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Data ─────────────────────────────────────────────────────────────────────
export async function loadFinanceLive(): Promise<void> {
  const venue = S.financeLiveVenue || 'west';
  try {
    S.financeLive = await apiGet(`/api/finance/live?venue=${venue}`) as unknown as LiveData;
  } catch (e: unknown) {
    S.financeLive = null;
    toastError('Could not load live data: ' + (e instanceof Error ? e.message : 'error'));
  }
  renderFinance();
}

export function setFinanceVenue(venue: string): void {
  if (venue === S.financeLiveVenue) return;
  S.financeLiveVenue = venue;
  S.financeLive = null;
  renderFinance();        // immediate loading state
  void loadFinanceLive(); // then fetch
}

export async function financeRefreshNow(): Promise<void> {
  toast('Refreshing…');
  await loadFinanceLive();
}

// Re-poll every 60s while the finance screen is showing so wave updates appear.
function ensurePoll(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    if (getCurrentScreen() !== 'finance') { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
    void loadFinanceLive();
  }, 60000);
}

// ── Comparison helpers ───────────────────────────────────────────────────────
function pctDelta(now: number | null, prev: number | null): number | null {
  if (now == null || prev == null || prev === 0) return null;
  return Math.round(((now - prev) / prev) * 100);
}
function deltaChip(delta: number | null, goodIsUp = true): string {
  if (delta == null) return '<span class="fin-chip fin-chip-neutral">– vs last wk</span>';
  const up = delta > 0, flat = delta === 0;
  const good = flat ? false : (up === goodIsUp);
  const cls = flat ? 'fin-chip-neutral' : (good ? 'fin-chip-good' : 'fin-chip-bad');
  const arrow = flat ? '→' : (up ? '↑' : '↓');
  return `<span class="fin-chip ${cls}">${arrow} ${Math.abs(delta)}% vs last wk</span>`;
}
// For spend targets, higher is better → meeting/above target is good.
function targetChip(actual: number | null, target: number | null): string {
  if (target == null) return '';
  if (actual == null) return `<span class="fin-chip fin-chip-neutral">target ${eur2(target)}</span>`;
  const cls = actual >= target ? 'fin-chip-good' : 'fin-chip-bad';
  return `<span class="fin-chip ${cls}">${actual >= target ? '✓' : '↓'} target ${eur2(target)}</span>`;
}

// ── Intraday SVG sparkline (today vs last week, cumulative) ───────────────────
function sparkline(today: { hour: number; cum: number }[], prior: { hour: number; cum: number }[]): string {
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

// ── Render ───────────────────────────────────────────────────────────────────
export function renderFinance(): void {
  const el = document.getElementById('screen-finance');
  if (!el) return;
  ensurePoll();
  const venue = S.financeLiveVenue || 'west';
  const tabs = VENUE_TABS.map((t) => `<button class="fin-tab ${t.key === venue ? 'active' : ''}" onclick="setFinanceVenue('${t.key}')">${esc(t.label)}</button>`).join('');

  const d = S.financeLive as unknown as LiveData | null;
  if (!d) {
    el.innerHTML = `<div class="fin-live"><div class="fin-tabs">${tabs}</div><div class="fin-loading">Loading live numbers…</div></div>`;
    void loadFinanceLive();
    return;
  }

  const t = d.today, lw = d.lastWeek, tg = d.targets;
  const updated = d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' }) : '–';
  const editBtn = canEditScreen('finance') ? `<button class="fin-btn-ghost" onclick="openFinanceTargets()"><i class="ti ti-target"></i> Targets</button>` : '';

  // Hero: pace (covers + revenue vs last week) + avg spend per cover (vs target)
  const coversDelta = pctDelta(t.meals, lw.meals);
  const revDelta = pctDelta(t.revenueGross, lw.revenueGross);
  const spendDelta = pctDelta(t.spendPerMeal, lw.spendPerMeal);

  el.innerHTML = `
  <div class="fin-live">
    <div class="fin-tabs">${tabs}</div>
    <div class="fin-head">
      <div class="fin-head-l"><span class="fin-live-dot"></span><span class="fin-date">${esc(d.date)}</span></div>
      <div class="fin-head-r">
        <span class="fin-updated">updated ${updated}</span>
        ${editBtn}
        <button class="fin-btn-ghost" onclick="financeRefreshNow()"><i class="ti ti-refresh"></i> Refresh</button>
      </div>
    </div>

    <div class="fin-hero">
      <div class="fin-hero-card">
        <div class="fin-hero-label">Pace right now</div>
        <div class="fin-hero-big">${t.meals} <span class="fin-hero-unit">covers · ${eur0(t.revenueGross)}</span></div>
        <div class="fin-chips">${deltaChip(coversDelta)} ${deltaChip(revDelta)}</div>
      </div>
      <div class="fin-hero-card">
        <div class="fin-hero-label">Avg spend / cover</div>
        <div class="fin-hero-big">${eur2(t.spendPerMeal)}</div>
        <div class="fin-chips">${targetChip(t.spendPerMeal, null)}${deltaChip(spendDelta)}</div>
      </div>
    </div>

    <div class="fin-card">
      <div class="fin-card-title">Spend per cover <span class="fin-card-sub">what staff influence</span></div>
      <div class="fin-scorecard">
        <div class="fin-score"><div class="fin-score-label">Food</div><div class="fin-score-val">${eur2(t.foodPerMeal)}</div>${targetChip(t.foodPerMeal, tg.foodPerMeal)}</div>
        <div class="fin-score"><div class="fin-score-label">Drinks</div><div class="fin-score-val">${eur2(t.drinkPerMeal)}</div>${targetChip(t.drinkPerMeal, tg.drinkPerMeal)}</div>
        <div class="fin-score"><div class="fin-score-label">Total</div><div class="fin-score-val">${eur2(t.spendPerMeal)}</div></div>
      </div>
    </div>

    <div class="fin-card">
      <div class="fin-card-title">Sales pulse</div>
      <div class="fin-metrics">
        <div class="fin-metric"><div class="fin-metric-label">Covers</div><div class="fin-metric-val">${t.meals}</div></div>
        <div class="fin-metric"><div class="fin-metric-label">Revenue (net)</div><div class="fin-metric-val">${eur0(t.revenueNet)}</div><div class="fin-metric-sub">gross ${eur0(t.revenueGross)}</div></div>
        <div class="fin-metric"><div class="fin-metric-label">Food / drink</div><div class="fin-metric-val">${eur0(t.revenueFood)} <span class="fin-sep">/</span> ${eur0(t.revenueDrink)}</div></div>
        <div class="fin-metric"><div class="fin-metric-label">Tickets</div><div class="fin-metric-val">${t.sales}</div></div>
      </div>
      <div class="fin-spark-legend"><span><i class="fin-leg-today"></i>Today</span><span><i class="fin-leg-prior"></i>Last week</span></div>
      ${sparkline(d.intraday.today, d.intraday.lastWeek)}
    </div>

    <div class="fin-row2">
      <div class="fin-card">
        <div class="fin-card-title">What's selling</div>
        ${renderTopProducts(d.topProducts)}
      </div>
      <div class="fin-card">
        <div class="fin-card-title">Labour <span class="fin-card-sub">planned · roster</span></div>
        ${renderLabour(d.labour, tg.labourToday)}
      </div>
    </div>

    <div class="fin-card">
      <div class="fin-card-title">This week <span class="fin-card-sub">${eur0(d.weekToDate.gross)} so far</span></div>
      ${renderWeekStrip(d.weekToDate.byDay)}
    </div>
  </div>`;
}

function renderTopProducts(products: LiveData['topProducts']): string {
  if (!products.length) return '<div class="fin-empty">Nothing sold yet</div>';
  const max = Math.max(1, ...products.map((p) => p.gross));
  return '<div class="fin-bars">' + products.map((p) => {
    const w = Math.round((p.gross / max) * 100);
    return `<div class="fin-bar-row"><div class="fin-bar-head"><span>${esc(p.name)}</span><span class="fin-bar-qty">${p.qty}</span></div><div class="fin-bar-track"><div class="fin-bar fin-bar-${esc(p.bucket)}" style="width:${w}%"></div></div></div>`;
  }).join('') + '</div>';
}

function renderLabour(l: LiveLabour | null, target: number | null): string {
  if (!l) return '<div class="fin-empty">Labour not available<br><span class="fin-empty-sub">connect the shifts roster to enable</span></div>';
  const pct = l.pctOfRevenue == null ? '–' : l.pctOfRevenue + '%';
  const tgt = target != null && l.plannedCost != null
    ? `<span class="fin-chip ${l.plannedCost <= target ? 'fin-chip-good' : 'fin-chip-bad'}">${l.plannedCost <= target ? '✓' : '↑'} target ${eur0(target)}</span>` : '';
  return `
    <div class="fin-labour-big">${eur0(l.costSoFar)} <span class="fin-labour-unit">so far · ${pct} of revenue</span></div>
    <div class="fin-labour-sub">planned ${eur0(l.plannedCost)} (${l.plannedHours}h) ${tgt}</div>
    <div class="fin-labour-foot"><span><i class="ti ti-users"></i> ${l.headcountOn} on now</span><span>${l.hoursSoFar}h worked${l.ratePerHour != null ? ` · ${eur2(l.ratePerHour)}/h` : ''}</span></div>`;
}

function renderWeekStrip(byDay: LiveData['weekToDate']['byDay']): string {
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const max = Math.max(1, ...byDay.map((d) => d.gross));
  // byDay is Mon..today; pad to 7 for the grid.
  const cells = labels.map((lab, i) => {
    const day = byDay[i];
    const h = day ? Math.max(2, Math.round((day.gross / max) * 100)) : 0;
    const filled = day && day.gross > 0;
    return `<div class="fin-wk-cell"><div class="fin-wk-bar ${filled ? 'filled' : ''}" style="height:${h}%" title="${day ? eur0(day.gross) : ''}"></div><span class="fin-wk-lab">${lab}</span></div>`;
  }).join('');
  return `<div class="fin-wk">${cells}</div>`;
}

// ── Targets editor (manager-gated) ───────────────────────────────────────────
export async function openFinanceTargets(): Promise<void> {
  let cfg: Record<string, { foodPerMeal?: number; drinkPerMeal?: number; labourByDay?: Record<string, number> }> = {};
  try { cfg = await apiGet('/api/finance/targets') as Record<string, { foodPerMeal?: number; drinkPerMeal?: number; labourByDay?: Record<string, number> }>; } catch { /* empty */ }
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const venueBlock = (vk: string, vlabel: string) => {
    const v = cfg[vk] || {};
    const lbd = v.labourByDay || {};
    return `<div class="fin-tg-venue"><div class="fin-tg-vname">${esc(vlabel)}</div>
      <div class="fin-tg-grid">
        <label>Food €/cover<input type="number" step="0.5" min="0" id="tg-${vk}-food" value="${v.foodPerMeal ?? ''}"></label>
        <label>Drink €/cover<input type="number" step="0.5" min="0" id="tg-${vk}-drink" value="${v.drinkPerMeal ?? ''}"></label>
      </div>
      <div class="fin-tg-lab">Labour €/day
        <div class="fin-tg-days">${wd.map((d) => `<label>${d}<input type="number" step="10" min="0" id="tg-${vk}-lab-${d}" value="${lbd[d] ?? ''}"></label>`).join('')}</div>
      </div></div>`;
  };
  showModal(`<div class="fin-tg-modal">
    <h3>Controllable targets</h3>
    <p class="fin-tg-help">No revenue target — only what staff influence: spend per cover (food/drink) and labour per day.</p>
    ${VENUE_TABS.map((t) => venueBlock(t.key, t.label)).join('')}
    <div class="fin-tg-actions"><button onclick="closeModal()">Cancel</button><button class="primary" onclick="saveFinanceTargets()">Save</button></div>
  </div>`);
}

export async function saveFinanceTargets(): Promise<void> {
  const wd = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const numVal = (id: string): number | undefined => {
    const v = (document.getElementById(id) as HTMLInputElement | null)?.value;
    if (v == null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  };
  const config: Record<string, { foodPerMeal?: number; drinkPerMeal?: number; labourByDay?: Record<string, number> }> = {};
  for (const t of VENUE_TABS) {
    const out: { foodPerMeal?: number; drinkPerMeal?: number; labourByDay?: Record<string, number> } = {};
    const f = numVal(`tg-${t.key}-food`); if (f !== undefined) out.foodPerMeal = f;
    const dr = numVal(`tg-${t.key}-drink`); if (dr !== undefined) out.drinkPerMeal = dr;
    const lbd: Record<string, number> = {};
    for (const day of wd) { const n = numVal(`tg-${t.key}-lab-${day}`); if (n !== undefined) lbd[day] = n; }
    if (Object.keys(lbd).length) out.labourByDay = lbd;
    if (Object.keys(out).length) config[t.key] = out;
  }
  try {
    await apiPost('/api/finance/targets', config);
    closeModal();
    toast('Targets saved');
    await loadFinanceLive();
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'error'));
  }
}

registerRenderer('finance', renderFinance);
