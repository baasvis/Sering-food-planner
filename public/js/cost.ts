// ── Cost per guest engine (West-tab steering) ───────────────────────────────
//
// Computes the West kitchen's ingredient cost per guest for a date window,
// broken down by dish type (soup / main / topping) vs director-set targets.
//
// WEST IS THE KITCHEN: it cooks + plans for both sites, so the denominator is
// ALL guests West cooks for — every service (West AND Centraal) in the window.
// Food biked to Centraal still counts (West paid for it). The UI lives only on
// the West tab; Centraal is serve-only.
//
// Correctness (per the adversarial review):
//  - reads the per-service peer-share cache via calcRequiredAtService, which is
//    catering-free and already reflects the closed-service demand roll
//    (getEffectiveGuests). We never run a parallel raw-guest loop.
//  - numerator and denominator share one guest universe: dish cost uses the
//    cached liters → guests (liters / serving), the denominator sums the same
//    slots' effective guests. Past/closed services drop out of both sides.
//  - un-costed / improvised / placeholder / count-recipe / bad-servingSize
//    dishes are filled with a conservative estimate (type costed-MEDIAN ×1.10,
//    terminal fallback target ×1.10) so the headline can never divide 0/0.
//    Median (not mean) so one mispriced recipe can't poison every estimate.
//    A coverage % flags how much of the number is estimated vs measured.

import { S, DEFAULT_COST_TARGETS } from './state';
import { calcRequiredAtService, getEffectiveGuests, isServicePast, dateToDayName, rebuildPlanner, reserveFactor } from './core';
import { showModal, closeModal, esc } from './modal';
import { toast, toastError, saveCostTargets, saveCookReserve } from './utils';
import { rerenderCurrentView } from './navigate';
import { supplyPricePerGuest } from '@shared/supply-demand';
import type { Batch, CostTargets, RecipeFull } from '@shared/types';

// Batch dish types that carry cooked cost (toppings/bread are Supplies, handled
// separately). Mirrors core.ts TYPES.
const FOOD_TYPES: string[] = ['Soup', 'Main course', 'Dessert'];

export interface CostBreakdown {
  hasData: boolean;          // false when no guests in the window
  totalGuests: number;       // covers West cooks for in the window (both sites)
  soupPerGuest: number;
  mainPerGuest: number;
  dessertPerGuest: number;   // usually 0 — desserts aren't planned yet
  toppingPerGuest: number;   // from Supplies (already a per-guest figure)
  toppingAssumed: boolean;   // true = no priced toppings yet, using the target as a placeholder
  foodPerGuest: number;      // soup + main + dessert (cooked dishes)
  totalPerGuest: number;     // foodPerGuest + toppingPerGuest
  targets: CostTargets;
  totalTarget: number;       // soup + main + topping
  revenuePerGuest: number | null; // effective €/guest (override ?? rolling Tebi), null if unknown
  foodCostPct: number | null;     // totalPerGuest ÷ revenuePerGuest × 100, null if no revenue
  coveragePct: number;       // 0..100: share of dish-portions with a real cost
  estimated: boolean;        // any estimate used
}

/** Effective targets — director-set if loaded, else the agreed defaults. */
export function getCostTargets(): CostTargets {
  return S.costTargets ?? DEFAULT_COST_TARGETS;
}

/** MEDIAN per-serving cost of costed recipes per food type (€/serving ≈
 *  €/guest). The conservative estimate base for un-costed dishes. Median, not
 *  mean, so a single bad recipe (e.g. a data-entry slip pricing one dish at
 *  €167/serving) can't poison every estimate. NaN when a type has no costed
 *  recipe at all (caller falls back to the target). */
function globalTypeMedian(): Record<string, number> {
  const byType: Record<string, number[]> = {};
  for (const r of (S.recipes || []) as RecipeFull[]) {
    if (r.costPerServing == null || !(r.costPerServing > 0)) continue;
    if (r.yieldType === 'count') continue;        // per-unit cost, not per-ml
    const t = r.type as string;
    if (!FOOD_TYPES.includes(t)) continue;
    (byType[t] = byType[t] || []).push(r.costPerServing);
  }
  const out: Record<string, number> = {};
  for (const t of FOOD_TYPES) {
    const arr = (byType[t] || []).sort((a, b) => a - b);
    const n = arr.length;
    out[t] = n === 0 ? NaN : (n % 2 ? arr[(n - 1) / 2] : (arr[n / 2 - 1] + arr[n / 2]) / 2);
  }
  return out;
}

function targetForType(type: string, t: CostTargets): number {
  if (type === 'Soup') return t.soup;
  if (type === 'Main course') return t.main;
  return t.main; // Dessert has no target — use main as a conservative estimate floor
}

/** A batch's ingredient cost per guest. costed=false ⇒ it's an estimate (no
 *  recipe / null cost / count-recipe / unusable servingSize). */
function batchCostPerGuest(
  b: Batch,
  recipeMap: Map<string, RecipeFull>,
  gAvg: Record<string, number>,
  t: CostTargets,
): { cpg: number; costed: boolean } {
  const r = b.recipeId ? recipeMap.get(b.recipeId) : undefined;
  if (r && r.costPerServing != null && r.costPerServing > 0 && r.yieldType !== 'count') {
    const ss = r.servingSize;
    if (ss && ss > 0) {
      // costPerServing is € per a servingSize-ml portion; scale to this batch's
      // own serving size (usually identical, so the ratio is 1).
      const serving = b.serving || ss;
      return { cpg: r.costPerServing * (serving / ss), costed: true };
    }
  }
  const avg = gAvg[b.type];
  const base = Number.isFinite(avg) ? avg : targetForType(b.type, t);
  return { cpg: base * 1.10, costed: false };
}

/** Toppings & bread €/guest — Σ over standard, costed supplies (org-wide; West
 *  makes toppings for both sites). Until toppings are priced in Supplies (the
 *  sum is 0), ASSUME the topping target so the total and food-cost-% aren't
 *  understated; flagged `assumed`. Auto-resolves to the real figure the moment
 *  any topping carries a cost. */
function toppingPerGuest(targets: CostTargets): { value: number; assumed: boolean } {
  let sum = 0;
  for (const s of (S.supplies || [])) {
    if (s.archived) continue;
    const ppg = supplyPricePerGuest(s);
    if (ppg != null) sum += ppg;
  }
  if (sum > 0) return { value: sum, assumed: false };
  return { value: targets.topping, assumed: true };
}

/** Cost breakdown over the given visible dates (ISO yyyy-mm-dd), both locations. */
export function computeCostBreakdown(isoDates: Set<string>): CostBreakdown {
  const targets = getCostTargets();
  const gAvg = globalTypeMedian();
  const recipeMap = new Map<string, RecipeFull>(
    ((S.recipes || []) as RecipeFull[]).map((r) => [r.id, r]),
  );

  const cost: Record<string, number> = { 'Soup': 0, 'Main course': 0, 'Dessert': 0 };
  let costedGuests = 0;
  let estGuests = 0;
  const slotGuests = new Map<string, number>(); // distinct in-window slots → effective guests
  // Strip the hidden production reserve back out: cost-per-guest steers on REAL
  // guest demand, so a cook bumping the reserve must NOT move the cost bar / food
  // cost %. calcRequiredAtService returns reserve-padded liters; ÷ reserveFactor
  // recovers true demand. No-op at 0% reserve (factor 1).
  const rf = reserveFactor();

  for (const b of (S.batches || [])) {
    if (!FOOD_TYPES.includes(b.type)) continue;
    const { cpg, costed } = batchCostPerGuest(b, recipeMap, gAvg, targets);
    for (const svc of (b.services || [])) {
      if (isServicePast(svc)) continue;
      if (!isoDates.has(svc.date)) continue;            // visible window (both sites)
      const liters = calcRequiredAtService(b, svc);      // catering-free, closed-roll correct
      if (!(liters > 0)) continue;
      const servingL = (b.serving || 280) / 1000;
      if (!(servingL > 0)) continue;
      const shareGuests = liters / servingL / rf;        // = effectiveGuests / peerCount (reserve stripped)
      cost[b.type] += shareGuests * cpg;
      if (costed) costedGuests += shareGuests; else estGuests += shareGuests;
      const k = `${svc.loc}-${svc.date}-${svc.meal}`;
      if (!slotGuests.has(k)) slotGuests.set(k, getEffectiveGuests(svc.loc, svc.date, svc.meal));
    }
  }

  let totalGuests = 0;
  for (const g of slotGuests.values()) totalGuests += g;

  const perGuest = (n: number) => (totalGuests > 0 ? n / totalGuests : 0);
  const soupPerGuest = perGuest(cost['Soup']);
  const mainPerGuest = perGuest(cost['Main course']);
  const dessertPerGuest = perGuest(cost['Dessert']);
  const topping = toppingPerGuest(targets);
  const tpg = topping.value;
  const foodPerGuest = soupPerGuest + mainPerGuest + dessertPerGuest;
  const totalPerGuest = foodPerGuest + tpg;
  const dishGuests = costedGuests + estGuests;

  // Food cost as % of revenue. Revenue per guest = manual override if set, else
  // the rolling Tebi auto value (null when unknown → the % is hidden).
  const revOverride = targets.revenuePerGuestOverride;
  const revAuto = (typeof S.revenuePerGuest === 'number' && S.revenuePerGuest > 0) ? S.revenuePerGuest : null;
  const revenuePerGuest = (revOverride != null && revOverride > 0) ? revOverride : revAuto;
  const foodCostPct = (revenuePerGuest && totalPerGuest > 0)
    ? Math.round((totalPerGuest / revenuePerGuest) * 1000) / 10
    : null;

  return {
    hasData: totalGuests > 0,
    totalGuests,
    soupPerGuest,
    mainPerGuest,
    dessertPerGuest,
    toppingPerGuest: tpg,
    toppingAssumed: topping.assumed,
    foodPerGuest,
    totalPerGuest,
    targets,
    totalTarget: targets.soup + targets.main + targets.topping,
    revenuePerGuest,
    foodCostPct,
    coveragePct: dishGuests > 0 ? Math.round((costedGuests / dishGuests) * 100) : 0,
    estimated: estGuests > 0,
  };
}

/** Traffic-light status vs a target: ok ≤target · warn ≤target×1.15 · over beyond. */
export function costStatus(value: number, target: number): 'ok' | 'warn' | 'over' {
  if (!(target > 0)) return 'ok';
  if (value <= target) return 'ok';
  if (value <= target * 1.15) return 'warn';
  return 'over';
}

/** Editable target €/guest for a dish type (Dessert has no target → uses main). */
export function dishTypeTarget(type: string): number {
  return targetForType(type, getCostTargets());
}

/** € formatter to cents. */
export function fmtEur(n: number): string {
  return '€' + (Math.round(n * 100) / 100).toFixed(2);
}

/** The West-tab cost bar HTML for the given visible window (ISO dates). */
export function renderCostBar(isoDates: Set<string>): string {
  const b = computeCostBreakdown(isoDates);
  const isDir = !!(S.user && S.user.isDirector);
  const gear = isDir
    ? `<button class="cost-bar-edit" onclick="openCostTargets()" title="Edit cost targets">⚙</button>`
    : '';

  if (!b.hasData) {
    return `<div class="cost-bar cost-bar-empty">
      <span>No guests in view — cost per guest unavailable.</span>${gear}
    </div>`;
  }

  const totalCls = 'cost-' + costStatus(b.totalPerGuest, b.totalTarget);
  const line = (label: string, val: number, target: number): string => {
    const cls = 'cost-' + costStatus(val, target);
    return `<span class="cost-chip ${cls}" title="target ${fmtEur(target)}/guest">`
      + `<span class="cost-chip-lbl">${label}</span> ${fmtEur(val)}</span>`;
  };

  const toppingChip = b.toppingAssumed
    ? `<span class="cost-chip cost-assumed" title="Assumed at €${b.targets.topping.toFixed(2)}/guest until your toppings & bread are priced in Supplies. It still counts toward the total and food cost % so they stay realistic.">`
      + `<span class="cost-chip-lbl">Topping</span> ${fmtEur(b.toppingPerGuest)} ~</span>`
    : line('Topping', b.toppingPerGuest, b.targets.topping);
  let lines = line('Soup', b.soupPerGuest, b.targets.soup)
    + line('Main', b.mainPerGuest, b.targets.main)
    + toppingChip;
  if (b.dessertPerGuest > 0) lines += line('Dessert', b.dessertPerGuest, b.targets.main);

  const cov = b.estimated
    ? `<span class="cost-coverage" title="Data completeness, NOT the food-cost %. The share of the guest portions in view that come from dishes with a real recipe cost entered. The rest are placeholders/improvised dishes with no recipe yet, so their whole cost is a conservative estimate (typical cost for that type +10%). It climbs as cooks swap placeholders for real dishes.">${b.coveragePct}% priced</span>`
    : '';
  const fc = b.foodCostPct != null
    ? `<span class="cost-fc cost-${costStatus(b.foodCostPct, b.targets.foodCostPct)}" title="Food cost as a share of FOOD revenue — your real target. Cost per guest ÷ the rolling 4-week average food revenue per guest (West + Centraal lunch &amp; dinner, drinks excluded) from Tebi. Target ${b.targets.foodCostPct}%.">food cost ${b.foodCostPct}%<small> / ${b.targets.foodCostPct}% target</small></span>`
    : '';

  return `<div class="cost-bar" title="Ingredient cost per guest the West kitchen cooks for (West + Centraal), over the days shown.">
    <div class="cost-bar-top">
      <span class="cost-total ${totalCls}">${fmtEur(b.totalPerGuest)} <small>/ guest</small></span>
      <span class="cost-target">target ${fmtEur(b.totalTarget)}</span>
      ${fc}
      ${cov}
      ${gear}
    </div>
    <div class="cost-bar-lines">${lines}</div>
  </div>`;
}

// ── Targets editor (director-only) ──────────────────────────────────────────
const ctNum = (id: string): string => (document.getElementById(id) as HTMLInputElement | null)?.value ?? '';

export function openCostTargets(): void {
  if (!(S.user && S.user.isDirector)) { toast('Only a director can edit cost targets'); return; }
  const t = getCostTargets();
  showModal(`
    <h3>Cost targets</h3>
    <p class="ct-help">Euros of ingredients per guest the West cost bar steers against.</p>
    <div class="ct-grid">
      <label>Soup<input id="ct-soup" type="number" step="0.05" min="0" value="${t.soup}" oninput="ctRecalcTotal()"></label>
      <label>Main<input id="ct-main" type="number" step="0.05" min="0" value="${t.main}" oninput="ctRecalcTotal()"></label>
      <label>Toppings &amp; bread<input id="ct-topping" type="number" step="0.05" min="0" value="${t.topping}" oninput="ctRecalcTotal()"></label>
    </div>
    <div class="ct-total">Total target <strong id="ct-total">${fmtEur(t.soup + t.main + t.topping)}</strong> / guest</div>
    <hr class="ct-hr">
    <label class="ct-row">Food cost target<span><input id="ct-pct" type="number" step="1" min="1" max="100" value="${t.foodCostPct}"> % of food revenue</span></label>
    <p class="ct-help" style="margin:8px 0 0;">Food revenue per guest is pulled automatically from Tebi (lunch &amp; dinner sales, drinks excluded).</p>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveCostTargetsForm()">Save targets</button>
    </div>
  `);
}

export function ctRecalcTotal(): void {
  const total = (Number(ctNum('ct-soup')) || 0) + (Number(ctNum('ct-main')) || 0) + (Number(ctNum('ct-topping')) || 0);
  const el = document.getElementById('ct-total');
  if (el) el.textContent = fmtEur(total);
}

export async function saveCostTargetsForm(): Promise<void> {
  if (!(S.user && S.user.isDirector)) { toast('Only a director can edit cost targets'); return; }
  const soup = Number(ctNum('ct-soup'));
  const main = Number(ctNum('ct-main'));
  const topping = Number(ctNum('ct-topping'));
  const pct = Number(ctNum('ct-pct'));
  for (const [k, v] of Object.entries({ soup, main, topping })) {
    if (!Number.isFinite(v) || v < 0 || v > 100) { toastError(`${k} target must be 0–100 €/guest`); return; }
  }
  if (!Number.isFinite(pct) || pct <= 0 || pct > 100) { toastError('Food cost target must be 1–100%'); return; }
  // Revenue per guest is auto (food revenue from Tebi); preserve any stored
  // override and the hidden production reserve (set separately on the header).
  S.costTargets = { soup, main, topping, foodCostPct: pct, revenuePerGuestOverride: getCostTargets().revenuePerGuestOverride, reservePercent: getCostTargets().reservePercent };
  closeModal();
  rerenderCurrentView();
  await saveCostTargets();
}

// ── Production reserve (cook-editable knob; West planner header) ─────────────
// A small % control that silently pads cooking/coverage/order demand as a backup.
// Any signed-in cook can turn it — it saves via the open /cost-reserve endpoint,
// never touching the director-only cost targets on the same row. The padding is
// folded straight into the demand numbers (no separate "+reserve" line item); the
// buffer math lives in core.reserveFactor(), this is only the UI + persistence.

/** Total backup liters the reserve adds across the visible days — the guest-demand
 *  padding only (catering is excluded, since calcRequiredAtService reads the
 *  catering-free per-service allocation). buffered = unbuffered × (1 + pct/100), so
 *  the extra = buffered × pct/(100 + pct). */
export function reserveLitersInWindow(isoDates: Set<string>): number {
  const pct = getCostTargets().reservePercent || 0;
  if (pct <= 0) return 0;
  let buffered = 0;
  for (const b of (S.batches || [])) {
    for (const svc of (b.services || [])) {
      if (isServicePast(svc) || !isoDates.has(svc.date)) continue;
      buffered += calcRequiredAtService(b, svc);
    }
  }
  return Math.round((buffered * pct / (100 + pct)) * 10) / 10;
}

/** The reserve control for the West planner header — shown to every cook. Also
 *  shows the concrete backup liters it's adding across the visible days, live. */
export function renderReserveControl(isoDates: Set<string>): string {
  const pct = getCostTargets().reservePercent || 0;
  const on = pct > 0;
  const extra = on ? reserveLitersInWindow(isoDates) : 0;
  const extraStr = extra > 0
    ? `<span class="reserve-ctl-extra" title="Total extra above guest demand the reserve is adding across the days shown. Folded silently into the dish demand &amp; orders; updates as you change the %.">≈ +${extra.toFixed(1)} L backup</span>`
    : '';
  return `<div class="reserve-ctl${on ? ' reserve-on' : ''}" title="Cook &amp; order this % extra above guest demand as a backup. Any cook can set it. The extra is folded into the demand numbers; catering is excluded.">
    <span class="reserve-ctl-lbl">🛟 Reserve</span>
    <input id="reserve-pct" class="reserve-ctl-input" type="number" min="0" max="100" step="5" value="${pct}"
      onchange="setReservePercent(this.value)" aria-label="Production reserve percent">
    <span class="reserve-ctl-unit">%</span>
    ${extraStr}
  </div>`;
}

export async function setReservePercent(v: string | number): Promise<void> {
  let pct = Number(v);
  if (!Number.isFinite(pct) || pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  pct = Math.round(pct * 10) / 10;
  S.costTargets = { ...getCostTargets(), reservePercent: pct };
  rebuildPlanner();       // re-allocate per-service demand with the new factor
  rerenderCurrentView();  // refresh coverage badges, breakdowns, order quantities
  toast(pct > 0 ? `Reserve set to ${pct}% extra` : 'Reserve off');
  await saveCookReserve(pct);
}

// ── Drill-down: where is the cost concentrated? ─────────────────────────────
export interface DishCostRow { name: string; type: string; costPerGuest: number; costed: boolean; status: 'ok' | 'warn' | 'over'; }
export interface ServiceCostRow { loc: string; date: string; meal: string; guests: number; costPerGuest: number; }

function recipeMapAll(): Map<string, RecipeFull> {
  return new Map(((S.recipes || []) as RecipeFull[]).map(r => [r.id, r]));
}

/** Window dishes ranked by €/guest (descending), deduped by batch. */
export function computeDishCosts(isoDates: Set<string>): DishCostRow[] {
  const targets = getCostTargets();
  const gMed = globalTypeMedian();
  const recipeMap = recipeMapAll();
  const rows: DishCostRow[] = [];
  const seen = new Set<string>();
  for (const b of (S.batches || [])) {
    if (!FOOD_TYPES.includes(b.type) || seen.has(b.id)) continue;
    const inWin = (b.services || []).some(svc => !isServicePast(svc) && isoDates.has(svc.date) && calcRequiredAtService(b, svc) > 0);
    if (!inWin) continue;
    seen.add(b.id);
    const { cpg, costed } = batchCostPerGuest(b, recipeMap, gMed, targets);
    rows.push({ name: b.name, type: b.type, costPerGuest: cpg, costed, status: costStatus(cpg, dishTypeTarget(b.type)) });
  }
  return rows.sort((a, b) => b.costPerGuest - a.costPerGuest);
}

/** Window services (loc/date/meal) ranked by total €/guest (descending). */
export function computeServiceCosts(isoDates: Set<string>): ServiceCostRow[] {
  const targets = getCostTargets();
  const gMed = globalTypeMedian();
  const recipeMap = recipeMapAll();
  const tpg = toppingPerGuest(targets).value;
  const rf = reserveFactor(); // strip the hidden reserve so cost reflects real guests (see computeCostBreakdown)
  const slot = new Map<string, { loc: string; date: string; meal: string; guests: number; cost: number }>();
  for (const b of (S.batches || [])) {
    if (!FOOD_TYPES.includes(b.type)) continue;
    const { cpg } = batchCostPerGuest(b, recipeMap, gMed, targets);
    for (const svc of (b.services || [])) {
      if (isServicePast(svc) || !isoDates.has(svc.date)) continue;
      const liters = calcRequiredAtService(b, svc);
      if (!(liters > 0)) continue;
      const servingL = (b.serving || 280) / 1000;
      if (!(servingL > 0)) continue;
      const k = `${svc.loc}|${svc.date}|${svc.meal}`;
      let s = slot.get(k);
      if (!s) { s = { loc: svc.loc, date: svc.date, meal: svc.meal, guests: getEffectiveGuests(svc.loc, svc.date, svc.meal), cost: 0 }; slot.set(k, s); }
      s.cost += (liters / servingL / rf) * cpg;
    }
  }
  const rows: ServiceCostRow[] = [];
  for (const s of slot.values()) {
    if (s.guests > 0) rows.push({ loc: s.loc, date: s.date, meal: s.meal, guests: s.guests, costPerGuest: s.cost / s.guests + tpg });
  }
  return rows.sort((a, b) => b.costPerGuest - a.costPerGuest);
}

/** Collapsible "where's the cost going?" panel for the West tab. */
export function renderCostDrilldown(isoDates: Set<string>): string {
  const dishes = computeDishCosts(isoDates).slice(0, 8);
  const services = computeServiceCosts(isoDates).slice(0, 6);
  if (!dishes.length && !services.length) return '';
  const totalTarget = getCostTargets().soup + getCostTargets().main + getCostTargets().topping;
  const dishRows = dishes.map(d =>
    `<div class="drill-row"><span class="drill-name">${esc(d.name)}</span>`
    + `<span class="cost-opt cost-${d.status}">${fmtEur(d.costPerGuest)}${d.costed ? '' : '<small> ~</small>'}</span></div>`,
  ).join('');
  const svcRows = services.map(s =>
    `<div class="drill-row"><span class="drill-name">${dateToDayName(s.date)} ${esc(s.meal)} <small>${s.loc === 'west' ? 'W' : 'C'}</small></span>`
    + `<span class="cost-opt cost-${costStatus(s.costPerGuest, totalTarget)}">${fmtEur(s.costPerGuest)}</span></div>`,
  ).join('');
  return `<details class="cost-drill">
    <summary>Where's the cost going?</summary>
    <div class="cost-drill-body">
      <div class="cost-drill-col"><h4>Priciest dishes <small>€/guest vs target</small></h4>${dishRows}</div>
      <div class="cost-drill-col"><h4>Priciest services <small>€/guest</small></h4>${svcRows}</div>
    </div>
  </details>`;
}
