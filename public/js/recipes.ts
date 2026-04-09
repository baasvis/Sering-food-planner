import { S, ALLERGENS, INGREDIENT_TYPES, PRICE_LEVELS } from './state';
import { newId, scheduleSave, toast, toastError, apiGet, apiPost } from './utils';
import { rebuildPlanner, typeBadge, typeBadgeClass, TYPES, chipClass } from './core';
import { showModal, closeModal, esc } from './modal';
import { doLogout } from './auth';

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
  const types = [...new Set(S.recipeIndex.map(r => r.type).filter(Boolean))];

  let html = `
  <div class="btn-row" style="margin-bottom:12px;">
    <button class="btn btn-primary" onclick="openAddRecipe()">+ Add recipe</button>
    <span style="font-size:12px;color:var(--text2);margin-left:8px;">${S.recipeIndex.length} recipes in index</span>
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
  let filtered = S.recipeIndex;
  if (riTypeFilter !== 'all') filtered = filtered.filter(r => r.type === riTypeFilter);
  if (riSearch) {
    const q = riSearch.toLowerCase();
    filtered = filtered.filter(r => r.name.toLowerCase().includes(q) || (r.allergens||[]).join(' ').toLowerCase().includes(q));
  }

  const sorted = [...filtered].sort((a: any, b: any) => {
    let va, vb;
    switch (riSort.col) {
      case 'name': va = a.name.toLowerCase(); vb = b.name.toLowerCase(); break;
      case 'type': va = a.type||''; vb = b.type||''; break;
      case 'cost': va = parseCost(a.costPerServing) ?? 999; vb = parseCost(b.costPerServing) ?? 999; break;
      case 'rating': va = avgRating(a); vb = avgRating(b); break;
      case 'banger': va = a.avgBanger||0; vb = b.avgBanger||0; break;
      case 'served': va = a.timesServed||0; vb = b.timesServed||0; break;
      case 'structure': va = a.structure||''; vb = b.structure||''; break;
      case 'season': va = a.seasonality||''; vb = b.seasonality||''; break;
      default: va = a.name; vb = b.name;
    }
    if (va < vb) return riSort.dir === 'asc' ? -1 : 1;
    if (va > vb) return riSort.dir === 'asc' ? 1 : -1;
    return 0;
  });

  const costsByType = {};
  filtered.forEach(r => {
    const c = parseCost(r.costPerServing);
    if (c !== null) {
      if (!costsByType[r.type]) costsByType[r.type] = [];
      costsByType[r.type].push(c);
    }
  });

  const arrow = (col: any) => riSort.col === col ? (riSort.dir === 'asc' ? '▲' : '▼') : '↕';
  const thCls = (col: any) => riSort.col === col ? 'sorted' : '';

  let html = '';
  if (sorted.length === 0 && S.recipeIndex.length === 0) {
    html = `<div class="ri-empty">
      <p style="font-size:16px;font-weight:600;">No recipes yet</p>
      <p>Add your first recipe by clicking "+ Add recipe" and pasting a Google Sheet link.</p>
    </div>`;
  } else if (sorted.length === 0) {
    html = `<div class="ri-empty"><p>No recipes match your search</p></div>`;
  } else {
    html = `<div class="ri-table-wrap"><table class="ri-table">
    <thead><tr>
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
    </tr></thead><tbody>`;

    sorted.forEach(r => {
      const cost = parseCost(r.costPerServing);
      const typeCosts = costsByType[r.type] || [];
      const cStyle = cost !== null ? costColor(cost, typeCosts) : '';
      const ags = (r.allergens||[]).map(a => `<span class="allergen-pill">${esc(a)}</span>`).join(' ');
      const avg = avgRating(r);

      html += `<tr>
        <td class="ri-name-cell">
          ${r.recipeSheetId ? `<a href="https://docs.google.com/spreadsheets/d/${esc(r.recipeSheetId)}/edit" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;">${esc(r.name)} <span style="font-size:10px;color:var(--green);">↗</span></a>` : esc(r.name)}
        </td>
        <td>${typeBadge(r.type || 'Soup')}</td>
        <td style="font-size:12px;">${esc(r.structure || '—')}</td>
        <td>${cost !== null ? `<span class="ri-cost-cell" style="${cStyle}">${esc(r.costPerServing)}</span>` : '<span style="color:var(--text2);font-size:11px;">—</span>'}</td>
        <td style="font-size:12px;">${esc(r.seasonality || '—')}</td>
        <td>${ags || '<span style="color:var(--text2);font-size:11px;">—</span>'}</td>
        <td>${r.timesServed ? `<span class="ri-rating"><span class="ri-rating-val">${(r.avgBanger||0).toFixed(1)}</span></span>` : '<span style="color:var(--text2);font-size:11px;">—</span>'}</td>
        <td>${r.timesServed ? `<span class="ri-rating"><span class="ri-rating-val">${avg.toFixed(1)}</span></span>` : '<span style="color:var(--text2);font-size:11px;">—</span>'}</td>
        <td style="text-align:center;">${r.timesServed || '—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-sm" onclick="addDishFromRecipe('${r.id}')">+ Menu</button>
          <button class="btn btn-sm btn-danger" onclick="deleteRecipeIndex('${r.id}')">✕</button>
        </td>
      </tr>`;
    });
    html += `</tbody></table></div>`;
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

export function openAddRecipe() {
  showModal(`<h3>Add recipes to index</h3>
    <div style="margin-bottom:12px;">
      <div class="ri-filter-bar">
        <button class="fc on" id="ri-mode-single" onclick="setRiMode('single')">Single recipe</button>
        <button class="fc" id="ri-mode-bulk" onclick="setRiMode('bulk')">Bulk import</button>
      </div>
    </div>
    <div id="ri-input-area">
      <div class="fr"><label>Paste Google Sheet URL</label>
        <input type="text" id="ri-url" class="ri-add-url" placeholder="https://docs.google.com/spreadsheets/d/..." />
        <div style="font-size:11px;color:var(--text2);margin-top:4px;">Paste the full URL of the recipe Google Sheet</div>
      </div>
    </div>
    <div id="ri-bulk-progress" style="display:none;margin-top:12px;"></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" id="ri-submit-btn" onclick="fetchAndAddRecipe()">Fetch recipe</button>
    </div>`);
}

export function setRiMode(mode: any) {
  document.getElementById('ri-mode-single').className = 'fc' + (mode === 'single' ? ' on' : '');
  document.getElementById('ri-mode-bulk').className = 'fc' + (mode === 'bulk' ? ' on' : '');
  const area = document.getElementById('ri-input-area');
  const btn = document.getElementById('ri-submit-btn');
  if (mode === 'single') {
    area.innerHTML = `<div class="fr"><label>Paste Google Sheet URL</label>
      <input type="text" id="ri-url" class="ri-add-url" placeholder="https://docs.google.com/spreadsheets/d/..." />
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">Paste the full URL of the recipe Google Sheet</div>
    </div>`;
    btn.textContent = 'Fetch recipe';
    btn.onclick = fetchAndAddRecipe;
  } else {
    area.innerHTML = `<div class="fr"><label>Paste multiple Google Sheet URLs (one per line)</label>
      <textarea id="ri-urls" rows="8" style="width:100%;font-size:12px;font-family:monospace;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);resize:vertical;" placeholder="https://docs.google.com/spreadsheets/d/abc123/edit&#10;https://docs.google.com/spreadsheets/d/def456/edit&#10;https://docs.google.com/spreadsheets/d/ghi789/edit"></textarea>
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">One URL per line. Duplicates and invalid URLs will be skipped.</div>
    </div>`;
    btn.textContent = 'Import all';
    btn.onclick = bulkAddRecipes;
  }
  document.getElementById('ri-bulk-progress').style.display = 'none';
  document.getElementById('ri-bulk-progress').innerHTML = '';
}

export function extractSheetId(url: any) {
  const m = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

export async function fetchAndAddRecipe() {
  const url = document.getElementById('ri-url').value.trim();
  if (!url) { alert('Please paste a URL'); return; }
  const sheetId = extractSheetId(url);
  if (!sheetId) { alert('Could not find a valid Google Sheet ID in that URL'); return; }

  // Check if already in index
  if (S.recipeIndex.find(r => r.recipeSheetId === sheetId)) {
    alert('This recipe is already in your index');
    return;
  }

  try {
    toast('Fetching recipe data...');
    const recipe = await apiGet('/api/recipe?sheetId=' + sheetId);
    const newRecipe = {
      id: newId(),
      name: recipe.dishName || 'Unnamed recipe',
      type: recipe.dishType || 'Soup',
      recipeSheetId: sheetId,
      allergens: recipe.allergens || [],
      costPerServing: recipe.costPerServing || '',
      structure: recipe.structure || '',
      seasonality: recipe.seasonality || '',
      servingTemp: recipe.servingTemp || '',
      servingSize: recipe.serving || 280,
      recipeVolume: recipe.recipeVolume || null,
      recipeIngredients: recipe.ingredients || null,
      createdAt: new Date().toISOString(),
      avgSkill: 0, avgSpeed: 0, avgBanger: 0, timesServed: 0,
    };

    // Save to server
    await apiPost('/api/recipe-index', newRecipe);
    S.recipeIndex.push(newRecipe);

    closeModal();
    renderRecipeIndex();
    toast(esc(newRecipe.name) + ' added to recipe index');
  } catch (e: unknown) {
    toastError('Could not fetch recipe: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

export async function bulkAddRecipes() {
  const textarea = document.getElementById('ri-urls');
  if (!textarea) return;
  const lines = textarea.value.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) { alert('Please paste at least one URL'); return; }

  // Extract sheet IDs and deduplicate
  const entries = [];
  const seen = new Set();
  lines.forEach(line => {
    const sheetId = extractSheetId(line);
    if (!sheetId) return;
    if (seen.has(sheetId)) return;
    if (S.recipeIndex.find(r => r.recipeSheetId === sheetId)) return; // already in index
    seen.add(sheetId);
    entries.push({ url: line, sheetId });
  });

  const skipped = lines.length - entries.length;
  if (!entries.length) {
    alert(skipped > 0 ? 'All URLs are either invalid, duplicates, or already in your index.' : 'No valid Google Sheet URLs found.');
    return;
  }

  const progress = document.getElementById('ri-bulk-progress');
  progress.style.display = 'block';
  const btn = document.getElementById('ri-submit-btn');
  btn.disabled = true;
  btn.textContent = 'Importing...';

  let ok = 0, fail = 0;
  for (let i = 0; i < entries.length; i++) {
    const { sheetId } = entries[i];
    progress.innerHTML = `<div style="font-size:12px;margin-bottom:4px;">Fetching ${i + 1}/${entries.length}...</div>
      <div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden;">
        <div style="height:100%;width:${Math.round(((i + 1) / entries.length) * 100)}%;background:var(--blue);transition:width .2s;"></div>
      </div>
      <div style="font-size:11px;color:var(--text2);margin-top:4px;">${ok} added · ${fail} failed${skipped ? ' · ' + skipped + ' skipped' : ''}</div>`;

    try {
      const recipe = await apiGet('/api/recipe?sheetId=' + sheetId);
      const newRecipe = {
        id: newId(),
        name: recipe.dishName || 'Unnamed recipe',
        type: recipe.dishType || 'Soup',
        recipeSheetId: sheetId,
        allergens: recipe.allergens || [],
        costPerServing: recipe.costPerServing || '',
        structure: recipe.structure || '',
        seasonality: recipe.seasonality || '',
        servingTemp: recipe.servingTemp || '',
        servingSize: recipe.serving || 280,
        recipeVolume: recipe.recipeVolume || null,
        recipeIngredients: recipe.ingredients || null,
        createdAt: new Date().toISOString(),
        avgSkill: 0, avgSpeed: 0, avgBanger: 0, timesServed: 0,
      };
      await apiPost('/api/recipe-index', newRecipe);
      S.recipeIndex.push(newRecipe);
      ok++;
    } catch (e: unknown) {
      console.error('Failed to import', sheetId, e);
      fail++;
    }
  }

  progress.innerHTML = `<div style="font-size:13px;font-weight:500;color:var(--green);margin-bottom:4px;">
    Import complete: ${ok} added${fail ? ', ' + fail + ' failed' : ''}${skipped ? ', ' + skipped + ' skipped' : ''}
  </div>`;
  btn.disabled = false;
  btn.textContent = 'Done';
  btn.onclick = () => { closeModal(); renderRecipeIndex(); };
  renderRecipeIndex();
}

export function openEditRecipe(id: any) {
  const r = S.recipeIndex.find(x => x.id === id);
  if (!r) return;
  showModal(`<h3>Edit recipe &mdash; ${esc(r.name)}</h3>
    <div class="fr"><label>Name</label><input type="text" id="re-name" value="${esc(r.name)}" /></div>
    <div class="fr"><label>Type</label><select id="re-type">
      ${['Soup','Main course','Dessert'].map(t => `<option${r.type === t ? ' selected' : ''}>${t}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Structure</label><select id="re-structure">
      ${['','Open structure','Closed structure'].map(s => `<option${r.structure === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Seasonality</label><select id="re-season">
      ${['','Year round','Spring','Summer','Fall','Winter'].map(s => `<option${r.seasonality === s ? ' selected' : ''}>${s}</option>`).join('')}
    </select></div>
    <div class="fr"><label>Cost per serving</label><input type="text" id="re-cost" value="${esc(r.costPerServing || '')}" placeholder="e.g. €0.55" /></div>
    <div class="modal-actions">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="saveEditRecipe('${r.id}')">Save</button>
    </div>`);
}

export async function saveEditRecipe(id: any) {
  const r = S.recipeIndex.find(x => x.id === id);
  if (!r) return;
  r.name = document.getElementById('re-name').value.trim() || r.name;
  r.type = document.getElementById('re-type').value;
  r.structure = document.getElementById('re-structure').value;
  r.seasonality = document.getElementById('re-season').value;
  r.costPerServing = document.getElementById('re-cost').value.trim();
  try {
    await apiPost('/api/recipe-index', r);
    closeModal();
    renderRecipeIndex();
    toast('Recipe updated');
  } catch (e: unknown) { toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

export async function deleteRecipeIndex(id: any) {
  const entry = S.recipeIndex.find(x => x.id === id);
  const name = entry ? entry.name : 'this recipe';
  if (!confirm('Remove "' + name + '" from the recipe index?')) return;
  try {
    const r = await fetch('/api/recipe-index/' + id, { method: 'DELETE' });
    if (r.status === 401) { doLogout(); return; }
    S.recipeIndex = S.recipeIndex.filter(x => x.id !== id);
    renderRecipeIndex();
    toast('Recipe removed from index');
  } catch (e: unknown) { toastError('Could not delete: ' + (e instanceof Error ? e.message : 'Unknown error')); }
}

// Add a dish to the menu planner from a recipe in the index
export async function addDishFromRecipe(recipeId: any) {
  const r = S.recipeIndex.find(x => x.id === recipeId);
  if (!r) return;
  const newDish = {
    id: newId(),
    name: r.name,
    type: r.type || 'Soup',
    stock: 0,
    serving: r.servingSize || 280,
    storage: 'Gastro',
    location: 'west',
    inTransit: false,
    recipeSheetId: r.recipeSheetId || null,
    recipeVolume: r.recipeVolume || null,
    recipeIngredients: r.recipeIngredients ? [...r.recipeIngredients] : null,
    allergens: [...(r.allergens || [])],
    extraAllergens: [],
    orderFor: false,
    parentId: null,
    cookDate: null,
    services: [],
    createdAt: new Date().toISOString(),
  };
  S.batches.push(newDish);
  rebuildPlanner();
  scheduleSave();
  toast(esc(r.name) + ' added as batch to menu planner');
}
