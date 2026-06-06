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
import type { Assortment, DrinkMenu, Drink } from '@shared/types';

function isManager(): boolean { return !!S.user?.isManager; }

/** Rows for a searchable, category-grouped drink checkbox list. Checked state
 *  is read from `checked` (the caller's Set) so it survives search re-renders. */
function drinkCheckRows(drinks: Drink[], checked: Set<string>, filter: string, toggleFn: string): string {
  const q = filter.trim().toLowerCase();
  const list = q
    ? drinks.filter(d => d.name.toLowerCase().includes(q) || (d.subtype || '').toLowerCase().includes(q) || drinkCategoryLabel(d.category).toLowerCase().includes(q))
    : drinks;
  if (list.length === 0) return '<div class="muted small" style="padding:8px;">No matches.</div>';
  let lastCat = '';
  return list.map(d => {
    const head = d.category !== lastCat ? `<div class="am-cat">${esc(drinkCategoryLabel(d.category))}</div>` : '';
    lastCat = d.category;
    return `${head}<label class="am-row"><input type="checkbox" data-id="${esc(d.id)}" ${checked.has(d.id) ? 'checked' : ''} onchange="${toggleFn}('${esc(d.id)}', this.checked)"> ${esc(d.name)}${d.subtype ? ` <span class="muted small">${esc(d.subtype)}</span>` : ''}</label>`;
  }).join('');
}

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

let _aEdit: { id: string; checked: Set<string>; drinks: Drink[] } | null = null;

export function openAssortmentEdit(id: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const a = (S.assortments || []).find(x => x.id === id);
  if (!a) return;
  // Drinks available for this assortment's location, grouped by category.
  const drinks = (S.drinks || []).filter(d => !d.archived && (d.locations?.[a.location]?.active !== false))
    .sort((x, y) => x.category === y.category ? x.name.localeCompare(y.name) : x.category.localeCompare(y.category));
  _aEdit = { id, checked: new Set((a.entries || []).map(e => e.drinkId)), drinks };
  showModal(`<div class="drink-form" data-testid="assortment-edit">
    <h3>Edit ${esc(a.name)}</h3>
    <p class="muted small">Tick the drinks offered in this assortment (${esc(a.location)}).</p>
    <input class="drinks-search" id="am-search" data-testid="assortment-search" placeholder="Search drinks…" oninput="assortmentEditSearch(this.value)">
    <div class="am-list" id="am-list">${drinkCheckRows(drinks, _aEdit.checked, '', 'assortmentEditToggle')}</div>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="assortment-save" type="button" onclick="saveAssortmentEdit()">Save</button>
    </div>
  </div>`);
}

export function assortmentEditToggle(id: string, on: boolean): void {
  if (!_aEdit) return;
  if (on) _aEdit.checked.add(id); else _aEdit.checked.delete(id);
}

export function assortmentEditSearch(v: string): void {
  if (!_aEdit) return;
  const list = document.getElementById('am-list');
  if (list) list.innerHTML = drinkCheckRows(_aEdit.drinks, _aEdit.checked, v, 'assortmentEditToggle');
}

export async function saveAssortmentEdit(): Promise<void> {
  if (!_aEdit) return;
  const entries = [..._aEdit.checked].map(drinkId => ({ drinkId }));
  try {
    await apiPost(`/api/drinks/assortments/${_aEdit.id}`, { entries }, 'PATCH');
    toast('Assortment saved');
    _aEdit = null;
    closeModal();
    refreshMenus();
  } catch (e: unknown) { toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

// ── Menu form ──

/** Drinks belonging to an assortment (its entries → S.drinks), category-sorted. */
function assortmentDrinks(assortmentId: string): Drink[] {
  const a = (S.assortments || []).find(x => x.id === assortmentId);
  if (!a) return [];
  const ids = new Set((a.entries || []).map(e => e.drinkId));
  return (S.drinks || []).filter(d => ids.has(d.id) && !d.archived)
    .sort((x, y) => x.category === y.category ? x.name.localeCompare(y.name) : x.category.localeCompare(y.category));
}

let _menuPick: { checked: Set<string>; drinks: Drink[] } | null = null;

export function openMenuForm(id?: string): void {
  if (!isManager()) { toastError('Manager access required.'); return; }
  const m = id ? (S.drinkMenus || []).find(x => x.id === id) : null;
  const assortments = S.assortments || [];
  if (assortments.length === 0) { toastError('Create an assortment first.'); return; }
  const layout = m?.layout || { columns: 1, sectionStyle: 'default', typeScale: 'normal' };
  const assortmentId = m?.assortmentId || assortments[0].id;
  const drinks = assortmentDrinks(assortmentId);
  // Default selection: the menu's saved subset, else the whole assortment.
  const savedIds = (m?.sections || []).flatMap(s => s.drinkIds || []);
  _menuPick = { checked: new Set(savedIds.length ? savedIds : drinks.map(d => d.id)), drinks };
  showModal(`<div class="drink-form" data-testid="menu-form">
    <div class="df-grid">
      <label class="df-field df-col2">Menu name <input id="menu-name" data-testid="menu-name" value="${m ? esc(m.name) : ''}" placeholder="e.g. Centraal — Lunch drinks"></label>
      <label class="df-field df-col2">Assortment
        <select id="menu-assortment" onchange="menuFormAssortmentChange(this.value)">${assortments.map(a => `<option value="${esc(a.id)}" ${a.id === assortmentId ? 'selected' : ''}>${esc(a.name)} (${esc(a.location)})</option>`).join('')}</select>
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
      <label class="df-field">Page size
        <select id="menu-pagesize">${['A4', 'A5'].map(s => `<option value="${s}" ${s === (layout.pageSize || 'A4') ? 'selected' : ''}>${s}</option>`).join('')}</select>
      </label>
      <label class="df-field">Template
        <select id="menu-template"><option value="classic" ${(layout.template || 'classic') === 'classic' ? 'selected' : ''}>Classic (serif)</option><option value="mono" ${layout.template === 'mono' ? 'selected' : ''}>Bar (monospace)</option></select>
      </label>
      <label class="df-field df-check"><input id="menu-published" type="checkbox" ${m?.published ? 'checked' : ''}> Published</label>
      <label class="df-field df-col2">Footer line <input id="menu-footer" value="${m?.layout?.footer ? esc(m.layout.footer) : ''}" placeholder="e.g. @de_sering | @testtafel | @mediamatic_eten"></label>
    </div>
    <fieldset class="df-section">
      <legend>Drinks on this menu</legend>
      <p class="muted small">Tick which drinks appear — a lunch menu can differ from a wine menu. <button type="button" class="btn btn-sm" onclick="menuPickAll(true)">All</button> <button type="button" class="btn btn-sm" onclick="menuPickAll(false)">None</button></p>
      <input class="drinks-search" id="menu-pick-search" placeholder="Search drinks…" oninput="menuPickSearch(this.value)">
      <div class="am-list" id="menu-pick-list">${drinkCheckRows(drinks, _menuPick.checked, '', 'menuPickToggle')}</div>
    </fieldset>
    <div class="modal-actions">
      <button class="btn" type="button" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" data-testid="menu-save" type="button" onclick="saveMenuForm('${m ? esc(m.id) : ''}')">${m ? 'Save' : 'Create menu'}</button>
    </div>
  </div>`);
}

export function menuFormAssortmentChange(assortmentId: string): void {
  const drinks = assortmentDrinks(assortmentId);
  _menuPick = { checked: new Set(drinks.map(d => d.id)), drinks }; // new assortment → start with all
  const search = document.getElementById('menu-pick-search') as HTMLInputElement | null;
  if (search) search.value = '';
  const list = document.getElementById('menu-pick-list');
  if (list) list.innerHTML = drinkCheckRows(drinks, _menuPick.checked, '', 'menuPickToggle');
}

export function menuPickToggle(id: string, on: boolean): void {
  if (!_menuPick) return;
  if (on) _menuPick.checked.add(id); else _menuPick.checked.delete(id);
}

export function menuPickSearch(v: string): void {
  if (!_menuPick) return;
  const list = document.getElementById('menu-pick-list');
  if (list) list.innerHTML = drinkCheckRows(_menuPick.drinks, _menuPick.checked, v, 'menuPickToggle');
}

export function menuPickAll(on: boolean): void {
  if (!_menuPick) return;
  _menuPick.checked = new Set(on ? _menuPick.drinks.map(d => d.id) : []);
  const search = document.getElementById('menu-pick-search') as HTMLInputElement | null;
  menuPickSearch(search?.value || '');
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
    pageSize: (document.getElementById('menu-pagesize') as HTMLSelectElement)?.value || 'A4',
    template: (document.getElementById('menu-template') as HTMLSelectElement)?.value || 'classic',
    footer: (document.getElementById('menu-footer') as HTMLInputElement)?.value.trim() || '',
  };
  const published = (document.getElementById('menu-published') as HTMLInputElement)?.checked || false;
  // Persist the chosen subset as a single section; empty → print shows the whole assortment.
  const drinkIds = _menuPick ? [..._menuPick.checked] : [];
  const sections = drinkIds.length ? [{ title: '', drinkIds }] : [];
  const payload = { id: existingId || newId(), name, assortmentId, location: assortment?.location || 'west', sections, layout, published };
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
