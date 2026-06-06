// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Production & corrections tab (M6). To-make list (par vs stock for
// homemade + building blocks), production logging (premix bottles ↑, building
// blocks ↓, maker/made-on/shelf-life), freshness/throw-out, and reason-coded
// write-offs available on any drink. Per DRINKS_DOMAIN.md §5.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError, loadDrinks, todayIso } from './utils';
import { showModal, closeModal, esc } from './modal';
import { DRINK_WRITEOFF_REASONS, drinkCategoryLabel } from './drinks-constants';
import { producedUnits, consumedBuildingBlocks, expiryDate } from '@shared/drink-production';
import type { Drink, DrinkProductionLog } from '@shared/types';

function loc(): string { return S.currentLoc || 'west'; }
function round1(n: number): number { return Math.round(n * 10) / 10; }

/** Homemade drinks (recipe mode) below par at this location — the to-make list. */
function toMakeList(): Array<{ drink: Drink; par: number; stock: number; deficit: number }> {
  const out: Array<{ drink: Drink; par: number; stock: number; deficit: number }> = [];
  for (const d of S.drinks || []) {
    if (d.mode !== 'recipe' || d.archived) continue;
    const par = d.locations?.[loc()]?.par;
    if (par == null || par <= 0) continue;
    const stock = d.stockByLocation?.[loc()] ?? 0;
    if (stock < par) out.push({ drink: d, par, stock, deficit: round1(par - stock) });
  }
  return out.sort((a, b) => b.deficit - a.deficit);
}

export function renderDrinksProductionTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  body.innerHTML = `<div id="drinks-prod-inner"><div class="drinks-empty">Loading…</div></div>`;
  refreshProduction();
}

async function fetchLogs(): Promise<DrinkProductionLog[]> {
  try { const r = await (await fetch(`/api/drinks/production?location=${encodeURIComponent(loc())}`)).json(); return Array.isArray(r) ? r : []; }
  catch { return []; }
}

async function refreshProduction(): Promise<void> {
  const inner = document.getElementById('drinks-prod-inner');
  if (!inner) return;
  const toMake = toMakeList();
  const logs = await fetchLogs();
  const today = todayIso();
  const expired = logs.filter(l => l.status === 'fresh' && l.expiresOn && l.expiresOn < today);

  inner.innerHTML = `
    <h4 class="ord-h">To make — ${esc(loc())}</h4>
    ${toMake.length === 0 ? '<div class="drinks-empty">Everything homemade is at or above par. 🎉</div>' : `
      <div class="drinks-table-wrap"><table class="drinks-table" data-testid="drinks-tomake-table">
        <thead><tr><th>Drink</th><th>Category</th><th class="num">Par</th><th class="num">Stock</th><th class="num">Short</th><th></th></tr></thead>
        <tbody>${toMake.map(m => `<tr data-testid="tomake-row">
          <td class="drink-name">${esc(m.drink.name)}</td>
          <td>${esc(drinkCategoryLabel(m.drink.category))}</td>
          <td class="num">${m.par}</td><td class="num">${round1(m.stock)}</td>
          <td class="num" style="color:#d23f3f;font-weight:600;">${m.deficit}</td>
          <td class="drink-actions">
            <button class="btn btn-sm btn-primary" data-testid="make-btn" onclick="openDrinkProduction('${esc(m.drink.id)}')">Make</button>
            <button class="btn btn-sm" onclick="openDrinkWriteOff('drink','${esc(m.drink.id)}')">Write-off</button>
          </td>
        </tr>`).join('')}</tbody></table></div>`}

    ${expired.length ? `<h4 class="ord-h" style="color:#d23f3f;">Check freshness — ${expired.length} expired</h4>
      ${expired.map(l => `<div class="ord-card"><div class="ord-card-head"><strong>${esc(drinkName(l.drinkId))}</strong><span class="muted small">made ${esc(l.madeOn)} · expired ${esc(l.expiresOn || '')}</span></div>
        <div class="ord-actions"><button class="btn btn-sm btn-danger" onclick="discardProductionLog('${esc(l.id)}')">Throw out</button></div></div>`).join('')}` : ''}

    <h4 class="ord-h">Recent production</h4>
    ${logs.length === 0 ? '<div class="drinks-empty">No production logged yet.</div>' : logs.slice(0, 12).map(l => `<div class="ord-line">
      <span>${esc(drinkName(l.drinkId))} <span class="muted small">${esc(l.madeBy || '')} · ${esc(l.madeOn)}</span></span>
      <span class="muted">${round1(l.bottlesYielded || l.volumeMl / 1000)} ${l.bottlesYielded ? 'btl' : 'L'} · ${esc(l.status)}</span>
    </div>`).join('')}`;
}

function drinkName(id: string): string { return (S.drinks || []).find(d => d.id === id)?.name || id; }

// ── Production form ──

export function openDrinkProduction(drinkId: string): void {
  const d = (S.drinks || []).find(x => x.id === drinkId);
  if (!d) return;
  showModal(`<div class="drink-form" data-testid="drink-production-form">
    <h3>Make ${esc(d.name)}</h3>
    <p class="muted small">One batch = ${d.batch?.volumeMl || 0} ml${d.batch?.bottleSizeMl ? ` → ${round1((d.batch.volumeMl || 0) / d.batch.bottleSizeMl)} bottles` : ''}.</p>
    <div class="df-grid">
      <label class="df-field">Batches <input id="prod-batches" type="number" min="0.5" step="0.5" value="1" oninput="drinkProductionPreview('${esc(drinkId)}')"></label>
      <label class="df-field">Made by <input id="prod-by" value="${esc(S.user?.name || '')}"></label>
      <label class="df-field">Made on <input id="prod-on" type="date" value="${esc(todayIso())}"></label>
    </div>
    <div class="recipe-cost-preview" id="prod-preview"></div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="drink-production-save" type="button" onclick="submitDrinkProduction('${esc(drinkId)}')">Log production</button>
    </div>
  </div>`);
  drinkProductionPreview(drinkId);
}

export function drinkProductionPreview(drinkId: string): void {
  const d = (S.drinks || []).find(x => x.id === drinkId);
  const panel = document.getElementById('prod-preview');
  if (!d || !panel) return;
  const batches = Number((document.getElementById('prod-batches') as HTMLInputElement)?.value) || 0;
  const made = producedUnits(d, batches);
  const consumed = consumedBuildingBlocks(d, batches);
  const exp = expiryDate(todayIso(), d.shelfLifeDays);
  panel.innerHTML = `
    <span><strong>Makes</strong> ${made.qty} ${made.unit}${made.qty === 1 ? '' : 's'}</span>
    ${exp ? `<span class="muted small">expires ${esc(exp)}</span>` : ''}
    ${consumed.length ? `<span class="muted small">uses ${consumed.map(c => `${c.liters}L ${esc(drinkName(c.drinkId))}`).join(', ')}</span>` : ''}`;
}

export async function submitDrinkProduction(drinkId: string): Promise<void> {
  const batches = Number((document.getElementById('prod-batches') as HTMLInputElement)?.value) || 0;
  if (batches <= 0) { toastError('Enter how many batches.'); return; }
  const madeBy = (document.getElementById('prod-by') as HTMLInputElement)?.value || '';
  const madeOn = (document.getElementById('prod-on') as HTMLInputElement)?.value || todayIso();
  try {
    await apiPost('/api/drinks/production', { id: newId(), drinkId, location: loc(), batches, madeBy, madeOn });
    toast('Production logged — stock updated');
    closeModal();
    await loadDrinks();
    refreshProduction();
  } catch (e: unknown) { toastError('Could not log: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

// ── Write-offs ──

export function openDrinkWriteOff(refKind: string, refId: string): void {
  const name = refKind === 'drink' ? drinkName(refId) : refId;
  const d = refKind === 'drink' ? (S.drinks || []).find(x => x.id === refId) : null;
  const unit = d?.orderUnit || 'unit';
  showModal(`<div class="drink-form" data-testid="drink-writeoff-form">
    <h3>Write off — ${esc(name)}</h3>
    <div class="df-grid">
      <label class="df-field">Quantity (${esc(unit)}) <input id="wo-qty" type="number" min="0" step="0.5" value="1"></label>
      <label class="df-field">Reason
        <select id="wo-reason">${DRINK_WRITEOFF_REASONS.map(r => `<option value="${r.key}">${esc(r.label)}</option>`).join('')}</select>
      </label>
      <label class="df-field df-col2">Note <input id="wo-note" placeholder="optional"></label>
    </div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-danger" data-testid="drink-writeoff-save" type="button" onclick="submitDrinkWriteOff('${esc(refKind)}','${esc(refId)}','${esc(unit)}')">Write off</button>
    </div>
  </div>`);
}

export async function submitDrinkWriteOff(refKind: string, refId: string, unit: string): Promise<void> {
  const qty = Number((document.getElementById('wo-qty') as HTMLInputElement)?.value) || 0;
  if (qty <= 0) { toastError('Enter a quantity.'); return; }
  const reason = (document.getElementById('wo-reason') as HTMLSelectElement)?.value || 'other';
  const note = (document.getElementById('wo-note') as HTMLInputElement)?.value || '';
  try {
    await apiPost('/api/drinks/write-offs', {
      id: newId(), refKind, drinkId: refKind === 'drink' ? refId : null, ingredientId: refKind === 'ingredient' ? refId : null,
      name: refKind === 'drink' ? drinkName(refId) : refId, location: loc(), qty, unit, reason, note,
    });
    toast('Written off — stock reduced');
    closeModal();
    await loadDrinks();
    refreshProduction();
  } catch (e: unknown) { toastError('Could not write off: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

export async function discardProductionLog(id: string): Promise<void> {
  try {
    await apiPost(`/api/drinks/production/${id}/discard`, {});
    toast('Thrown out — recorded as an expired write-off');
    await loadDrinks();
    refreshProduction();
  } catch (e: unknown) { toastError('Could not discard: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}
