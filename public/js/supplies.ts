import type { Supply, SupplyKind, SupplyPrepMode, RecipeFull } from '@shared/types';
import { S } from './state';
import { apiGet, apiPost, toast, toastError, todayIso, newId } from './utils';
import { showModal, closeModal, esc } from './modal';
import { registerRenderer, rerenderCurrentView } from './navigate';
import { computeSupplyDemand, supplyPricePerGuest } from '@shared/supply-demand';

/** The linked recipe's computed per-unit cost. For count recipes
 *  costPerServing IS cost per output unit; for volume recipes it's per
 *  serving. Returns null when there's no usable recipe cost. */
function recipeUnitCost(recipeId: string | null): { cost: number; unit: string } | null {
  if (!recipeId) return null;
  const r = (S.recipes || []).find((x: RecipeFull) => x.id === recipeId);
  if (!r || r.costPerServing == null || r.costPerServing <= 0) return null;
  return { cost: r.costPerServing, unit: r.yieldType === 'count' ? (r.outputUnit || 'unit') : 'serving' };
}

/** HTML for the recipe-cost estimate hint under the cost field. */
function recipeCostHintHtml(recipeId: string | null): string {
  const est = recipeUnitCost(recipeId);
  if (!est) return '';
  return `Linked recipe estimates <strong>&euro;${est.cost.toFixed(2)}</strong> per ${esc(est.unit)}. ` +
    `<a href="javascript:void(0)" onclick="suppliesUseCostEstimate(${est.cost})">Use this</a>`;
}

// ── Supplies screen ────────────────────────────────────────────────────────
// CRUD for standard + one-off supplies. Lives at NAV_SCREENS id='supplies'.
// Renders a table with stock vs forward demand per location, plus a "+ New"
// button. Edits go through a modal.

const PRESERVATION_METHODS = [
  'Lacto ferment',
  'Sugar preservation',
  'Pickling (vinegar-based)',
  'pickling',
  'Oil preservation',
  'Air drying',
  'Vinegar fermentation',
  'Yeast fermentation',
  'Koji fermentation',
  'Stock base',
] as const;

let _includeArchived = false;
let _searchQuery = '';

export async function loadSupplies(): Promise<void> {
  try {
    const list = await apiGet('/api/supplies' + (_includeArchived ? '?includeArchived=1' : '')) as Supply[];
    S.supplies = Array.isArray(list) ? list : [];
  } catch (e: unknown) {
    S.supplies = [];
    toastError('Failed to load toppings & bread: ' + (e instanceof Error ? e.message : 'unknown error'));
  }
}

export async function renderSupplies(): Promise<void> {
  const el = document.getElementById('screen-supplies');
  if (!el) return;
  await loadSupplies();
  el.innerHTML = `
    <div class="screen-header" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
      <h2 style="margin:0;">Toppings &amp; bread</h2>
      <div style="display:flex;gap:8px;align-items:center;">
        <input type="text" class="dish-search" id="sup-search" placeholder="Search toppings &amp; bread&hellip;" value="${esc(_searchQuery)}"
          oninput="suppliesSetSearch((document.getElementById('sup-search')||{}).value||'')" style="max-width:240px;" />
        <label style="font-size:12px;display:flex;gap:4px;align-items:center;">
          <input type="checkbox" id="sup-incl-arch" ${_includeArchived ? 'checked' : ''} onchange="suppliesToggleArchived()" /> Include archived
        </label>
        <button class="btn btn-primary" data-testid="supplies-new" onclick="suppliesOpenNewKindPicker()">+ New item</button>
      </div>
    </div>
    <div id="supplies-results"></div>
  `;
  updateSupplyResults();
}

export function suppliesSetSearch(q: string): void {
  _searchQuery = q;
  updateSupplyResults();
}

export async function suppliesToggleArchived(): Promise<void> {
  _includeArchived = !_includeArchived;
  await loadSupplies();
  updateSupplyResults();
}

function updateSupplyResults(): void {
  const el = document.getElementById('supplies-results');
  if (!el) return;
  const q = _searchQuery.toLowerCase();
  const list = (S.supplies || []).filter((s) => !q || s.name.toLowerCase().includes(q));
  if (list.length === 0) {
    el.innerHTML = `<div class="empty">No toppings or bread${q ? ` matching "${esc(q)}"` : ''} yet. Click "+ New item" to add one.</div>`;
    return;
  }
  const todayStr = todayIso();
  const standard = list.filter((s) => s.kind === 'standard');
  const oneoff = list.filter((s) => s.kind === 'oneoff');

  let html = '';
  if (standard.length > 0) {
    html += renderSupplyTable('Standard', standard, todayStr);
  }
  if (oneoff.length > 0) {
    html += renderSupplyTable('One-off', oneoff, todayStr);
  }
  el.innerHTML = html;
}

function renderSupplyTable(label: string, list: Supply[], todayStr: string): string {
  const rows = list.map((s) => renderSupplyRow(s, todayStr)).join('');
  return `
    <div class="card" style="margin-bottom:12px;">
      <h3 style="margin:0 0 8px;">${esc(label)}</h3>
      <table class="supplies-table" style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="text-align:left;color:var(--text2);">
            <th style="padding:6px 4px;">Name</th>
            <th>Unit</th>
            <th>Mode</th>
            <th>Stock West</th>
            <th>Stock Centraal</th>
            <th>Demand (next horizon)</th>
            <th>Cost / guest</th>
            <th>Method</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function renderSupplyRow(s: Supply, todayStr: string): string {
  const stockWest = s.stock?.west?.amount ?? 0;
  const stockCentraal = s.stock?.centraal?.amount ?? 0;
  const demand = computeSupplyDemand(s, S.guests, S.caterings || [], todayStr);
  let demandCell = '';
  if (s.kind === 'standard') {
    const dWest = Math.round(demand.west);
    const dCentraal = Math.round(demand.centraal);
    const deficitW = dWest - stockWest;
    const deficitC = dCentraal - stockCentraal;
    const wColor = deficitW > 0 ? 'var(--red)' : 'var(--text2)';
    const cColor = deficitC > 0 ? 'var(--red)' : 'var(--text2)';
    demandCell = `<span style="color:${wColor};">W: ${dWest} ${esc(s.unit)}</span>` +
                 (s.prepMode === 'per-location' ? ` &middot; <span style="color:${cColor};">C: ${dCentraal} ${esc(s.unit)}</span>` : '');
  } else {
    demandCell = `<span style="color:var(--text3);">drip-feed ${s.unitsPerService ?? 0} ${esc(s.unit)}/service</span>`;
  }
  const archivedTag = s.archived ? ` <span class="badge" style="background:var(--bg2);color:var(--text3);font-size:10px;">archived</span>` : '';
  const modeLabel = s.kind === 'standard'
    ? `${s.prepMode === 'centralized' ? 'Centralized' : 'Per-location'} &middot; ${s.prepHorizonDays}d horizon &middot; 1 ${esc(s.unit)} / ${s.guestsPerUnit} guests`
    : `One-off @ ${s.oneoffLocation === 'west' ? 'West' : 'Centraal'} &middot; ${s.unitsPerService} ${esc(s.unit)}/service from ${s.oneoffStartDate}`;
  // Cost / guest = costPerUnit ÷ guestsPerUnit (standards only).
  const ppg = supplyPricePerGuest(s);
  let costCell: string;
  if (ppg != null) {
    costCell = `<span style="font-weight:500;">&euro;${ppg.toFixed(3)}</span><span style="font-size:10px;color:var(--text3);"> /guest</span>`;
  } else if (s.costPerUnit != null) {
    costCell = `<span style="color:var(--text2);">&euro;${s.costPerUnit.toFixed(2)} /${esc(s.unit)}</span>`;
  } else {
    costCell = `<span style="color:var(--text3);">&mdash;</span>`;
  }
  return `<tr style="border-top:1px solid var(--border);">
    <td style="padding:6px 4px;font-weight:500;">${esc(s.name)}${archivedTag}</td>
    <td>${esc(s.unit)}</td>
    <td style="font-size:11px;color:var(--text2);">${modeLabel}</td>
    <td>${stockWest}${s.stock?.west?.lastMakeDate ? `<br><span style="font-size:10px;color:var(--text3);">${s.stock.west.lastMakeDate}</span>` : ''}</td>
    <td>${stockCentraal}${s.stock?.centraal?.lastMakeDate ? `<br><span style="font-size:10px;color:var(--text3);">${s.stock.centraal.lastMakeDate}</span>` : ''}</td>
    <td>${demandCell}</td>
    <td>${costCell}</td>
    <td>${esc(s.preservationMethod || '')}</td>
    <td style="text-align:right;white-space:nowrap;">
      <button class="btn btn-sm" onclick="suppliesOpenEdit('${esc(s.id)}')">Edit</button>
      <button class="btn btn-sm" onclick="suppliesOpenLogPrep('${esc(s.id)}')">Log prep</button>
      <button class="btn btn-sm btn-danger" onclick="suppliesDelete('${esc(s.id)}')">${s.archived ? '&times;' : 'Delete'}</button>
    </td>
  </tr>`;
}

// ── New supply: pick kind, then per-kind form ──

export function suppliesOpenNewKindPicker(): void {
  showModal(`<h3>New topping or bread</h3>
    <p style="margin:0 0 12px;color:var(--text2);">What kind of item is this?</p>
    <div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap;gap:8px;">
      <button class="btn btn-primary" onclick="suppliesOpenNew('standard')">Standard (recurring, ratio &times; guests)</button>
      <button class="btn btn-primary" onclick="suppliesOpenNew('oneoff')">One-off (drip-feed until depleted)</button>
      <button class="btn" onclick="closeModal()">Cancel</button>
    </div>`);
}

export function suppliesOpenNew(kind: SupplyKind): void {
  const empty: Supply = {
    id: newId(),
    name: '',
    kind,
    unit: kind === 'oneoff' ? 'jars' : 'boxes',
    recipeId: null,
    guestsPerUnit: kind === 'standard' ? 10 : null,
    prepHorizonDays: kind === 'standard' ? 1 : null,
    prepMode: kind === 'standard' ? 'centralized' : null,
    oneoffLocation: kind === 'oneoff' ? 'west' : null,
    unitsPerService: kind === 'oneoff' ? 1 : null,
    oneoffStartDate: kind === 'oneoff' ? todayIso() : null,
    stock: { west: { amount: 0, lastMakeDate: null }, centraal: { amount: 0, lastMakeDate: null } },
    costPerUnit: null,
    preservationMethod: null,
    archived: false,
  };
  showSupplyEditor(empty, true);
}

export function suppliesOpenEdit(id: string): void {
  const s = (S.supplies || []).find((x) => x.id === id);
  if (!s) return;
  showSupplyEditor(s, false);
}

function showSupplyEditor(s: Supply, isNew: boolean): void {
  const recipeOpts = (S.recipes || [])
    .map((r: RecipeFull) => `<option value="${esc(r.id)}"${r.id === s.recipeId ? ' selected' : ''}>${esc(r.name)}</option>`)
    .join('');
  const methodOpts = PRESERVATION_METHODS
    .map((m) => `<option value="${esc(m)}"${m === s.preservationMethod ? ' selected' : ''}>${esc(m)}</option>`)
    .join('');
  const kindLabel = s.kind === 'standard' ? 'Standard item' : 'One-off item';
  const unitLabel = esc(s.unit || 'unit');
  const standardFields = s.kind === 'standard' ? `
    <div class="fr"><label>Guests served per ${unitLabel}</label>
      <input type="number" step="0.5" min="0.5" id="sup-gpu" value="${s.guestsPerUnit ?? ''}" placeholder="e.g. 10" />
      <div class="sup-help">How many guests one ${unitLabel} covers. "1 bread per 10 people" &rarr; <strong>10</strong>. "10 breads = 65 people" &rarr; <strong>6.5</strong>.</div></div>
    <div class="fr"><label>Prep horizon (days)</label>
      <input type="number" min="1" max="60" id="sup-horizon" value="${s.prepHorizonDays ?? 1}" />
      <div class="sup-help">How many days ahead this is prepped in one go. The dashboard sums guest demand across this many days to tell you how much to make. Chopped herbs &rarr; <strong>1</strong> (day before only). Aioli &rarr; <strong>4</strong> (improves with rest). Pickles &rarr; <strong>14</strong>.</div></div>
    <div class="fr"><label>Prep mode</label>
      <select id="sup-mode">
        <option value="centralized"${s.prepMode === 'centralized' ? ' selected' : ''}>Centralized (made at West, transported)</option>
        <option value="per-location"${s.prepMode === 'per-location' ? ' selected' : ''}>Per-location (each kitchen preps own)</option>
      </select></div>
  ` : '';
  const oneoffFields = s.kind === 'oneoff' ? `
    <div class="fr"><label>Location</label>
      <select id="sup-loc">
        <option value="west"${s.oneoffLocation === 'west' ? ' selected' : ''}>Sering West</option>
        <option value="centraal"${s.oneoffLocation === 'centraal' ? ' selected' : ''}>Sering Centraal</option>
      </select></div>
    <div class="fr"><label>Units per service</label>
      <input type="number" step="0.5" min="0.01" id="sup-ups" value="${s.unitsPerService ?? 1}" /></div>
    <div class="fr"><label>Start date (drip-feed begins)</label>
      <input type="date" id="sup-start" value="${esc(s.oneoffStartDate || todayIso())}" /></div>
  ` : '';
  showModal(`<h3>${esc(isNew ? 'New ' : 'Edit ')}${esc(kindLabel.toLowerCase())}</h3>
    <input type="hidden" id="sup-id" value="${esc(s.id)}" />
    <input type="hidden" id="sup-kind" value="${esc(s.kind)}" />
    <div class="fr"><label>Name</label><input type="text" id="sup-name" value="${esc(s.name)}" placeholder="e.g. Aioli, Sourdough, Chimichurri" /></div>
    <div class="fr"><label>Unit</label>
      <input type="text" id="sup-unit" value="${esc(s.unit)}" placeholder="boxes / bottles / jars / pieces / g / ml" list="sup-unit-options" autocomplete="off" />
      <datalist id="sup-unit-options">
        <option value="boxes"></option>
        <option value="bottles"></option>
        <option value="jars"></option>
        <option value="pieces"></option>
        <option value="bunches"></option>
        <option value="loaves"></option>
        <option value="g"></option>
        <option value="kg"></option>
        <option value="ml"></option>
        <option value="l"></option>
      </datalist>
    </div>
    ${standardFields}
    ${oneoffFields}
    <div class="fr"><label>Recipe (optional)</label>
      <select id="sup-recipe" onchange="suppliesUpdateRecipeHint()">
        <option value=""${!s.recipeId ? ' selected' : ''}>— no recipe —</option>
        ${recipeOpts}
      </select></div>
    <div class="fr"><label>Cost per ${unitLabel} (&euro;)</label>
      <input type="number" step="0.01" min="0" id="sup-cost" value="${s.costPerUnit ?? ''}" placeholder="e.g. 2.50" />
      <div class="sup-help" id="sup-cost-hint">${recipeCostHintHtml(s.recipeId)}</div>
      <div class="sup-help">Drives <strong>price per guest</strong> = cost &divide; guests-per-${unitLabel}. Enter what one ${unitLabel} costs to buy or make.</div></div>
    <div class="fr"><label>Preservation method (optional, for tagging)</label>
      <select id="sup-method">
        <option value=""${!s.preservationMethod ? ' selected' : ''}>— none —</option>
        ${methodOpts}
      </select></div>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="btn btn-danger btn-sm" onclick="suppliesDelete('${esc(s.id)}')">Delete</button>`}
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="suppliesSave(${isNew ? 'true' : 'false'})">${esc(isNew ? 'Create' : 'Save')}</button>
    </div>`);
  setTimeout(() => (document.getElementById('sup-name') as HTMLInputElement | null)?.focus(), 0);
}

/** Recompute the recipe-cost hint when the linked recipe changes. */
export function suppliesUpdateRecipeHint(): void {
  const sel = document.getElementById('sup-recipe') as HTMLSelectElement | null;
  const hint = document.getElementById('sup-cost-hint');
  if (!sel || !hint) return;
  hint.innerHTML = recipeCostHintHtml(sel.value || null);
}

/** Fill the cost field from a recipe-cost estimate (the "Use this" link). */
export function suppliesUseCostEstimate(amount: number): void {
  const input = document.getElementById('sup-cost') as HTMLInputElement | null;
  if (input) input.value = String(amount);
}

interface SupplySavePayload {
  id: string;
  name: string;
  kind: SupplyKind;
  unit: string;
  recipeId: string | null;
  guestsPerUnit: number | null;
  prepHorizonDays: number | null;
  prepMode: SupplyPrepMode | null;
  oneoffLocation: string | null;
  unitsPerService: number | null;
  oneoffStartDate: string | null;
  costPerUnit: number | null;
  preservationMethod: string | null;
}

export async function suppliesSave(isNew: boolean): Promise<void> {
  const id = (document.getElementById('sup-id') as HTMLInputElement).value;
  const kind = (document.getElementById('sup-kind') as HTMLInputElement).value as SupplyKind;
  const name = ((document.getElementById('sup-name') as HTMLInputElement).value || '').trim();
  if (!name) { alert('Please enter a name'); return; }
  const unit = ((document.getElementById('sup-unit') as HTMLInputElement).value || '').trim() || 'boxes';
  const recipeId = ((document.getElementById('sup-recipe') as HTMLSelectElement).value || '').trim() || null;
  const preservationMethod = ((document.getElementById('sup-method') as HTMLSelectElement).value || '').trim() || null;
  const costRaw = (document.getElementById('sup-cost') as HTMLInputElement).value;
  const costPerUnit = costRaw.trim() === '' ? null : (parseFloat(costRaw) || 0);

  const payload: SupplySavePayload = {
    id,
    name,
    kind,
    unit,
    recipeId,
    costPerUnit,
    preservationMethod,
    guestsPerUnit: null,
    prepHorizonDays: null,
    prepMode: null,
    oneoffLocation: null,
    unitsPerService: null,
    oneoffStartDate: null,
  };

  if (kind === 'standard') {
    payload.guestsPerUnit = parseFloat((document.getElementById('sup-gpu') as HTMLInputElement).value) || 0;
    payload.prepHorizonDays = parseInt((document.getElementById('sup-horizon') as HTMLInputElement).value, 10) || 1;
    payload.prepMode = (document.getElementById('sup-mode') as HTMLSelectElement).value as SupplyPrepMode;
    if (payload.guestsPerUnit <= 0) { alert('Guests served per unit must be greater than 0'); return; }
  } else {
    payload.oneoffLocation = (document.getElementById('sup-loc') as HTMLSelectElement).value;
    payload.unitsPerService = parseFloat((document.getElementById('sup-ups') as HTMLInputElement).value) || 1;
    payload.oneoffStartDate = (document.getElementById('sup-start') as HTMLInputElement).value || todayIso();
  }

  try {
    if (isNew) {
      await apiPost('/api/supplies', payload);
      toast(`"${name}" created`);
    } else {
      await apiPost('/api/supplies/' + encodeURIComponent(id), payload, 'PATCH');
      toast(`"${name}" saved`);
    }
    closeModal();
    rerenderCurrentView();
  } catch (e: unknown) {
    toastError('Save failed: ' + (e instanceof Error ? e.message : 'unknown'));
  }
}

export async function suppliesDelete(id: string): Promise<void> {
  const s = (S.supplies || []).find((x) => x.id === id);
  if (!s) return;
  if (!confirm(`Delete "${s.name}"? This is permanent.`)) return;
  try {
    await apiPost('/api/supplies/' + encodeURIComponent(id), null, 'DELETE');
    closeModal();
    toast(`"${s.name}" deleted`);
    rerenderCurrentView();
  } catch (e: unknown) {
    toastError(e instanceof Error ? e.message : 'Delete failed');
  }
}

// ── Log prep — adds amount to stock, stamps lastMakeDate ──

export function suppliesOpenLogPrep(id: string, suggestedAmount?: number, suggestedLoc?: string): void {
  const s = (S.supplies || []).find((x) => x.id === id);
  if (!s) return;
  // Default location: the prep-checklist task's location if given, else
  // oneoffLocation for one-offs, else West (cook can change).
  const defaultLoc = suggestedLoc || (s.kind === 'oneoff' ? (s.oneoffLocation || 'west') : 'west');
  const amountVal = (suggestedAmount != null && suggestedAmount > 0) ? String(suggestedAmount) : '';
  showModal(`<h3>Log prep — ${esc(s.name)}</h3>
    <p style="margin:0 0 12px;color:var(--text2);">Adds to the stock pool at the chosen location and stamps today's date.</p>
    <input type="hidden" id="sup-prep-id" value="${esc(s.id)}" />
    <div class="fr"><label>Location</label>
      <select id="sup-prep-loc">
        <option value="west"${defaultLoc === 'west' ? ' selected' : ''}>Sering West</option>
        <option value="centraal"${defaultLoc === 'centraal' ? ' selected' : ''}>Sering Centraal</option>
      </select></div>
    <div class="fr"><label>Amount made (${esc(s.unit)})</label>
      <input type="number" step="0.5" min="0.01" id="sup-prep-amount" value="${amountVal}" placeholder="e.g. 800" /></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="suppliesSubmitPrep()">Log prep</button>
    </div>`);
  setTimeout(() => (document.getElementById('sup-prep-amount') as HTMLInputElement | null)?.focus(), 0);
}

export async function suppliesSubmitPrep(): Promise<void> {
  const id = (document.getElementById('sup-prep-id') as HTMLInputElement).value;
  const location = (document.getElementById('sup-prep-loc') as HTMLSelectElement).value;
  const amount = parseFloat((document.getElementById('sup-prep-amount') as HTMLInputElement).value);
  if (!Number.isFinite(amount) || amount <= 0) { alert('Enter a positive amount'); return; }
  try {
    await apiPost(`/api/supplies/${encodeURIComponent(id)}/prep`, { location, amount });
    toast(`+${amount} added to stock @ ${location}`);
    closeModal();
    rerenderCurrentView();
  } catch (e: unknown) {
    toastError('Log prep failed: ' + (e instanceof Error ? e.message : 'unknown'));
  }
}

registerRenderer('supplies', renderSupplies);
