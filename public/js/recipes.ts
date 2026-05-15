import { S, ALLERGENS, INGREDIENT_TYPES, PRICE_LEVELS } from './state';
import { newId, scheduleSave, toast, toastError, apiGet, apiPost } from './utils';
import { pushUndo } from './undo';
import { rebuildPlanner, typeBadge, typeBadgeClass, TYPES, chipClass } from './core';
import { showModal, closeModal, esc } from './modal';
import { doLogout } from './auth';
import { openRecipeEditor, openRecipeDetail } from './recipe-editor';
import type { DishType, Batch } from '@shared/types';
import { registerRenderer } from './navigate';

// ── RECIPE INDEX ──────────────────────────────────────────
export let riSearch = '';
export let riTypeFilter = 'all';
export let riSort = { col: 'name', dir: 'asc' };

export function updateRiSearch(el: any) {
  riSearch = el.value;
  updateRecipeResults();
}

export function parseCost(s: any) {
  if (!s) return null;
  const m = s.toString().replace(/[^0-9.,]/g,'').replace(',','.');
  return parseFloat(m) || null;
}

export function costColor(cost: any, allCosts: any) {
  if (cost === null || allCosts.length < 2) return '';
  const min = Math.min(...allCosts);
  const max = Math.max(...allCosts);
  const isDark = window.matchMedia('(prefers-color-scheme:dark)').matches;
  const light = isDark ? 28 : 82;
  const sat = isDark ? 40 : 70;
  const txtCol = isDark ? '#f0efe9' : '#333';
  if (max === min) return `background:hsl(45,${sat}%,${light}%);color:${txtCol};`;
  const t = (cost - min) / (max - min); // 0=cheapest, 1=most expensive
  // green(120) → orange(30) → red(0)
  const hue = 120 - t * 120;
  return `background:hsl(${hue},${sat}%,${light}%);color:${txtCol};`;
}

export function avgRating(r: any) {
  if (!r.timesServed) return 0;
  return ((r.avgSkill || 0) + (r.avgSpeed || 0) + (r.avgBanger || 0)) / 3;
}

export function renderRecipeIndex() {
  // Type filter pills come from v2 recipes only (S.recipeIndex was the
  // legacy v1 array, removed in S12).
  const types = [...new Set((S.recipes || []).map(r => r.type).filter(Boolean))];

  const v2Count = S.recipes.length;
  const isDirector = !!S.user?.isDirector;
  let html = `
  <div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" data-testid="recipe-create-btn" onclick="openRecipeEditor()">+ Create recipe</button>
    ${isDirector ? '<button class="btn btn-primary" data-testid="recipe-ai-btn" onclick="openRecipeEditor(undefined, { aiMode: true })" title="Draft a recipe with AI" style="background:var(--purple,#7c3aed);border-color:var(--purple,#7c3aed);">✨ AI helper</button>' : ''}
    <button class="btn" onclick="recalcAllCosts()" title="Recalculate all recipe costs from current ingredient prices">Recalculate costs</button>
    <button class="btn" onclick="importCookedAmounts()" title="Re-import cooked amounts from Google Sheets for all recipes">Import cooked amounts</button>
    <span style="font-size:12px;color:var(--text2);margin-left:8px;">${v2Count} recipe${v2Count !== 1 ? 's' : ''}</span>
  </div>
  <input class="ri-search" id="ri-search-input" placeholder="Search recipes..." value="${esc(riSearch)}" oninput="updateRiSearch(this)" />
  <div class="ri-filter-bar">
    <button class="fc ${riTypeFilter === 'all' ? 'on' : ''}" onclick="riTypeFilter='all';updateRecipeResults()">All types</button>
    ${types.map(t => `<button class="fc ${riTypeFilter === t ? 'on' : ''}" onclick="riTypeFilter='${t}';updateRecipeResults()">${t}</button>`).join('')}
  </div>
  <div id="ri-results"></div>`;

  document.getElementById('screen-recipe-index').innerHTML = html;
  updateRecipeResults();
}

// Update only the results portion — search input stays in the DOM
export function updateRecipeResults() {
  // ── V2 recipes ──
  let v2Filtered = S.recipes || [];
  if (riTypeFilter !== 'all') v2Filtered = v2Filtered.filter(r => r.type === riTypeFilter);
  if (riSearch) {
    const q = riSearch.toLowerCase();
    v2Filtered = v2Filtered.filter(r => r.name.toLowerCase().includes(q) || [...(r.autoAllergens||[]),...(r.extraAllergens||[])].join(' ').toLowerCase().includes(q));
  }
  v2Filtered = [...v2Filtered].sort((a, b) => {
    let va: string | number, vb: string | number;
    switch (riSort.col) {
      case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'type': va = a.type||''; vb = b.type||''; break;
      case 'cost': va = a.costPerServing ?? 999; vb = b.costPerServing ?? 999; break;
      case 'structure': va = a.structure||''; vb = b.structure||''; break;
      case 'season': va = a.seasonality||''; vb = b.seasonality||''; break;
      case 'banger': va = a.avgBanger||0; vb = b.avgBanger||0; break;
      case 'rating': va = ((a.avgSkill||0)+(a.avgSpeed||0)+(a.avgBanger||0))/3; vb = ((b.avgSkill||0)+(b.avgSpeed||0)+(b.avgBanger||0))/3; break;
      case 'served': va = a.timesServed||0; vb = b.timesServed||0; break;
      default: va = a.name.toLowerCase(); vb = b.name.toLowerCase();
    }
    if (va < vb) return riSort.dir === 'asc' ? -1 : 1;
    if (va > vb) return riSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  // Recipe v1 (S.recipeIndex) was removed in S12. All recipes are v2 now.

  const arrow = (col: any) => riSort.col === col ? (riSort.dir === 'asc' ? '▲' : '▼') : '↕';
  const thCls = (col: any) => riSort.col === col ? 'sorted' : '';

  let html = '';

  // Helper to render a recipe table (reused for both v2 and legacy)
  const tableHeaders = `<thead><tr>
    <th class="${thCls('name')}" onclick="riSortBy('name')">Name <span class="sort-arrow">${arrow('name')}</span></th>
    <th class="${thCls('type')}" onclick="riSortBy('type')">Type <span class="sort-arrow">${arrow('type')}</span></th>
    <th class="${thCls('structure')}" onclick="riSortBy('structure')">Structure <span class="sort-arrow">${arrow('structure')}</span></th>
    <th class="${thCls('cost')}" onclick="riSortBy('cost')">Cost <span class="sort-arrow">${arrow('cost')}</span></th>
    <th class="${thCls('season')}" onclick="riSortBy('season')">Season <span class="sort-arrow">${arrow('season')}</span></th>
    <th>Allergens</th>
    <th class="${thCls('banger')}" onclick="riSortBy('banger')">Banger <span class="sort-arrow">${arrow('banger')}</span></th>
    <th class="${thCls('rating')}" onclick="riSortBy('rating')">Avg <span class="sort-arrow">${arrow('rating')}</span></th>
    <th class="${thCls('served')}" onclick="riSortBy('served')">Served <span class="sort-arrow">${arrow('served')}</span></th>
    <th>Actions</th>
  </tr></thead>`;

  // ── V2 recipes table ──
  if (v2Filtered.length > 0) {
    // Collect v2 costs by type for color scaling
    const v2CostsByType: Record<string, number[]> = {};
    v2Filtered.forEach(r => {
      if (r.costPerServing != null) {
        if (!v2CostsByType[r.type || 'Soup']) v2CostsByType[r.type || 'Soup'] = [];
        v2CostsByType[r.type || 'Soup'].push(r.costPerServing);
      }
    });

    html += `<div class="ri-table-wrap"><table class="ri-table">${tableHeaders}<tbody>`;
    v2Filtered.forEach(r => {
      const cost = r.costPerServing;
      const typeCosts = v2CostsByType[r.type || 'Soup'] || [];
      const cStyle = cost != null ? costColor(cost, typeCosts) : '';
      const allAllergens = [...new Set([...(r.autoAllergens||[]),...(r.extraAllergens||[])])];
      const ags = allAllergens.map(a => `<span class="allergen-pill">${esc(a)}</span>`).join(' ');

      html += `<tr>
        <td class="ri-name-cell"><a href="javascript:void(0)" onclick="openRecipeDetail('${esc(r.id)}')" style="color:var(--text);text-decoration:none;">${esc(r.name)}</a></td>
        <td>${typeBadge((r.type || 'Soup') as DishType)}</td>
        <td style="font-size:12px;">${esc(r.structure || '—')}</td>
        <td>${cost != null ? `<span class="ri-cost-cell" style="${cStyle}">&euro;${cost.toFixed(2)}</span>` : '<span style="color:var(--text2);font-size:11px;">—</span>'}</td>
        <td style="font-size:12px;">${esc(r.seasonality || '—')}</td>
        <td>${ags || '<span style="color:var(--text2);font-size:11px;">—</span>'}</td>
        <td><span style="color:var(--text2);font-size:11px;">—</span></td>
        <td><span style="color:var(--text2);font-size:11px;">—</span></td>
        <td style="text-align:center;">—</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="openRecipeEditor('${esc(r.id)}')">Edit</button>
          <button class="btn btn-sm" onclick="addDishFromV2Recipe('${esc(r.id)}')">+ Menu</button>
          <button class="btn btn-sm btn-danger" onclick="deleteV2Recipe('${esc(r.id)}')">✕</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
  }

  // Empty state — all recipes are v2 now.
  if (v2Filtered.length === 0) {
    if ((S.recipes || []).length === 0) {
      html += `<div class="ri-empty">
        <p style="font-size:16px;font-weight:600;">No recipes yet</p>
        <p>Click "+ Create recipe" to add your first recipe.</p>
      </div>`;
    } else {
      html += `<div class="ri-empty"><p>No recipes match your search</p></div>`;
    }
  }

  const container = document.getElementById('ri-results');
  if (container) container.innerHTML = html;
}

export function riSortBy(col: any) {
  if (riSort.col === col) {
    riSort.dir = riSort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    riSort.col = col;
    riSort.dir = col === 'cost' || col === 'rating' || col === 'banger' || col === 'served' ? 'desc' : 'asc';
  }
  updateRecipeResults();
}

// Recipe v1 entry-point stubs. The button/handlers are gone from
// renderRecipeIndex above, but main.ts still assigns these to window for
// any cached HTML still calling them via inline onclick.
export function openAddRecipe() { toastError(V1_DEPRECATED_MSG); }
export function setRiMode(_mode: any) { /* no-op */ }
export function extractSheetId(url: string) {
  // Still useful for `addDishFromRecipe` (alive — used to attach a v2 recipe
  // to a slot from a Google Sheets URL paste in some flows).
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// Recipe v1 ("Import from Sheet" + legacy index) was removed in S12. The
// underlying /api/recipe-index endpoints are gone and the table was dropped.
// These stubs remain so any cached tab still calling them via inline onclick
// gets a clean deprecation toast instead of a console error or 404 cascade.
const V1_DEPRECATED_MSG = 'Recipe v1 has been removed — use "+ Create recipe" to make a v2 recipe instead.';
export function fetchAndAddRecipe() { toastError(V1_DEPRECATED_MSG); }
export function bulkAddRecipes() { toastError(V1_DEPRECATED_MSG); }
export function openEditRecipe(_id: any) { toastError(V1_DEPRECATED_MSG); }
export function saveEditRecipe(_id: any) { toastError(V1_DEPRECATED_MSG); }
export function deleteRecipeIndex(_id: any) { toastError(V1_DEPRECATED_MSG); }

// Add a dish to the menu planner from a recipe in the index
export async function importCookedAmounts() {
  try {
    toast('Importing cooked amounts from Google Sheets... this may take a while');
    const result = await apiPost('/api/recipes/import-cooked-amounts', {}) as { updated: number; skipped: number; failed: number; total: number };
    // Refresh the recipe list from server
    const freshRecipes = await apiGet('/api/recipes') as typeof S.recipes;
    S.recipes = freshRecipes;
    updateRecipeResults();
    toast(`Cooked amounts imported: ${result.updated} updated, ${result.failed} failed, ${result.skipped} skipped out of ${result.total}`);
  } catch (e: unknown) {
    toastError('Could not import cooked amounts: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export async function recalcAllCosts() {
  try {
    toast('Recalculating all recipe costs...');
    const updated = await apiPost('/api/recipes/recalculate-costs', {}) as { updated: number };
    // Refresh the recipe list from server
    const freshRecipes = await apiGet('/api/recipes') as typeof S.recipes;
    S.recipes = freshRecipes;
    updateRecipeResults();
    toast(`Costs recalculated (${updated.updated} updated)`);
  } catch (e: unknown) {
    toastError('Could not recalculate costs: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// addDishFromRecipe was the v1-index path. Replaced with a deprecated stub —
// addDishFromV2Recipe (below) is the supported path now.
export function addDishFromRecipe(_recipeId: any) { toastError(V1_DEPRECATED_MSG); }

// Add a batch from a v2 recipe (with DB-linked ingredients)
export function addDishFromV2Recipe(recipeId: string) {
  const r = S.recipes.find(x => x.id === recipeId);
  if (!r) return;
  const allAllergens = [...new Set([...(r.autoAllergens || []), ...(r.extraAllergens || [])])];
  // Unified-batch shape. The legacy-field version (stock/location/inTransit/
  // recipeSheetId/...) shipped on the "+ Menu" button and failed every save —
  // validateBatch rejects a batch with no inventory[]. The `: Batch`
  // annotation makes the compiler catch a regression; see
  // test/batch-construction.test.ts for the CI guard.
  const newDish: Batch = {
    id: newId(),
    name: r.name,
    type: (r.type || 'Soup') as DishType,
    serving: r.servingSize || 280,
    inventory: [],
    shipments: [],
    allergens: allAllergens,
    extraAllergens: [],
    orderFor: false,
    cookDate: null,
    note: '',
    services: [],
    createdAt: new Date().toISOString(),
    recipeId: r.id,
    actualIngredients: null,
    cookNotes: '',
    stockDeducted: false,
    generated: false,
  };
  S.batches.push(newDish);
  rebuildPlanner();
  scheduleSave();
  toast(esc(r.name) + ' added as batch to menu planner');
}

// Delete a v2 recipe
export function deleteV2Recipe(recipeId: string) {
  const r = S.recipes.find(x => x.id === recipeId);
  if (!r) return;
  const deleted = structuredClone(r);
  S.recipes = S.recipes.filter(x => x.id !== recipeId);
  renderRecipeIndex();
  pushUndo({
    label: esc(r.name) + ' deleted',
    restore: () => { S.recipes.push(deleted); renderRecipeIndex(); },
    commit: async () => {
      try {
        await apiPost(`/api/recipes/${recipeId}`, {}, 'DELETE');
      } catch (e: unknown) {
        toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error'));
        S.recipes.push(deleted);
        renderRecipeIndex();
      }
    },
  });
}

// Self-register so navigate.ts can dispatch without importing every screen.
registerRenderer('recipe-index', renderRecipeIndex);
