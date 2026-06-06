// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Orders tab (M5). Per-location, per-supplier order generation
// (par − stock), lifecycle draft → ordered → received (line quantities +
// substitutions; receiving updates stock), deposits + minimum-order warning,
// and a demand nudge from upcoming guest counts. Per DRINKS_DOMAIN.md §5.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError, loadDrinks } from './utils';
import { showModal, closeModal, esc } from './modal';
import { drinkCategoryLabel, DRINK_LOCATIONS } from './drinks-constants';
import { buildOrderSuggestions, orderDepositTotal, demandNudge, OrderSuggestionLine } from '@shared/drink-order';
import type { DrinkOrder, DrinkSupplier } from '@shared/types';

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
  const locLabel = DRINK_LOCATIONS.find(l => l.key === loc())?.label || loc();
  inner.innerHTML = `
    ${nudge}
    <h4 class="ord-h">To order — short at ${esc(locLabel)}</h4>
    ${shortfallSectionsHtml()}
    ${open.length ? `<h4 class="ord-h">Open orders</h4>${open.map(orderCard).join('')}` : ''}
    ${done.length ? `<h4 class="ord-h">Recent</h4>${done.slice(0, 10).map(orderCard).join('')}` : ''}
    ${isManager() ? `<div class="ord-manual"><button class="btn btn-sm" data-testid="drink-order-new" onclick="drinksOrderNew()">+ Order something else…</button></div>` : ''}`;
}

/** Every supplier with at least one short item at this location, sorted. The
 *  shortfall is computed live from par − stock (active drinks only), so the tab
 *  shows what to order without anyone pressing "+ new order" (orders #1). */
function shortfallBySupplier(): { supplier: string; lines: OrderSuggestionLine[] }[] {
  const names = [...new Set((S.drinks || []).filter(d => d.mode === 'catalogue' && d.supplier).map(d => d.supplier))];
  return names
    .map(supplier => ({ supplier, lines: buildOrderSuggestions(S.drinks || [], supplier, loc()) }))
    .filter(x => x.lines.length > 0)
    .sort((a, b) => a.supplier.localeCompare(b.supplier));
}

function shortfallSectionsHtml(): string {
  const groups = shortfallBySupplier();
  if (groups.length === 0) {
    return `<div class="drinks-empty" data-testid="ord-nothing-short">Everything is at or above target at ${esc(loc())}. 🎉</div>`;
  }
  return groups.map(g => {
    const sup = (S.drinkSuppliers || []).find(s => s.name === g.supplier);
    return shortfallCardHtml(g.supplier, sup, g.lines);
  }).join('');
}

function shortfallCardHtml(supplier: string, sup: DrinkSupplier | undefined, lines: OrderSuggestionLine[]): string {
  const instr: string[] = [];
  if (sup?.orderDays?.length) instr.push(`<strong>Order days:</strong> ${sup.orderDays.map(esc).join(', ')}${sup.orderDaysNote ? ` (${esc(sup.orderDaysNote)})` : ''}`);
  if (sup?.orderCutoff) instr.push(`<strong>Cutoff:</strong> ${esc(sup.orderCutoff)}`);
  if (sup?.deliveryWindow) instr.push(`<strong>Delivery:</strong> ${esc(sup.deliveryWindow)}`);
  if (sup?.minimumOrder) instr.push(`<strong>Min:</strong> ${esc(sup.minimumOrder)}`);
  const contactBits: string[] = [];
  if (sup?.contact?.email) contactBits.push(`<a href="mailto:${esc(sup.contact.email)}">${esc(sup.contact.email)}</a>`);
  if (sup?.contact?.phone) contactBits.push(esc(sup.contact.phone));
  if (sup?.contact?.url) contactBits.push(`<a href="${esc(sup.contact.url)}" target="_blank" rel="noopener">order online ↗</a>`);
  const dep = orderDepositTotal(lines.map(l => ({ orderQty: l.orderQty, deposit: l.deposit })));
  const costOf = (drinkId: string) => (S.drinks || []).find(x => x.id === drinkId)?.costPrice || 0;
  const costTotal = lines.reduce((s, l) => s + l.orderQty * costOf(l.drinkId), 0);
  const supAttr = esc(supplier).replace(/'/g, "\\'");
  return `<div class="ord-shortfall" data-testid="ord-shortfall" data-supplier="${esc(supplier)}">
    <div class="ord-sf-head">
      <strong>${esc(supplier)}</strong>
      <span class="muted small">${lines.length} item${lines.length > 1 ? 's' : ''} short</span>
      <span class="ord-sf-total" data-supplier="${esc(supplier)}" data-dep="${dep}">${orderCostLabel(costTotal, dep)}</span>
    </div>
    <div class="ord-sf-instr ${instr.length ? '' : 'muted small'}">${instr.length ? instr.join(' · ') : 'No order instructions set — add them on the Suppliers tab.'}</div>
    ${contactBits.length ? `<div class="ord-sf-contact small">${contactBits.join(' · ')}</div>` : ''}
    <table class="drinks-table"><thead><tr><th>Drink</th><th class="num">Needed</th><th class="num">Stock</th><th class="num">Order</th><th class="num">Cost</th><th class="num">Deposit</th></tr></thead>
      <tbody>${lines.map(l => `<tr>
        <td>${esc(l.name)}</td>
        <td class="num">${l.par}</td>
        <td class="num">${Math.round(l.stock * 10) / 10}</td>
        <td class="num"><input class="sf-qty" data-supplier="${esc(supplier)}" data-drinkid="${esc(l.drinkId)}" data-name="${esc(l.name)}" data-unit="${esc(l.orderUnit)}" data-deposit="${l.deposit}" data-cost="${costOf(l.drinkId)}" type="number" min="0" step="1" value="${l.orderQty}" style="width:60px;text-align:right;" oninput="drinksSfRecount('${supAttr}')"> ${esc(l.orderUnit)}</td>
        <td class="num sf-cost">${costOf(l.drinkId) ? '€' + (l.orderQty * costOf(l.drinkId)).toFixed(2) : '—'}</td>
        <td class="num">${l.deposit ? '€' + l.deposit.toFixed(2) : '—'}</td>
      </tr>`).join('')}</tbody></table>
    ${isManager() ? `<div class="ord-sf-actions"><button class="btn btn-sm btn-primary" data-testid="ord-place" onclick="drinksPlaceOrder('${supAttr}')">Place order</button></div>` : '<div class="muted small">Managers place orders.</div>'}
  </div>`;
}

function orderCostLabel(cost: number, dep: number): string {
  const bits = [`≈ €${cost.toFixed(2)} order cost`];
  if (dep) bits.push(`+ €${dep.toFixed(2)} deposit`);
  return bits.join(' ');
}

/** Recompute one supplier's order-cost total live as quantities are edited. */
export function drinksSfRecount(supplier: string): void {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('.sf-qty')).filter(i => i.dataset.supplier === supplier);
  let cost = 0;
  for (const inp of inputs) {
    const qty = Number(inp.value) || 0;
    const unit = Number(inp.dataset.cost) || 0;
    cost += qty * unit;
    const cell = inp.closest('tr')?.querySelector('.sf-cost') as HTMLElement | null;
    if (cell) cell.textContent = unit ? '€' + (qty * unit).toFixed(2) : '—';
  }
  const totalEl = document.querySelector(`.ord-sf-total[data-supplier="${CSS.escape(supplier)}"]`) as HTMLElement | null;
  if (totalEl) totalEl.textContent = orderCostLabel(cost, Number(totalEl.dataset.dep) || 0);
}

/** Place an order for one supplier straight from the shortfall list: read the
 *  (possibly edited) quantities, create the order and mark it ordered in one go,
 *  so it drops into "Open orders" ready to receive. */
export async function drinksPlaceOrder(supplier: string): Promise<void> {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const lines = Array.from(document.querySelectorAll<HTMLInputElement>('.sf-qty'))
    .filter(inp => inp.dataset.supplier === supplier)
    .map(inp => ({
      drinkId: inp.dataset.drinkid as string,
      name: inp.dataset.name || '',
      orderedQty: Number(inp.value) || 0,
      orderUnit: inp.dataset.unit || '',
      deposit: Number(inp.dataset.deposit) || 0,
    }))
    .filter(l => l.orderedQty > 0);
  if (lines.length === 0) { toastError('Nothing to order — set a quantity above 0.'); return; }
  const sup = (S.drinkSuppliers || []).find(s => s.name === supplier);
  const id = newId();
  try {
    await apiPost('/api/drinks/orders', { id, location: loc(), supplier, lines });
    await apiPost(`/api/drinks/orders/${id}`, { status: 'ordered', expectedDelivery: sup?.deliveryWindow || null }, 'PATCH');
    toast(`Order placed — ${supplier}`);
    refreshOrders();
  } catch (e: unknown) {
    toastError('Could not place order: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
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
