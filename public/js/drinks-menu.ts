// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — Assortments & menu designer tab (M8). Per-location assortments
// (testtafel = assortment on centraal stock) + a menu builder: pick an
// assortment, choose a layout preset, live per-location prices, print-ready A4
// via a server-rendered print route. Per DRINKS_DOMAIN.md §5.
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';
import { newId, apiPost, toast, toastError } from './utils';
import { showModal, closeModal, esc } from './modal';
import { drinkCategoryLabel } from './drinks-constants';
import type { Assortment, DrinkMenu, AssortmentEntry } from '@shared/types';

function isManager(): boolean { return !!S.user?.isManager; }

async function fetchAssortments(): Promise<Assortment[]> { try { const r = await (await fetch('/api/drinks/assortments')).json(); return Array.isArray(r) ? r : []; } catch { return []; } }
async function fetchMenus(): Promise<DrinkMenu[]> { try { const r = await (await fetch('/api/drinks/menus')).json(); return Array.isArray(r) ? r : []; } catch { return []; } }

export function renderDrinksMenusTab(): void {
  const body = document.getElementById('drinks-tab-body');
  if (!body) return;
  body.innerHTML = `<div id="drinks-menus-inner"><div class="drinks-empty">Loading…</div></div>`;
  refreshMenus();
}

async function refreshMenus(): Promise<void> {
  const inner = document.getElementById('drinks-menus-inner');
  if (!inner) return;
  const [assortments, menus] = await Promise.all([fetchAssortments(), fetchMenus()]);
  S.assortments = assortments;
  S.drinkMenus = menus;
  inner.innerHTML = `
    <h4 class="ord-h">Assortments</h4>
    ${assortments.length === 0 ? '<div class="drinks-empty">No assortments yet.</div>' : assortments.map(a => `
      <div class="ord-card" data-testid="assortment-card">
        <div class="ord-card-head"><strong>${esc(a.name)}</strong>
          <span class="muted small">${esc(a.location)}${a.serviceContext ? ` · ${esc(a.serviceContext)}` : ''} · ${a.entries?.length || 0} drinks</span></div>
        ${isManager() ? `<div class="ord-actions"><button class="btn btn-sm" onclick="openAssortmentEdit('${esc(a.id)}')">Edit drinks</button></div>` : ''}
      </div>`).join('')}

    <h4 class="ord-h">Menus</h4>
    ${isManager() ? `<div class="drinks-toolbar"><button class="btn btn-primary" data-testid="menu-new" onclick="openMenuForm()">+ New menu</button></div>` : ''}
    ${menus.length === 0 ? '<div class="drinks-empty">No menus yet.</div>' : menus.map(m => `
      <div class="ord-card" data-testid="menu-card" data-id="${esc(m.id)}">
        <div class="ord-card-head"><strong>${esc(m.name)}</strong>
          <span class="muted small">${esc(m.location)} · ${assortmentName(m.assortmentId)} · ${m.published ? 'published' : 'draft'}</span></div>
        <div class="ord-actions">
          <button class="btn btn-sm" data-testid="menu-print" onclick="printDrinkMenu('${esc(m.id)}')">Print</button>
          ${isManager() ? `<button class="btn btn-sm" onclick="openMenuForm('${esc(m.id)}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="deleteDrinkMenu('${esc(m.id)}')">Delete</button>` : ''}
        </div>
      </div>`).join('')}`;
}

function assortmentName(id: string): string { return (S.assortments || []).find(a => a.id === id)?.name || '—'; }

// ── Assortment entry editor ──

let _aEdit: { id: string; entries: AssortmentEntry[] } | null = null;

export function openAssortmentEdit(id: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const a = (S.assortments || []).find(x => x.id === id);
  if (!a) return;
  _aEdit = { id, entries: (a.entries || []).map(e => ({ ...e })) };
  const inSet = new Set(_aEdit.entries.map(e => e.drinkId));
  // Drinks available for this assortment's location, grouped by category.
  const drinks = (S.drinks || []).filter(d => !d.archived && (d.locations?.[a.location]?.active !== false))
    .sort((x, y) => x.category === y.category ? x.name.localeCompare(y.name) : x.category.localeCompare(y.category));
  let lastCat = '';
  const rows = drinks.map(d => {
    const head = d.category !== lastCat ? `<div class="am-cat">${esc(drinkCategoryLabel(d.category))}</div>` : '';
    lastCat = d.category;
    return `${head}<label class="am-row"><input type="checkbox" data-id="${esc(d.id)}" ${inSet.has(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>`;
  }).join('');
  showModal(`<div class="drink-form" data-testid="assortment-edit">
    <h3>Edit ${esc(a.name)}</h3>
    <p class="muted small">Tick the drinks offered in this assortment (${esc(a.location)}).</p>
    <div class="am-list">${rows}</div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="assortment-save" type="button" onclick="saveAssortmentEdit()">Save</button>
    </div>
  </div>`);
}

export async function saveAssortmentEdit(): Promise<void> {
  if (!_aEdit) return;
  const checked = Array.from(document.querySelectorAll('.am-list input[type="checkbox"]:checked')).map(el => (el as HTMLInputElement).dataset.id!);
  const entries = checked.map(drinkId => ({ drinkId }));
  try {
    await apiPost(`/api/drinks/assortments/${_aEdit.id}`, { entries }, 'PATCH');
    toast('Assortment saved');
    _aEdit = null;
    closeModal();
    refreshMenus();
  } catch (e: unknown) { toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

// ── Menu form ──

export function openMenuForm(id?: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const m = id ? (S.drinkMenus || []).find(x => x.id === id) : null;
  const assortments = S.assortments || [];
  const layout = m?.layout || { columns: 1, sectionStyle: 'default', typeScale: 'normal' };
  showModal(`<div class="drink-form" data-testid="menu-form">
    <div class="df-grid">
      <label class="df-field df-col2">Menu name <input id="menu-name" data-testid="menu-name" value="${m ? esc(m.name) : ''}" placeholder="e.g. West Bar — Spring"></label>
      <label class="df-field df-col2">Assortment
        <select id="menu-assortment">${assortments.map(a => `<option value="${esc(a.id)}" ${a.id === m?.assortmentId ? 'selected' : ''}>${esc(a.name)} (${esc(a.location)})</option>`).join('')}</select>
      </label>
      <label class="df-field">Columns
        <select id="menu-columns"><option value="1" ${layout.columns === 1 ? 'selected' : ''}>1</option><option value="2" ${layout.columns === 2 ? 'selected' : ''}>2</option></select>
      </label>
      <label class="df-field">Type scale
        <select id="menu-typescale">${['compact', 'normal', 'large'].map(s => `<option value="${s}" ${s === layout.typeScale ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </label>
      <label class="df-field">Section style
        <select id="menu-sectionstyle">${['default', 'minimal', 'bold'].map(s => `<option value="${s}" ${s === layout.sectionStyle ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </label>
      <label class="df-field df-check"><input id="menu-published" type="checkbox" ${m?.published ? 'checked' : ''}> Published</label>
    </div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="menu-save" type="button" onclick="saveMenuForm('${m ? esc(m.id) : ''}')">${m ? 'Save' : 'Create menu'}</button>
    </div>
  </div>`);
}

export async function saveMenuForm(existingId: string): Promise<void> {
  const name = (document.getElementById('menu-name') as HTMLInputElement)?.value.trim();
  if (!name) { toastError('Name is required.'); return; }
  const assortmentId = (document.getElementById('menu-assortment') as HTMLSelectElement)?.value;
  if (!assortmentId) { toastError('Pick an assortment.'); return; }
  const assortment = (S.assortments || []).find(a => a.id === assortmentId);
  const layout = {
    columns: Number((document.getElementById('menu-columns') as HTMLSelectElement)?.value) === 2 ? 2 : 1,
    sectionStyle: (document.getElementById('menu-sectionstyle') as HTMLSelectElement)?.value || 'default',
    typeScale: (document.getElementById('menu-typescale') as HTMLSelectElement)?.value || 'normal',
  };
  const published = (document.getElementById('menu-published') as HTMLInputElement)?.checked || false;
  const payload = { id: existingId || newId(), name, assortmentId, location: assortment?.location || 'west', sections: [], layout, published };
  try {
    await apiPost(existingId ? `/api/drinks/menus/${existingId}` : '/api/drinks/menus', payload, existingId ? 'PATCH' : 'POST');
    toast(existingId ? 'Menu saved' : 'Menu created');
    closeModal();
    refreshMenus();
  } catch (e: unknown) { toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

export function printDrinkMenu(id: string): void { window.open(`/api/drinks/menus/${id}/print`, '_blank'); }

export async function deleteDrinkMenu(id: string): Promise<void> {
  try { await apiPost(`/api/drinks/menus/${id}`, {}, 'DELETE'); toast('Menu deleted'); refreshMenus(); }
  catch (e: unknown) { toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}
