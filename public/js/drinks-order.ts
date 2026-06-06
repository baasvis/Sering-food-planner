// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Orders tab (M5). Per-location, per-supplier order generation
// (par − stock), lifecycle draft → ordered → received (line quantities +
// substitutions; receiving updates stock), deposits + minimum-order warning,
// and a demand nudge from upcoming guest counts. Per DRINKS_DOMAIN.md §5.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError, loadDrinks } from './utils';
import { showModal, closeModal, esc } from './modal';
import { drinkCategoryLabel } from './drinks-constants';
import { buildOrderSuggestions, orderDepositTotal, demandNudge, OrderSuggestionLine } from '@shared/drink-order';
import type { DrinkOrder } from '@shared/types';

function loc(): string { return S.currentLoc || 'west'; }
function isManager(): boolean { return !!S.user?.isManager; }

// New-order draft (in memory until "Create order").
interface DraftLine { drinkId: string; name: string; orderUnit: string; orderQty: number; deposit: number }
let _draft: { supplier: string; lines: DraftLine[] } | null = null;

// ── Tab render ──

export function renderDrinksOrdersTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  body.innerHTML = `<div id="drinks-orders-inner"><div class="drinks-empty">Loading orders…</div></div>`;
  refreshOrders();
}

async function fetchOrders(): Promise<DrinkOrder[]> {
  try {
    const data = await (await fetch(`/api/drinks/orders?location=${encodeURIComponent(loc())}`)).json();
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

async function refreshOrders(): Promise<void> {
  const inner = document.getElementById('drinks-orders-inner');
  if (!inner) return;
  const orders = await fetchOrders();
  S.drinkOrders = orders;
  const nudge = demandNudgeBanner();
  const open = orders.filter(o => o.status === 'draft' || o.status === 'ordered');
  const done = orders.filter(o => o.status === 'received' || o.status === 'cancelled');
  inner.innerHTML = `
    <div class="drinks-toolbar">
      ${isManager() ? `<button class="btn btn-primary" data-testid="drink-order-new" onclick="drinksOrderNew()">+ New order</button>` : '<span class="muted small">Managers create orders.</span>'}
    </div>
    ${nudge}
    <h4 class="ord-h">Open</h4>
    ${open.length ? open.map(orderCard).join('') : '<div class="drinks-empty">No open orders.</div>'}
    ${done.length ? `<h4 class="ord-h">Recent</h4>${done.slice(0, 10).map(orderCard).join('')}` : ''}`;
}

function demandNudgeBanner(): string {
  const cfg = S.drinkConfig;
  const threshold = cfg?.demandNudgeThresholdPct ?? 25;
  // Upcoming = sum of next-weeks guests for this location's nearest stored week;
  // trailing = current S.guests baseline for the location. Both best-effort.
  const upcoming = sumNextWeeks(loc());
  const trailing = sumCurrentWeek(loc());
  if (upcoming > 0 && demandNudge(upcoming, trailing, threshold)) {
    const pct = Math.round(((upcoming - trailing) / trailing) * 100);
    return `<div class="ord-nudge" data-testid="drink-order-nudge">📈 Upcoming guest counts are ~${pct}% above the recent average — consider ordering above par.</div>`;
  }
  return '';
}
function sumCurrentWeek(location: string): number {
  const g = S.guests?.[location] || {};
  let t = 0;
  for (const day of Object.keys(g)) t += (g[day]?.lunch || 0) + (g[day]?.dinner || 0);
  return t;
}
function sumNextWeeks(location: string): number {
  const nw = S.guestsNextWeeks || {};
  const keys = Object.keys(nw).sort();
  if (keys.length === 0) return 0;
  const wk = nw[keys[0]]?.[location] || {};
  let t = 0;
  for (const day of Object.keys(wk)) for (const meal of Object.keys(wk[day] || {})) t += wk[day][meal] || 0;
  return t;
}

function orderCard(o: DrinkOrder): string {
  const dep = orderDepositTotal((o.lines || []).map(l => ({ orderQty: l.orderedQty, deposit: l.deposit })));
  const statusCls = `ord-status ord-${o.status}`;
  return `<div class="ord-card" data-testid="drink-order-card" data-id="${esc(o.id)}">
    <div class="ord-card-head">
      <strong>${esc(o.supplier || 'Order')}</strong>
      <span class="${statusCls}">${esc(o.status)}</span>
      <span class="muted small">${o.lines?.length || 0} lines${dep ? ` · €${dep.toFixed(2)} deposit` : ''}</span>
    </div>
    <div class="ord-lines">${(o.lines || []).map(l => `<div class="ord-line"><span>${esc(l.name || l.drinkId || '')}</span><span class="muted">${l.orderedQty} ${esc(l.orderUnit)}${l.receivedQty != null ? ` → recv ${l.receivedQty}` : ''}</span></div>`).join('')}</div>
    ${o.expectedDelivery ? `<div class="muted small">Expected: ${esc(o.expectedDelivery)}</div>` : ''}
    ${isManager() ? orderActions(o) : ''}
  </div>`;
}

function orderActions(o: DrinkOrder): string {
  if (o.status === 'draft') {
    return `<div class="ord-actions">
      <button class="btn btn-sm btn-primary" onclick="drinksOrderMarkOrdered('${esc(o.id)}')">Mark ordered</button>
      <button class="btn btn-sm btn-danger" onclick="drinksOrderDelete('${esc(o.id)}')">Delete</button>
    </div>`;
  }
  if (o.status === 'ordered') {
    return `<div class="ord-actions">
      <button class="btn btn-sm btn-primary" data-testid="drink-order-receive" onclick="drinksOrderOpenReceive('${esc(o.id)}')">Receive…</button>
      <button class="btn btn-sm" onclick="drinksOrderCancel('${esc(o.id)}')">Cancel</button>
    </div>`;
  }
  return '';
}

// ── New order flow ──

export function drinksOrderNew(): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const suppliers = (S.drinkSuppliers || []).map(s => s.name);
  showModal(`<div class="drink-form">
    <h3>New order — ${esc(loc())}</h3>
    <label class="df-field df-col2">Supplier
      <select id="ord-supplier" onchange="drinksOrderPickSupplier(this.value)">
        <option value="">Choose…</option>
        ${suppliers.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      </select>
    </label>
    <div id="ord-suggest"></div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="drink-order-create" type="button" onclick="drinksOrderCreate()">Create draft</button>
    </div>
  </div>`);
}

export function drinksOrderPickSupplier(supplier: string): void {
  const wrap = document.getElementById('ord-suggest');
  if (!wrap) return;
  if (!supplier) { _draft = null; wrap.innerHTML = ''; return; }
  const lines: OrderSuggestionLine[] = buildOrderSuggestions(S.drinks || [], supplier, loc());
  _draft = { supplier, lines: lines.map(l => ({ drinkId: l.drinkId, name: l.name, orderUnit: l.orderUnit, orderQty: l.orderQty, deposit: l.deposit })) };
  const sup = (S.drinkSuppliers || []).find(s => s.name === supplier);
  const minNote = sup?.minimumOrder ? `<div class="muted small">Minimum order: ${esc(sup.minimumOrder)}</div>` : '';
  if (_draft.lines.length === 0) { wrap.innerHTML = `<p class="muted small">Everything is at or above par for ${esc(supplier)} at ${esc(loc())}.</p>${minNote}`; return; }
  wrap.innerHTML = `${minNote}
    <table class="drinks-table"><thead><tr><th>Drink</th><th class="num">Par</th><th class="num">Stock</th><th class="num">Order</th><th class="num">Deposit</th></tr></thead>
    <tbody>${_draft.lines.map((l, i) => `<tr>
      <td>${esc(l.name)}</td>
      <td class="num">${suggestionPar(supplier, l.drinkId)}</td>
      <td class="num">${suggestionStock(l.drinkId)}</td>
      <td class="num"><input class="ord-qty" type="number" min="0" step="1" value="${l.orderQty}" style="width:64px;text-align:right;" oninput="drinksOrderQty(${i}, this.value)"> ${esc(l.orderUnit)}</td>
      <td class="num">${l.deposit ? '€' + l.deposit.toFixed(2) : '—'}</td>
    </tr>`).join('')}</tbody></table>`;
}
function suggestionPar(supplier: string, drinkId: string): string { const d = (S.drinks || []).find(x => x.id === drinkId); const p = d?.locations?.[loc()]?.par; return p != null ? String(p) : '—'; }
function suggestionStock(drinkId: string): string { const d = (S.drinks || []).find(x => x.id === drinkId); const s = d?.stockByLocation?.[loc()]; return s != null ? String(Math.round(s * 10) / 10) : '0'; }

export function drinksOrderQty(i: number, v: string): void { if (_draft && _draft.lines[i]) _draft.lines[i].orderQty = Number(v) || 0; }

export async function drinksOrderCreate(): Promise<void> {
  if (!_draft || !_draft.supplier) { toastError('Pick a supplier first.'); return; }
  const lines = _draft.lines.filter(l => l.orderQty > 0);
  if (lines.length === 0) { toastError('Nothing to order.'); return; }
  try {
    await apiPost('/api/drinks/orders', {
      id: newId(), location: loc(), supplier: _draft.supplier,
      lines: lines.map(l => ({ drinkId: l.drinkId, name: l.name, orderedQty: l.orderQty, orderUnit: l.orderUnit, deposit: l.deposit })),
    });
    toast('Draft order created');
    _draft = null;
    closeModal();
    refreshOrders();
  } catch (e: unknown) {
    toastError('Could not create: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export async function drinksOrderMarkOrdered(id: string): Promise<void> {
  const o = (S.drinkOrders || []).find(x => x.id === id);
  const sup = (S.drinkSuppliers || []).find(s => s.name === o?.supplier);
  try {
    // expectedDelivery carries the supplier's delivery-window hint (best-effort).
    await apiPost(`/api/drinks/orders/${id}`, { status: 'ordered', expectedDelivery: sup?.deliveryWindow || null }, 'PATCH');
    toast('Order marked as ordered');
    refreshOrders();
  } catch (e: unknown) { toastError('Could not update: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

export async function drinksOrderDelete(id: string): Promise<void> {
  try { await apiPost(`/api/drinks/orders/${id}`, {}, 'DELETE'); toast('Order deleted'); refreshOrders(); }
  catch (e: unknown) { toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}
export async function drinksOrderCancel(id: string): Promise<void> {
  try { await apiPost(`/api/drinks/orders/${id}`, { status: 'cancelled' }, 'PATCH'); toast('Order cancelled'); refreshOrders(); }
  catch (e: unknown) { toastError('Could not cancel: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

// ── Receiving ──

export function drinksOrderOpenReceive(id: string): void {
  const o = (S.drinkOrders || []).find(x => x.id === id);
  if (!o) return;
  const sameCat = (drinkId: string | null) => {
    const d = (S.drinks || []).find(x => x.id === drinkId);
    return (S.drinks || []).filter(x => x.category === d?.category && !x.archived);
  };
  showModal(`<div class="drink-form" data-testid="drink-order-receive-form">
    <h3>Receive — ${esc(o.supplier)}</h3>
    <p class="muted small">Enter what actually arrived. Substitute swaps a line to another drink of the same category.</p>
    <table class="drinks-table"><thead><tr><th>Ordered</th><th class="num">Recv</th><th>Substitute</th></tr></thead>
    <tbody>${(o.lines || []).map((l, i) => `<tr>
      <td>${esc(l.name || '')} <span class="muted small">${l.orderedQty} ${esc(l.orderUnit)}</span></td>
      <td class="num"><input class="rcv-qty" data-idx="${i}" type="number" min="0" step="1" value="${l.orderedQty}" style="width:60px;text-align:right;"></td>
      <td><select class="rcv-sub" data-idx="${i}"><option value="">— same —</option>${sameCat(l.drinkId).map(x => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></td>
    </tr>`).join('')}</tbody></table>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="drink-order-receive-confirm" type="button" onclick="drinksOrderConfirmReceive('${esc(o.id)}')">Confirm received</button>
    </div>
  </div>`);
}

export async function drinksOrderConfirmReceive(id: string): Promise<void> {
  const o = (S.drinkOrders || []).find(x => x.id === id);
  if (!o) return;
  const lines = (o.lines || []).map((l, i) => {
    const qtyEl = document.querySelector(`.rcv-qty[data-idx="${i}"]`) as HTMLInputElement | null;
    const subEl = document.querySelector(`.rcv-sub[data-idx="${i}"]`) as HTMLSelectElement | null;
    return { id: l.id, receivedQty: qtyEl ? Number(qtyEl.value) || 0 : l.orderedQty, substitutedBy: subEl?.value || null };
  });
  try {
    await apiPost(`/api/drinks/orders/${id}`, { status: 'received', lines }, 'PATCH');
    toast('Order received — stock updated');
    closeModal();
    await loadDrinks();
    refreshOrders();
  } catch (e: unknown) { toastError('Could not receive: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}
