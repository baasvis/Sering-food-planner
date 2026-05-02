// ─────────────────────────────────────────────────────────────────────────────
// RECIPE EDITOR — single-screen recipe creation & editing for Recipe v2
// ─────────────────────────────────────────────────────────────────────────────

import { S, ALLERGENS, INGREDIENT_CATEGORIES } from './state';
import { apiGet, apiPost, toast, toastError, loadIngredientDb } from './utils';
import { typeBadge, TYPES } from './core';
import { showModal, closeModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { trackEvent } from './telemetry';
import type { RecipeFull, RecipeIngredientFull, PrepStep, Ingredient, NutritionInfo, DishType } from '@shared/types';

// ── Editor state ──

interface EditorIngredient {
  id: string;           // temp client id (or server id on edit)
  ingredientId: string | null;
  ingredientName: string;
  sortOrder: number;
  rawAmount: number;
  cookedAmount: number | null;
  unit: string;
  isFlexible: boolean;
  flexCategory: string | null;
  flexLabel: string | null;
  suggestedNames: string[];
}

interface EditorState {
  recipeId: string | null;       // null = creating, string = editing
  name: string;
  type: string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  ingredients: EditorIngredient[];
  prepSteps: PrepStep[];
  coolingMethod: string;
  storageMethod: string;
  extraAllergens: string[];
  photoFile: File | null;
  hasPhoto: boolean;
  isComplete: boolean;
}

let ed: EditorState | null = null;
let _suggestionTimeout: ReturnType<typeof setTimeout> | null = null;

const UNITS = ['Grams', 'Kilos', 'Liters', 'ML'];

/** Escape a string for use inside a JS single-quoted string in an HTML attribute */
function jsEsc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
const STRUCTURES = ['', 'Open structure', 'Closed structure'];
const SEASONS = ['', 'Year round', 'Spring', 'Summer', 'Fall', 'Winter'];
const TEMPS = ['', 'Hot', 'Cold', 'Room temperature'];
const FOOD_CATEGORIES = INGREDIENT_CATEGORIES['Food'] || [];

function tempId(): string {
  return '_tmp_' + Math.random().toString(36).slice(2, 10);
}

// ── Auto-calculated recipe volume (sum of cooked amounts in liters) ──

function calcRecipeVolume(): number {
  if (!ed) return 0;
  let totalML = 0;
  for (const ing of ed.ingredients) {
    const cooked = ing.cookedAmount ?? ing.rawAmount;
    if (!cooked) continue;
    switch (ing.unit) {
      case 'Kilos': case 'Liters': totalML += cooked * 1000; break;
      case 'ML': case 'Grams': default: totalML += cooked; break;
    }
  }
  return Math.round(totalML) / 1000; // liters, rounded to ml precision
}

// ── Live cost calculation ──

function calcEditorCostData(): { totalCost: number; hasPrice: number; totalNonFlex: number; perServing: number | null; servings: number | null; volume: number } {
  const volume = calcRecipeVolume();
  if (!ed) return { totalCost: 0, hasPrice: 0, totalNonFlex: 0, perServing: null, servings: null, volume };
  let totalCost = 0;
  let hasPrice = 0;
  let totalNonFlex = 0;
  ed.ingredients.forEach(ing => {
    if (!ing.isFlexible) totalNonFlex++;
    if (ing.ingredientId && !ing.isFlexible) {
      const dbIng = S.ingredientDb.find(i => i.id === ing.ingredientId);
      if (dbIng && dbIng.pricePer100 > 0) {
        const grams = toGrams(ing.rawAmount, ing.unit);
        totalCost += (grams / 100) * dbIng.pricePer100;
        hasPrice++;
      }
    }
  });
  const servings = volume > 0 && ed.servingSize > 0 ? Math.round((volume * 1000) / ed.servingSize) : null;
  const perServing = servings && servings > 0 ? totalCost / servings : null;
  return { totalCost, hasPrice, totalNonFlex, perServing, servings, volume };
}

function toGrams(amount: number, unit: string): number {
  switch (unit) {
    case 'Kilos': return amount * 1000;
    case 'Liters': return amount * 1000;
    case 'ML': return amount;
    default: return amount; // Grams
  }
}

/** Round a scaled ingredient amount to a precision appropriate for its unit.
 * Math.round() on Kilos/Liters truncates small values to zero (e.g. 0.25 kg
 * onion → 0), which made the recipe detail view and batch editor silently
 * drop sub-kilo ingredients. For weight/volume big-units we keep 3 decimals
 * (1 g / 1 ml precision). For small units we round to whole integers.
 * Mirrors the helper in the scale block — keep both in sync if changed. */
function roundForUnit(amount: number, unit: string): number {
  const u = (unit || '').toLowerCase();
  if (u === 'kilos' || u === 'kilo' || u === 'kg' || u === 'liters' || u === 'liter' || u === 'l') {
    return Math.round(amount * 1000) / 1000;
  }
  if (u === 'grams' || u === 'gram' || u === 'g' || u === 'ml' || u === 'milliliters') {
    return Math.round(amount);
  }
  return Math.round(amount * 100) / 100;
}

/** Render the sticky price bar HTML */
function renderPriceBar(): string {
  if (!ed) return '';
  const { totalCost, hasPrice, totalNonFlex, perServing, servings, volume } = calcEditorCostData();
  const priceClass = perServing !== null ? (perServing > 1.0 ? 're-price-high' : perServing > 0.6 ? 're-price-mid' : 're-price-low') : '';
  return `<div class="re-price-bar" id="re-price-bar">
    <div class="re-price-main">
      <span class="re-price-label">Price per portion</span>
      <span class="re-price-value ${priceClass}">${perServing !== null ? '€' + perServing.toFixed(2) : '—'}</span>
    </div>
    <div class="re-price-details">
      <span>Total: €${totalCost.toFixed(2)}</span>
      <span>Volume: ${volume > 0 ? volume.toFixed(1) + 'L' : '—'}</span>
      <span>Servings: ${servings ?? '—'}</span>
      <span class="re-price-coverage">${hasPrice}/${totalNonFlex} priced</span>
    </div>
  </div>`;
}

/** Update just the price bar without re-rendering everything */
function refreshPriceBar() {
  const bar = document.getElementById('re-price-bar');
  if (!bar) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = renderPriceBar();
  const newBar = tmp.firstElementChild;
  if (newBar) bar.replaceWith(newBar);
}

// ── Public entry points ──

export function openRecipeEditor(recipeId?: string) {
  if (recipeId) {
    loadRecipeForEdit(recipeId);
  } else {
    ed = {
      recipeId: null,
      name: '', type: 'Soup', structure: '', seasonality: '', servingTemp: '',
      servingSize: 280,
      ingredients: [], prepSteps: [], coolingMethod: '', storageMethod: '',
      extraAllergens: [], photoFile: null, hasPhoto: false, isComplete: false,
    };
    renderEditor();
  }
}

export async function openRecipeDetail(recipeId: string) {
  try {
    const r = await apiGet(`/api/recipes/${recipeId}`) as RecipeFull;
    // Update cached copy with denormalized data
    const idx = S.recipes.findIndex(x => x.id === recipeId);
    if (idx >= 0) S.recipes[idx] = r; else S.recipes.push(r);
    renderDetailModal(r);
  } catch (e: unknown) {
    toastError('Could not load recipe: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Load recipe for editing ──

async function loadRecipeForEdit(id: string) {
  try {
    const r: RecipeFull = await apiGet(`/api/recipes/${id}`);
    ed = {
      recipeId: r.id,
      name: r.name, type: r.type, structure: r.structure, seasonality: r.seasonality,
      servingTemp: r.servingTemp, servingSize: r.servingSize,
      ingredients: (r.ingredients || []).map(ing => ({
        id: ing.id,
        ingredientId: ing.ingredientId,
        ingredientName: ing.ingredientName || '',
        sortOrder: ing.sortOrder,
        rawAmount: ing.rawAmount,
        cookedAmount: ing.cookedAmount,
        unit: ing.unit,
        isFlexible: ing.isFlexible,
        flexCategory: ing.flexCategory,
        flexLabel: ing.flexLabel,
        suggestedNames: ing.suggestedNames || [],
      })),
      prepSteps: r.prepSteps || [],
      coolingMethod: r.coolingMethod, storageMethod: r.storageMethod,
      extraAllergens: r.extraAllergens || [],
      photoFile: null, hasPhoto: !!r.photoUrl, isComplete: r.isComplete,
    };
    renderEditor();
  } catch (e: unknown) {
    toastError('Could not load recipe: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Render the editor modal (single-screen) ──

function renderEditor() {
  if (!ed) return;
  const isNew = !ed.recipeId;
  showModal(`
    <div class="re-editor">
      <div class="re-header">
        <h3>${isNew ? 'Create new recipe' : 'Edit recipe'}</h3>
      </div>
      ${renderPriceBar()}
      <div id="re-body" class="re-body-scroll"></div>
    </div>
  `);
  const modal = document.querySelector('.modal') as HTMLElement;
  if (modal) { modal.style.width = '780px'; modal.style.maxWidth = '95vw'; }
  renderEditorBody();
}

function renderEditorBody() {
  if (!ed) return;
  const body = document.getElementById('re-body');
  if (!body) return;
  body.innerHTML = renderBasicsSection()
    + renderIngredientsSection()
    + renderPrepStepsSection()
    + renderStorageSection()
    + renderAllergensSection()
    + renderSaveSection();
}

// ── Section: Basics ──

function renderBasicsSection(): string {
  if (!ed) return '';
  return `
    <div class="re-section re-basics">
      <div class="re-basics-row">
        <div class="re-basics-field re-basics-name">
          <label>Name *</label>
          <input type="text" class="re-inline-input" id="re-name" value="${esc(ed.name)}" onchange="reUpdateField('name',this.value)" placeholder="e.g. North African lentil soup" />
        </div>
        <div class="re-basics-field">
          <label>Type *</label>
          <select class="re-inline-select" id="re-type" onchange="reUpdateField('type',this.value)">
            ${['Soup', 'Main course', 'Dessert'].map(t => `<option${ed!.type === t ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="re-basics-field">
          <label>Serving (ml) *</label>
          <input type="number" class="re-inline-input re-inline-num" id="re-serving" value="${ed.servingSize}" min="1" onchange="reUpdateField('servingSize',+this.value)" />
        </div>
      </div>
      <div class="re-basics-row">
        <div class="re-basics-field">
          <label>Structure</label>
          <select class="re-inline-select" id="re-structure" onchange="reUpdateField('structure',this.value)">
            ${STRUCTURES.map(s => `<option value="${esc(s)}"${ed!.structure === s ? ' selected' : ''}>${s || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="re-basics-field">
          <label>Seasonality</label>
          <select class="re-inline-select" id="re-season" onchange="reUpdateField('seasonality',this.value)">
            ${SEASONS.map(s => `<option value="${esc(s)}"${ed!.seasonality === s ? ' selected' : ''}>${s || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="re-basics-field">
          <label>Serving temp</label>
          <select class="re-inline-select" id="re-temp" onchange="reUpdateField('servingTemp',this.value)">
            ${TEMPS.map(t => `<option value="${esc(t)}"${ed!.servingTemp === t ? ' selected' : ''}>${t || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="re-basics-field">
          <label>Photo</label>
          ${ed.hasPhoto && ed.recipeId ? `<img src="/api/recipes/${ed.recipeId}/photo" class="re-photo-thumb" />` : ''}
          <input type="file" id="re-photo-input" accept="image/*" onchange="rePhotoSelected(this)" style="font-size:11px;max-width:120px;" />
          ${ed.hasPhoto ? '<button class="re-act re-act-del" onclick="reRemovePhoto()" title="Remove photo">&times;</button>' : ''}
        </div>
      </div>
    </div>`;
}

// ── Section: Ingredients ──

function renderIngredientsSection(): string {
  if (!ed) return '';
  const rows = ed.ingredients.map((ing, i) => renderIngredientRow(ing, i)).join('');
  return `
    <div class="re-section">
      <div class="re-section-title-row">
        <span class="re-section-title">Ingredients</span>
        <button class="btn btn-sm" onclick="reAddIngredient()">+ Add ingredient</button>
      </div>
      ${ed.ingredients.length > 0 ? `
      <table class="re-ing-table" id="re-ingredients-list">
        <thead><tr>
          <th class="re-th-num">#</th>
          <th class="re-th-name">Ingredient</th>
          <th class="re-th-amt">Raw</th>
          <th class="re-th-amt">Cooked</th>
          <th class="re-th-unit">Unit</th>
          <th class="re-th-cost">€/port</th>
          <th class="re-th-actions"></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty" style="padding:16px;">No ingredients yet. Click "+ Add ingredient" to start.</div>'}
    </div>`;
}

/** Calculate per-portion costs for all ingredients (for conditional formatting) */
function calcIngredientPortionCosts(): number[] {
  if (!ed) return [];
  const { servings } = calcEditorCostData();
  return ed.ingredients.map(ing => {
    if (ing.ingredientId && !ing.isFlexible) {
      const dbIng = S.ingredientDb.find(i => i.id === ing.ingredientId);
      if (dbIng && dbIng.pricePer100 > 0) {
        const grams = toGrams(ing.rawAmount, ing.unit);
        const total = (grams / 100) * dbIng.pricePer100;
        return servings && servings > 0 ? total / servings : total;
      }
    }
    return 0;
  });
}

/** Interpolate from green (0) to red (1) */
function costColor(ratio: number): string {
  const r = Math.round(200 * Math.min(ratio * 2, 1));
  const g = Math.round(160 * Math.min((1 - ratio) * 2, 1));
  return `rgb(${r},${g},40)`;
}

function renderIngredientRow(ing: EditorIngredient, idx: number): string {
  // Cost per portion for this ingredient (with color)
  let costStr = '';
  const portionCosts = calcIngredientPortionCosts();
  const maxCost = Math.max(...portionCosts.filter(c => c > 0), 0.01);
  const thisCost = portionCosts[idx] || 0;
  if (thisCost > 0) {
    const ratio = thisCost / maxCost;
    costStr = `<span style="color:${costColor(ratio)};font-weight:600;">€${thisCost.toFixed(2)}</span>`;
  }

  if (ing.isFlexible) {
    // Flexible rows get a spanning sub-row for category/suggestions
    return `<tr class="re-ing-flex-row" data-idx="${idx}">
      <td class="re-td-num">${idx + 1}</td>
      <td class="re-td-name">
        <div style="display:flex;align-items:center;gap:4px;">
          <span class="badge" style="background:var(--purple-bg);color:var(--purple);font-size:9px;padding:1px 5px;">Flex</span>
          <input type="text" class="re-inline-input re-inline-name" value="${esc(ing.flexLabel || '')}" onchange="reUpdateIngredient(${idx},'flexLabel',this.value)" placeholder="e.g. Any vegetables" />
        </div>
      </td>
      <td class="re-td-amt"><input type="number" class="re-inline-input re-inline-num" value="${ing.rawAmount || ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'rawAmount',+this.value)" /></td>
      <td class="re-td-amt"><input type="number" class="re-inline-input re-inline-num" value="${ing.cookedAmount ?? ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'cookedAmount',this.value ? +this.value : null)" /></td>
      <td class="re-td-unit"><select class="re-inline-select" onchange="reUpdateIngredient(${idx},'unit',this.value)">${UNITS.map(u => `<option${ing.unit === u ? ' selected' : ''}>${u}</option>`).join('')}</select></td>
      <td class="re-td-cost">${costStr}</td>
      <td class="re-td-actions">
        <button class="re-act" onclick="reMoveIngredient(${idx},-1)" ${idx === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
        <button class="re-act" onclick="reMoveIngredient(${idx},1)" ${idx === ed!.ingredients.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
        <button class="re-act re-act-del" onclick="reRemoveIngredient(${idx})" title="Remove">&times;</button>
      </td>
    </tr>
    <tr class="re-ing-flex-detail" data-idx="${idx}">
      <td></td>
      <td colspan="6">
        <div class="re-flex-detail-row">
          <select class="re-inline-select" onchange="reUpdateIngredient(${idx},'flexCategory',this.value)" style="max-width:160px;">
            <option value="">Category...</option>
            ${FOOD_CATEGORIES.map(c => `<option value="${esc(c)}"${ing.flexCategory === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
          <input type="text" class="re-inline-input" value="${esc(ing.suggestedNames.join(', '))}" onchange="reUpdateIngredient(${idx},'suggestedNames',this.value)" placeholder="Suggestions: Carrot, Pumpkin..." style="flex:1;" />
        </div>
      </td>
    </tr>`;
  }

  return `<tr data-idx="${idx}">
    <td class="re-td-num">${idx + 1}</td>
    <td class="re-td-name">
      <div style="position:relative;">
        <input type="text" class="re-inline-input re-inline-name re-ing-search" value="${esc(ing.ingredientName)}"
          placeholder="Search ingredient..."
          oninput="reIngredientSearch(${idx},this.value)"
          onfocus="reIngredientSearch(${idx},this.value)"
          onblur="setTimeout(()=>reHideSuggestions(${idx}),200)"
          data-idx="${idx}" />
        <div class="re-ing-suggestions" id="re-sug-${idx}"></div>
      </div>
    </td>
    <td class="re-td-amt"><input type="number" class="re-inline-input re-inline-num" value="${ing.rawAmount || ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'rawAmount',+this.value)" /></td>
    <td class="re-td-amt"><input type="number" class="re-inline-input re-inline-num" value="${ing.cookedAmount ?? ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'cookedAmount',this.value ? +this.value : null)" /></td>
    <td class="re-td-unit"><select class="re-inline-select" onchange="reUpdateIngredient(${idx},'unit',this.value)">${UNITS.map(u => `<option${ing.unit === u ? ' selected' : ''}>${u}</option>`).join('')}</select></td>
    <td class="re-td-cost">${costStr}</td>
    <td class="re-td-actions">
      <button class="re-act" style="font-size:9px;" onclick="reToggleFlexible(${idx})" title="Make flexible">F</button>
      <button class="re-act" onclick="reMoveIngredient(${idx},-1)" ${idx === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
      <button class="re-act" onclick="reMoveIngredient(${idx},1)" ${idx === ed!.ingredients.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
      <button class="re-act re-act-del" onclick="reRemoveIngredient(${idx})" title="Remove">&times;</button>
    </td>
  </tr>`;
}

// ── Section: Prep steps ──

function renderPrepStepsSection(): string {
  if (!ed) return '';
  const rows = ed.prepSteps.map((ps, i) => `<tr data-idx="${i}">
    <td class="re-td-num">${i + 1}</td>
    <td class="re-prep-td-text"><textarea class="re-inline-input re-prep-textarea" onchange="reUpdatePrepStep(${i},'text',this.value)" placeholder="Describe this step..." rows="2">${esc(ps.text)}</textarea></td>
    <td class="re-prep-td-note"><textarea class="re-inline-input re-inline-note re-prep-textarea" onchange="reUpdatePrepStep(${i},'note',this.value)" placeholder="Note..." rows="2">${esc(ps.note || '')}</textarea></td>
    <td class="re-td-actions">
      <button class="re-act" onclick="reMovePrepStep(${i},-1)" ${i === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
      <button class="re-act" onclick="reMovePrepStep(${i},1)" ${i === ed!.prepSteps.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
      <button class="re-act re-act-del" onclick="reRemovePrepStep(${i})" title="Remove">&times;</button>
    </td>
  </tr>`).join('');

  return `
    <div class="re-section">
      <div class="re-section-title">Prep steps</div>
      <table class="re-prep-table" id="re-prep-list">
        <thead><tr>
          <th class="re-th-num">#</th>
          <th>Step</th>
          <th class="re-prep-th-note">Note</th>
          <th class="re-th-actions"></th>
        </tr></thead>
        <tbody>
          ${rows}
          <tr class="re-prep-ghost">
            <td class="re-td-num" style="color:var(--border2);">${ed.prepSteps.length + 1}</td>
            <td><input type="text" class="re-inline-input re-ghost-input" value="" onfocus="rePrepGhostFocus(this)" placeholder="Add step..." /></td>
            <td></td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>`;
}

// ── Section: Storage ──

function renderStorageSection(): string {
  if (!ed) return '';
  return `
    <div class="re-section re-basics">
      <div class="re-basics-row">
        <div class="re-basics-field" style="flex:1;">
          <label>Cooling method</label>
          <input type="text" class="re-inline-input" value="${esc(ed.coolingMethod)}" onchange="reUpdateField('coolingMethod',this.value)" placeholder="e.g. Cool in ice bath within 2 hours, then refrigerate" />
        </div>
        <div class="re-basics-field" style="flex:1;">
          <label>Storage method</label>
          <input type="text" class="re-inline-input" value="${esc(ed.storageMethod)}" onchange="reUpdateField('storageMethod',this.value)" placeholder="e.g. Walk-in fridge, shelf 2, labelled with date" />
        </div>
      </div>
    </div>`;
}

// ── Section: Allergens ──

function renderAllergensSection(): string {
  if (!ed) return '';
  const allergens = calcAutoAllergens();
  const allAllergens = [...new Set([...allergens, ...ed.extraAllergens])];
  return `
    <div class="re-section">
      <div class="re-section-title">Allergens</div>
      <div style="margin-bottom:8px;">
        ${allAllergens.map(a => `<span class="allergen-pill">${esc(a)}</span>`).join(' ') || '<span style="color:var(--text2);font-size:12px;">None detected</span>'}
      </div>
      <div>
        <label style="font-size:12px;font-weight:500;color:var(--text2);">Extra allergens (cross-contamination, etc.)</label>
        <div class="allergen-tags" id="re-extra-allergens">
          ${ed.extraAllergens.map(a => `<span class="at-tag">${esc(a)} <span class="at-rm" onclick="reRemoveExtraAllergen('${esc(a)}')">&times;</span></span>`).join('')}
        </div>
        <div class="allergen-input-row" style="margin-top:6px;">
          <select id="re-add-allergen">
            <option value="">Add allergen...</option>
            ${ALLERGENS.filter(a => !ed!.extraAllergens.includes(a) && !allergens.includes(a)).map(a => `<option>${a}</option>`).join('')}
          </select>
          <button class="btn btn-sm" onclick="reAddExtraAllergen()">Add</button>
        </div>
      </div>
    </div>`;
}

// ── Section: Save ──

function renderSaveSection(): string {
  if (!ed) return '';
  const checks = [
    { ok: !!ed.name, label: 'Recipe name' },
    { ok: !!ed.type, label: 'Dish type' },
    { ok: ed.servingSize > 0, label: 'Serving size' },
    { ok: ed.ingredients.length > 0, label: 'At least 1 ingredient' },
    { ok: ed.prepSteps.length > 0, label: 'At least 1 prep step' },
    { ok: !!(ed.coolingMethod || ed.storageMethod), label: 'Storage info' },
  ];
  const allOk = checks.every(c => c.ok);
  const checklistHtml = checks.map(c => `<span class="re-check-inline ${c.ok ? 're-check-ok' : ''}">${c.ok ? '&#10003;' : '&#9675;'} ${esc(c.label)}</span>`).join('');

  return `
    <div class="re-section re-save-section">
      <div class="re-checklist-inline">${checklistHtml}</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" data-testid="recipe-save-draft" onclick="reSaveRecipe(false)">Save${allOk ? '' : ' (incomplete)'}</button>
        ${allOk ? '<button class="btn btn-primary" onclick="reSaveRecipe(true)" style="background:var(--green);border-color:var(--green);">Save as complete</button>' : ''}
      </div>
    </div>`;
}

function calcAutoAllergens(): string[] {
  if (!ed) return [];
  const allergenSet = new Set<string>();
  ed.ingredients.forEach(ing => {
    if (ing.ingredientId && !ing.isFlexible) {
      const dbIng = S.ingredientDb.find(i => i.id === ing.ingredientId);
      if (dbIng && dbIng.allergens) {
        dbIng.allergens.split(',').map(a => a.trim()).filter(Boolean).forEach(a => allergenSet.add(a));
      }
    }
  });
  return [...allergenSet].sort();
}

// ── Field update handlers ──

type EditorTextField = 'name' | 'type' | 'structure' | 'seasonality' | 'servingTemp' | 'coolingMethod' | 'storageMethod';
type EditorNumField = 'servingSize';
type EditorField = EditorTextField | EditorNumField;

export function reUpdateField(field: EditorField, value: string | number | null) {
  if (!ed) return;
  if (field === 'servingSize') {
    ed.servingSize = Number(value) || 0;
    refreshPriceBar();
  } else {
    ed[field] = String(value ?? '');
  }
}

export function rePhotoSelected(input: HTMLInputElement) {
  if (!ed || !input.files || !input.files[0]) return;
  ed.photoFile = input.files[0];
  ed.hasPhoto = true;
}

export function reRemovePhoto() {
  if (!ed) return;
  ed.photoFile = null;
  ed.hasPhoto = false;
  if (ed.recipeId) {
    apiPost(`/api/recipes/${ed.recipeId}/photo`, {}, 'DELETE').catch(() => {});
  }
  renderEditorBody();
}

// ── Ingredient handlers ──

export function reAddIngredient() {
  if (!ed) return;
  ed.ingredients.push({
    id: tempId(),
    ingredientId: null,
    ingredientName: '',
    sortOrder: ed.ingredients.length,
    rawAmount: 0,
    cookedAmount: null,
    unit: 'Grams',
    isFlexible: false,
    flexCategory: null,
    flexLabel: null,
    suggestedNames: [],
  });
  renderEditorBody();
  refreshPriceBar();
}

export function reRemoveIngredient(idx: number) {
  if (!ed) return;
  ed.ingredients.splice(idx, 1);
  ed.ingredients.forEach((ing, i) => ing.sortOrder = i);
  renderEditorBody();
  refreshPriceBar();
}

export function reMoveIngredient(idx: number, dir: number) {
  if (!ed) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= ed.ingredients.length) return;
  const tmp = ed.ingredients[idx];
  ed.ingredients[idx] = ed.ingredients[newIdx];
  ed.ingredients[newIdx] = tmp;
  ed.ingredients.forEach((ing, i) => ing.sortOrder = i);
  renderEditorBody();
}

export function reToggleFlexible(idx: number) {
  if (!ed) return;
  const ing = ed.ingredients[idx];
  ing.isFlexible = !ing.isFlexible;
  if (ing.isFlexible) {
    ing.ingredientId = null;
    ing.ingredientName = '';
  }
  renderEditorBody();
  refreshPriceBar();
}

type IngredientField = 'rawAmount' | 'cookedAmount' | 'unit' | 'flexCategory' | 'flexLabel' | 'suggestedNames';

export function reUpdateIngredient(idx: number, field: IngredientField, value: string | number | null) {
  if (!ed) return;
  const ing = ed.ingredients[idx];
  switch (field) {
    case 'suggestedNames': ing.suggestedNames = String(value ?? '').split(',').map(s => s.trim()).filter(Boolean); break;
    case 'rawAmount': ing.rawAmount = Number(value) || 0; refreshPriceBar(); break;
    case 'cookedAmount': ing.cookedAmount = value != null ? Number(value) || null : null; refreshPriceBar(); break;
    case 'unit': ing.unit = String(value ?? 'Grams'); refreshPriceBar(); break;
    case 'flexCategory': ing.flexCategory = value ? String(value) : null; break;
    case 'flexLabel': ing.flexLabel = value ? String(value) : null; break;
  }
}

export function reIngredientSearch(idx: number, query: string) {
  if (!ed) return;
  ed.ingredients[idx].ingredientName = query;
  const sugEl = document.getElementById(`re-sug-${idx}`);
  if (!sugEl) return;

  if (_suggestionTimeout) clearTimeout(_suggestionTimeout);
  _suggestionTimeout = setTimeout(() => {
    if (!query || query.length < 2) { sugEl.innerHTML = ''; return; }
    const q = query.toLowerCase();
    const matches = S.ingredientDb
      .filter(i => i.active !== false && i.name.toLowerCase().includes(q))
      .slice(0, 8);
    sugEl.innerHTML = matches.map(m => `
      <div class="re-sug-item" onmousedown="reSelectIngredient(${idx},'${jsEsc(m.id)}','${jsEsc(m.name)}')">
        <span>${esc(m.name)}</span>
        <span style="font-size:10px;color:var(--text2);">${esc(m.category || '')}</span>
      </div>`).join('');
  }, 100);
}

export function reSelectIngredient(idx: number, ingredientId: string, name: string) {
  if (!ed) return;
  ed.ingredients[idx].ingredientId = ingredientId;
  ed.ingredients[idx].ingredientName = name;
  const sugEl = document.getElementById(`re-sug-${idx}`);
  if (sugEl) sugEl.innerHTML = '';
  const input = document.querySelector(`[data-idx="${idx}"].re-ing-search`) as HTMLInputElement;
  if (input) input.value = name;
  refreshPriceBar();
}

export function reHideSuggestions(idx: number) {
  const sugEl = document.getElementById(`re-sug-${idx}`);
  if (sugEl) sugEl.innerHTML = '';
}

// ── Prep step handlers ──

export function reAddPrepStep() {
  if (!ed) return;
  ed.prepSteps.push({ step: ed.prepSteps.length + 1, text: '', note: '' });
  renderEditorBody();
}

/** When the ghost placeholder row is focused, create a real step and re-render */
export function rePrepGhostFocus(input: HTMLInputElement) {
  if (!ed) return;
  ed.prepSteps.push({ step: ed.prepSteps.length + 1, text: '', note: '' });
  renderEditorBody();
  // Focus the new row's text input
  const newIdx = ed.prepSteps.length - 1;
  setTimeout(() => {
    const row = document.querySelector(`#re-prep-list tr[data-idx="${newIdx}"] .re-inline-input`) as HTMLInputElement;
    if (row) row.focus();
  }, 20);
}

export function reRemovePrepStep(idx: number) {
  if (!ed) return;
  ed.prepSteps.splice(idx, 1);
  ed.prepSteps.forEach((ps, i) => ps.step = i + 1);
  renderEditorBody();
}

export function reMovePrepStep(idx: number, dir: number) {
  if (!ed) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= ed.prepSteps.length) return;
  const tmp = ed.prepSteps[idx];
  ed.prepSteps[idx] = ed.prepSteps[newIdx];
  ed.prepSteps[newIdx] = tmp;
  ed.prepSteps.forEach((ps, i) => ps.step = i + 1);
  renderEditorBody();
}

export function reUpdatePrepStep(idx: number, field: 'text' | 'note', value: string) {
  if (!ed) return;
  if (field === 'text') ed.prepSteps[idx].text = value;
  else if (field === 'note') ed.prepSteps[idx].note = value;
}

// ── Extra allergen handlers ──

export function reAddExtraAllergen() {
  if (!ed) return;
  const sel = document.getElementById('re-add-allergen') as HTMLSelectElement;
  if (!sel || !sel.value) return;
  if (!ed.extraAllergens.includes(sel.value)) {
    ed.extraAllergens.push(sel.value);
  }
  renderEditorBody();
}

export function reRemoveExtraAllergen(allergen: string) {
  if (!ed) return;
  ed.extraAllergens = ed.extraAllergens.filter(a => a !== allergen);
  renderEditorBody();
}

// ── Save recipe ──

export async function reSaveRecipe(markComplete: boolean) {
  trackEvent('recipe_save', markComplete ? 'complete' : 'draft');
  if (!ed) return;
  if (!ed.name.trim()) { toastError('Recipe name is required'); return; }
  if (ed.servingSize <= 0) { toastError('Serving size must be positive'); return; }

  const recipeVolume = calcRecipeVolume();

  const payload = {
    name: ed.name.trim(),
    type: ed.type,
    structure: ed.structure,
    seasonality: ed.seasonality,
    servingTemp: ed.servingTemp,
    servingSize: ed.servingSize,
    recipeVolume: recipeVolume > 0 ? recipeVolume : null,
    prepSteps: ed.prepSteps.filter(ps => ps.text.trim()),
    coolingMethod: ed.coolingMethod,
    storageMethod: ed.storageMethod,
    extraAllergens: ed.extraAllergens,
    isComplete: markComplete,
    ingredients: ed.ingredients.map((ing, i) => ({
      ingredientId: ing.isFlexible ? null : ing.ingredientId,
      sortOrder: i,
      rawAmount: ing.rawAmount,
      cookedAmount: ing.cookedAmount,
      unit: ing.unit,
      isFlexible: ing.isFlexible,
      flexCategory: ing.flexCategory,
      flexLabel: ing.flexLabel,
      suggestedNames: ing.suggestedNames,
    })),
  };

  try {
    let saved: RecipeFull;
    if (ed.recipeId) {
      saved = await apiPost(`/api/recipes/${ed.recipeId}`, payload, 'PATCH');
    } else {
      saved = await apiPost('/api/recipes', payload);
    }

    // Upload photo if selected
    if (ed.photoFile && saved.id) {
      const formData = new FormData();
      formData.append('photo', ed.photoFile);
      await fetch(`/api/recipes/${saved.id}/photo`, { method: 'POST', body: formData });
    }

    // Update local state
    const idx = S.recipes.findIndex(r => r.id === saved.id);
    if (idx >= 0) {
      S.recipes[idx] = saved;
    } else {
      S.recipes.push(saved);
    }

    closeModal();
    toast(`Recipe "${saved.name}" saved`);

    // Re-render recipe index if visible
    const screen = document.getElementById('screen-recipe-index');
    if (screen && screen.classList.contains('active')) {
      const { renderRecipeIndex } = await import('./recipes');
      renderRecipeIndex();
    }
  } catch (e: unknown) {
    toastError('Could not save recipe: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Read-only detail modal with scaling ──

let _detailRecipe: RecipeFull | null = null;
let _detailScale = 1;

function renderDetailModal(r: RecipeFull) {
  _detailRecipe = r;
  _detailScale = 1;
  _renderDetailContent();
}

function _renderDetailContent() {
  const r = _detailRecipe;
  if (!r) return;
  const scale = _detailScale;

  const allAllergens = [...new Set([...(r.autoAllergens || []), ...(r.extraAllergens || [])])];
  const baseServings = r.recipeVolume && r.servingSize ? Math.round((r.recipeVolume * 1000) / r.servingSize) : null;
  const scaledLiters = r.recipeVolume ? r.recipeVolume * scale : null;
  const scaledServings = baseServings ? Math.round(baseServings * scale) : null;

  let nutritionHtml = '';
  if (r.nutrition) {
    const n = r.nutrition;
    nutritionHtml = `<div class="re-nutrition">
      <strong>Nutrition per serving</strong>
      ${n.completeness < 1 ? `<span style="font-size:11px;color:var(--amber);margin-left:8px;">(${Math.round(n.completeness * 100)}% of ingredients have data)</span>` : ''}
      <table class="re-nutrition-table">
        <tr><td>Energy</td><td>${Math.round(n.energyKcal)} kcal / ${Math.round(n.energyKj)} kJ</td></tr>
        <tr><td>Fat</td><td>${n.fat.toFixed(1)}g</td></tr>
        <tr><td>&nbsp;&nbsp;of which saturated</td><td>${n.saturatedFat.toFixed(1)}g</td></tr>
        <tr><td>Carbohydrates</td><td>${n.carbs.toFixed(1)}g</td></tr>
        <tr><td>&nbsp;&nbsp;of which sugar</td><td>${n.sugar.toFixed(1)}g</td></tr>
        <tr><td>Fiber</td><td>${n.fiber.toFixed(1)}g</td></tr>
        <tr><td>Protein</td><td>${n.protein.toFixed(1)}g</td></tr>
        <tr><td>Salt</td><td>${n.salt.toFixed(2)}g</td></tr>
      </table>
    </div>`;
  }

  const canScale = r.recipeVolume != null && r.recipeVolume > 0 && r.ingredients.length > 0;
  const scaleRowHtml = canScale ? `
    <div class="br-scale-row" style="margin-bottom:12px;">
      <label>Volume:</label>
      <input type="number" class="re-inline-input re-inline-num" value="${scaledLiters!.toFixed(1)}" min="0.1" step="0.5"
        onchange="detailUpdateLiters(+this.value)" style="width:70px;" />
      <span>L</span>
      ${scaledServings !== null ? `
        <span style="color:var(--text2);">&nbsp;|&nbsp;</span>
        <label>Portions:</label>
        <input type="number" class="re-inline-input re-inline-num" value="${scaledServings}" min="1" step="1"
          onchange="detailUpdatePortions(+this.value)" style="width:70px;" />
      ` : ''}
      <span class="br-scale-info">(recipe: ${r.recipeVolume!.toFixed(1)}L${scale !== 1 ? `, scale: ${scale.toFixed(1)}x` : ''})</span>
      ${scale !== 1 ? `<button class="btn btn-sm" onclick="detailResetScale()" style="margin-left:4px;font-size:11px;">Reset</button>` : ''}
    </div>` : '';

  const content = `
    <div style="width:600px;max-width:90vw;">
      <div style="display:flex;gap:16px;margin-bottom:16px;">
        ${r.photoUrl ? `<img src="${r.photoUrl}" style="width:120px;height:120px;object-fit:cover;border-radius:var(--radius);" />` : ''}
        <div>
          <h3 style="margin-bottom:4px;">${esc(r.name)}</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
            ${typeBadge((r.type || 'Soup') as DishType)}
            ${r.structure ? `<span class="badge" style="background:var(--bg2);color:var(--text2);">${esc(r.structure)}</span>` : ''}
            ${r.seasonality ? `<span class="badge" style="background:var(--bg2);color:var(--text2);">${esc(r.seasonality)}</span>` : ''}
            ${scaledServings ? `<span class="badge" style="background:var(--blue-bg);color:var(--blue);">${scaledServings} servings</span>` : ''}
            ${r.costPerServing != null ? `<span class="badge" style="background:var(--green-bg);color:var(--green);">&euro;${r.costPerServing.toFixed(2)}/serving</span>` : ''}
            ${r.isComplete ? '<span class="badge" style="background:var(--green-bg);color:var(--green);">Complete</span>' : '<span class="badge" style="background:var(--amber-bg);color:var(--amber);">In progress</span>'}
          </div>
          <div>${allAllergens.map(a => `<span class="allergen-pill">${esc(a)}</span>`).join(' ') || '<span style="color:var(--text2);font-size:12px;">No allergens</span>'}</div>
        </div>
      </div>

      ${scaleRowHtml}

      ${r.ingredients.length > 0 ? `
        <div class="re-review-section">
          <strong>Ingredients (${r.ingredients.length})</strong>
          <table class="re-detail-table">
            <thead><tr><th>Ingredient</th><th>Raw</th><th>Cooked</th><th>Unit</th></tr></thead>
            <tbody>
              ${r.ingredients.map(ing => {
                const scaledRaw = scale !== 1 ? roundForUnit(ing.rawAmount * scale, ing.unit) : ing.rawAmount;
                const scaledCooked = ing.cookedAmount != null ? (scale !== 1 ? roundForUnit(ing.cookedAmount * scale, ing.unit) : ing.cookedAmount) : null;
                return `<tr${ing.isFlexible ? ' style="font-style:italic;color:var(--purple);"' : ''}>
                <td>${ing.isFlexible ? esc(ing.flexLabel || 'Flexible') + ' (' + esc(ing.flexCategory || '') + ')' : esc(ing.ingredientName || 'Unknown')}</td>
                <td>${scaledRaw}</td>
                <td>${scaledCooked ?? '—'}</td>
                <td>${esc(ing.unit)}</td>
              </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : ''}

      ${r.prepSteps.length > 0 ? `
        <div class="re-review-section">
          <strong>Prep steps</strong>
          <ol class="re-detail-steps">
            ${r.prepSteps.map(ps => `<li>${esc(ps.text)}${ps.note ? `<div class="re-step-note">${esc(ps.note)}</div>` : ''}</li>`).join('')}
          </ol>
        </div>` : ''}

      ${r.coolingMethod || r.storageMethod ? `
        <div class="re-review-section">
          ${r.coolingMethod ? `<div style="margin-bottom:8px;"><strong>Cooling:</strong> ${esc(r.coolingMethod)}</div>` : ''}
          ${r.storageMethod ? `<div><strong>Storage:</strong> ${esc(r.storageMethod)}</div>` : ''}
        </div>` : ''}

      ${r.versions && r.versions.length > 0 ? `
        <div class="re-review-section">
          <strong>Version history (${r.versions.length})</strong>
          <div style="font-size:12px;color:var(--text2);margin-top:4px;">
            ${r.versions.map(v => `<div>v${v.version} &mdash; ${esc(v.date)} by ${esc(v.changedBy)}${v.notes ? ': ' + esc(v.notes) : ''}</div>`).join('')}
          </div>
        </div>` : ''}

      ${nutritionHtml}

      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" onclick="rePrintRecipe('${esc(r.id)}')">Print A4</button>
        <button class="btn" onclick="reVersionRecipe('${esc(r.id)}')">Save version</button>
        <button class="btn btn-primary" onclick="openRecipeEditor('${esc(r.id)}')">Edit</button>
      </div>
    </div>
  `;

  // Update modal content in-place if already open, otherwise show new modal
  const existingModal = document.querySelector('.modal');
  if (existingModal) {
    existingModal.innerHTML = content;
  } else {
    showModal(content);
  }
  const modal = document.querySelector('.modal') as HTMLElement;
  if (modal) { modal.style.width = '640px'; modal.style.maxWidth = '95vw'; }
}

export function detailUpdateLiters(newLiters: number) {
  if (!_detailRecipe || newLiters <= 0 || !_detailRecipe.recipeVolume) return;
  _detailScale = newLiters / _detailRecipe.recipeVolume;
  _renderDetailContent();
}

export function detailUpdatePortions(portions: number) {
  if (!_detailRecipe || portions <= 0 || !_detailRecipe.servingSize || !_detailRecipe.recipeVolume) return;
  const targetLiters = (portions * _detailRecipe.servingSize) / 1000;
  _detailScale = targetLiters / _detailRecipe.recipeVolume;
  _renderDetailContent();
}

export function detailResetScale() {
  _detailScale = 1;
  _renderDetailContent();
}

// ── Print ──

export function rePrintRecipe(recipeId: string) {
  const scaleParam = _detailRecipe && _detailRecipe.id === recipeId && _detailScale !== 1
    ? `?scale=${_detailScale}` : '';
  window.open(`/api/recipes/${recipeId}/print${scaleParam}`, '_blank');
}

// ── Version snapshot ──

export async function reVersionRecipe(recipeId: string) {
  const notes = prompt('Version notes (optional):') ?? '';
  try {
    await apiPost(`/api/recipes/${recipeId}/version`, { notes });
    toast('Version saved');
    const r: RecipeFull = await apiGet(`/api/recipes/${recipeId}`);
    const idx = S.recipes.findIndex(x => x.id === r.id);
    if (idx >= 0) S.recipes[idx] = r;
    renderDetailModal(r);
  } catch (e: unknown) {
    toastError('Could not save version: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Batch Recipe Editor ──
// Unified editor for batch-specific recipe: resolve flex, edit ingredients, view prep, record notes

interface BatchIngredient {
  ingredientId: string | null;
  name: string;
  amount: number;
  unit: string;
  isFlexible: boolean;
  flexLabel: string | null;
  flexCategory: string | null;
  resolved: boolean;
  removed: boolean;
}

interface BatchRecipeState {
  batchId: string;
  recipeId: string;
  recipeName: string;
  ingredients: BatchIngredient[];
  prepSteps: PrepStep[];
  cookNotes: string;
  deductStock: boolean;
  isFullscreen: boolean;
  targetLiters: number;
  recipeVolume: number;
  servingSize: number;
}

let _brState: BatchRecipeState | null = null;

/** Open batch recipe editor — used for pre-cook flex resolution AND post-cook recording */
export function openBatchRecipe(batchId: string) {
  const batch = S.batches.find(b => b.id === batchId);
  if (!batch || !batch.recipeId) return;
  const recipe = S.recipes.find(r => r.id === batch.recipeId);
  if (!recipe) return;

  const recipeVolume = recipe.recipeVolume || 0;
  const batchLiters = (batch.stock || 0) > 0 ? batch.stock : recipeVolume;
  let scaleFactor = 1;
  if (recipeVolume > 0) {
    scaleFactor = batchLiters / recipeVolume;
  }

  // Pre-fill from existing actualIngredients if available
  const existing = batch.actualIngredients as Array<{ ingredientId: string; name: string; amount: number; unit: string }> | undefined;
  const usedExisting = new Set<number>();

  _brState = {
    batchId,
    recipeId: recipe.id,
    recipeName: recipe.name,
    prepSteps: recipe.prepSteps || [],
    cookNotes: batch.cookNotes || '',
    deductStock: false,
    isFullscreen: false,
    targetLiters: batchLiters,
    recipeVolume,
    servingSize: recipe.servingSize || 280,
    ingredients: recipe.ingredients.map(ing => {
      // Try to match pre-resolved flexible slots
      if (ing.isFlexible && existing) {
        const matchIdx = existing.findIndex((r, ri) => r.ingredientId && !usedExisting.has(ri));
        if (matchIdx >= 0) {
          usedExisting.add(matchIdx);
          const match = existing[matchIdx];
          return {
            ingredientId: match.ingredientId,
            name: match.name,
            amount: match.amount,
            unit: match.unit,
            isFlexible: true,
            flexLabel: ing.flexLabel || 'Flexible',
            flexCategory: ing.flexCategory,
            resolved: true,
            removed: false,
          };
        }
      }
      return {
        ingredientId: ing.isFlexible ? null : ing.ingredientId,
        name: ing.isFlexible ? (ing.flexLabel || 'Flexible') : (ing.ingredientName || 'Unknown'),
        amount: roundForUnit(ing.rawAmount * scaleFactor, ing.unit),
        unit: ing.unit,
        isFlexible: ing.isFlexible,
        flexLabel: ing.isFlexible ? (ing.flexLabel || 'Flexible') : null,
        flexCategory: ing.isFlexible ? ing.flexCategory : null,
        resolved: !ing.isFlexible,
        removed: false,
      };
    }),
  };
  renderBatchRecipe();
}

/** Backward-compat aliases */
export function openResolveFlexible(batchId: string) { openBatchRecipe(batchId); }
export function openPostCookRecording(batchId: string) { openBatchRecipe(batchId); }

function renderBatchRecipe() {
  if (!_brState) return;
  const br = _brState;
  const batch = S.batches.find(b => b.id === br.batchId);
  if (!batch) return;

  const html = buildBatchRecipeHTML(br, batch);

  if (br.isFullscreen) {
    // Remove modal if open
    closeModal();
    // Remove existing fullscreen overlay
    let overlay = document.getElementById('br-fullscreen');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'br-fullscreen';
      overlay.className = 'br-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="br-editor br-fullscreen-inner">${html}</div>`;
  } else {
    // Remove fullscreen overlay if present
    const overlay = document.getElementById('br-fullscreen');
    if (overlay) overlay.remove();
    showModal(`<div class="br-editor">${html}</div>`);
  }
}

function buildBatchRecipeHTML(br: BatchRecipeState, batch: { name: string; stock: number }): string {
  // Ingredient rows
  const activeIngs = br.ingredients.filter(i => !i.removed);
  const removedIngs = br.ingredients.map((ing, i) => ({ ...ing, _idx: i })).filter(i => i.removed);

  const ingRows = br.ingredients.map((ing, i) => {
    if (ing.removed) return '';

    // Flexible & unresolved
    if (ing.isFlexible && !ing.resolved) {
      return `<tr class="re-ing-flex-row">
        <td class="re-td-num">${activeIngs.indexOf(ing) + 1}</td>
        <td class="re-td-name" style="position:relative;">
          <div style="display:flex;align-items:center;gap:4px;margin-bottom:2px;">
            <span class="badge" style="background:var(--purple-bg);color:var(--purple);font-size:10px;">Flex</span>
            <span style="font-size:12px;font-style:italic;color:var(--text2);">${esc(ing.flexLabel || 'Flexible')}</span>
          </div>
          <input type="text" class="re-inline-input re-ing-search" placeholder="Pick ingredient..."
            oninput="brIngSearch(${i},this.value)"
            onfocus="brIngSearch(${i},this.value)"
            onblur="setTimeout(()=>{const el=document.getElementById('br-sug-${i}');if(el)el.innerHTML='';},200)" />
          <div class="re-ing-suggestions" id="br-sug-${i}"></div>
        </td>
        <td class="re-td-amt">
          <input type="number" class="re-inline-input re-inline-num" value="${ing.amount}" min="0"
            onchange="brUpdateAmount(${i},+this.value)" />
        </td>
        <td class="re-td-unit"><span style="font-size:12px;color:var(--text2);">${esc(ing.unit)}</span></td>
        <td class="re-td-actions">
          <button class="re-act re-act-del" onclick="brRemoveIng(${i})" title="Remove">&times;</button>
        </td>
      </tr>`;
    }

    // Resolved flexible or normal ingredient
    return `<tr${ing.isFlexible ? ' class="re-ing-flex-row"' : ''}>
      <td class="re-td-num">${activeIngs.indexOf(ing) + 1}</td>
      <td class="re-td-name">
        <span style="font-weight:500;">${esc(ing.name)}</span>
        ${ing.isFlexible ? ` <span style="font-size:10px;color:var(--purple);">(${esc(ing.flexLabel || 'flex')})</span>` : ''}
      </td>
      <td class="re-td-amt">
        <input type="number" class="re-inline-input re-inline-num" value="${ing.amount}" min="0"
          onchange="brUpdateAmount(${i},+this.value)" />
      </td>
      <td class="re-td-unit"><span style="font-size:12px;color:var(--text2);">${esc(ing.unit)}</span></td>
      <td class="re-td-actions">
        ${ing.isFlexible ? `<button class="re-act" onclick="brUnresolve(${i})" title="Change ingredient">&#x21c4;</button>` : ''}
        <button class="re-act re-act-del" onclick="brRemoveIng(${i})" title="Remove">&times;</button>
      </td>
    </tr>`;
  }).join('');

  // Removed ingredients
  const removedHTML = removedIngs.length ? `
    <div style="margin-top:6px;font-size:12px;color:var(--text2);">
      <strong>Removed:</strong>
      ${removedIngs.map(r => `
        <span style="text-decoration:line-through;margin-right:8px;">${esc(r.name)}</span>
        <button class="re-act" onclick="brRestoreIng(${r._idx})" title="Restore" style="font-size:11px;">&#x21a9;</button>
      `).join('')}
    </div>` : '';

  // Prep steps (read-only from recipe)
  const prepHTML = br.prepSteps.length ? `
    <div class="re-section">
      <div class="re-section-title">Prep steps</div>
      <ol class="br-prep-list">
        ${br.prepSteps.map(s => `<li>${esc(s.text)}${s.note ? `<div class="re-step-note">${esc(s.note)}</div>` : ''}</li>`).join('')}
      </ol>
    </div>` : '';

  // Add ingredient search
  const addIngHTML = `
    <div style="margin-top:6px;position:relative;">
      <input type="text" class="re-inline-input" placeholder="+ Add ingredient..." id="br-add-search"
        oninput="brAddIngSearch(this.value)"
        onfocus="brAddIngSearch(this.value)"
        onblur="setTimeout(()=>{const el=document.getElementById('br-add-sug');if(el)el.innerHTML='';},200)" />
      <div class="re-ing-suggestions" id="br-add-sug"></div>
    </div>`;

  const portions = br.recipeVolume > 0 && br.servingSize > 0 ? Math.round((br.targetLiters * 1000) / br.servingSize) : null;
  const scaleFactor = br.recipeVolume > 0 ? (br.targetLiters / br.recipeVolume) : 1;
  const canScale = br.recipeVolume > 0;

  return `
    <div class="br-header">
      <div style="flex:1;">
        <h3 style="margin:0;">${esc(batch.name)}</h3>
        <span style="font-size:12px;color:var(--text2);">Batch recipe &mdash; ${batch.stock}L</span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button class="btn btn-sm" onclick="brToggleFullscreen()" title="${br.isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}">
          ${br.isFullscreen ? '&#x2715; Exit fullscreen' : '&#x26F6; Fullscreen'}
        </button>
        <button class="btn btn-sm" onclick="openRecipeEditor('${jsEsc(br.recipeId)}')" title="Edit original recipe">
          &#x270E; Edit original
        </button>
      </div>
    </div>
    ${canScale ? `<div class="br-scale-row">
      <label>Volume:</label>
      <input type="number" class="re-inline-input re-inline-num" value="${br.targetLiters}" min="0.1" step="0.5"
        onchange="brUpdateTargetLiters(+this.value)" style="width:70px;" />
      <span>L</span>
      ${portions !== null ? `
        <span style="color:var(--text2);">&nbsp;|&nbsp;</span>
        <label>Portions:</label>
        <input type="number" class="re-inline-input re-inline-num" value="${portions}" min="1" step="1"
          onchange="brUpdateTargetPortions(+this.value)" style="width:70px;" />
      ` : ''}
      <span class="br-scale-info">(recipe: ${br.recipeVolume}L, scale: ${scaleFactor.toFixed(1)}x)</span>
    </div>` : `<div class="br-scale-row"><span style="color:var(--text2);font-size:12px;">Set recipe volume to enable scaling</span></div>`}
    <div class="br-body">
      <div class="re-section">
        <div class="re-section-title">Ingredients</div>
        <table class="re-ing-table">
          <thead><tr>
            <th class="re-th-num">#</th>
            <th class="re-th-name">Ingredient</th>
            <th class="re-th-amt">Amount</th>
            <th class="re-th-unit">Unit</th>
            <th class="re-th-actions"></th>
          </tr></thead>
          <tbody>${ingRows}</tbody>
        </table>
        ${addIngHTML}
        ${removedHTML}
      </div>

      ${prepHTML}

      <div class="re-section">
        <div class="re-section-title">Cook notes</div>
        <textarea class="re-inline-input" rows="2" style="height:auto;resize:vertical;"
          onchange="brUpdateNotes(this.value)" placeholder="Any notes about this cook...">${esc(br.cookNotes)}</textarea>
      </div>

      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin:8px 0 12px;">
        <input type="checkbox" ${br.deductStock ? 'checked' : ''} onchange="brToggleDeduct(this.checked)" />
        Deduct ingredients from stock after saving
      </label>

      <div class="modal-actions">
        <button class="btn" onclick="brClose()">Cancel</button>
        <button class="btn btn-primary" onclick="brSave()">Save</button>
      </div>
    </div>`;
}

export function brToggleFullscreen() {
  if (!_brState) return;
  _brState.isFullscreen = !_brState.isFullscreen;
  renderBatchRecipe();
}

export function brUpdateTargetLiters(newLiters: number) {
  if (!_brState || newLiters <= 0 || !_brState.recipeVolume) return;
  const recipe = S.recipes.find(r => r.id === _brState!.recipeId);
  if (!recipe) return;

  const newScale = newLiters / _brState.recipeVolume;
  _brState.targetLiters = newLiters;

  // Rescale from base recipe amounts (not current displayed amounts) to avoid rounding drift
  recipe.ingredients.forEach((baseIng, i) => {
    if (i < _brState!.ingredients.length && !_brState!.ingredients[i].removed) {
      _brState!.ingredients[i].amount = roundForUnit(baseIng.rawAmount * newScale, baseIng.unit);
    }
  });

  renderBatchRecipe();
}

export function brUpdateTargetPortions(portions: number) {
  if (!_brState || portions <= 0 || !_brState.servingSize) return;
  const liters = (portions * _brState.servingSize) / 1000;
  brUpdateTargetLiters(liters);
}

export function brIngSearch(idx: number, query: string) {
  if (!_brState) return;
  const sugEl = document.getElementById(`br-sug-${idx}`);
  if (!sugEl || !query || query.length < 2) { if (sugEl) sugEl.innerHTML = ''; return; }
  const flexCat = _brState.ingredients[idx].flexCategory;
  const q = query.toLowerCase();
  let matches = S.ingredientDb.filter(i => i.active !== false && i.name.toLowerCase().includes(q));
  if (flexCat) matches = matches.filter(i => i.category === flexCat).concat(matches.filter(i => i.category !== flexCat));
  matches = matches.slice(0, 8);
  sugEl.innerHTML = matches.map(m => `
    <div class="re-sug-item" onmousedown="brPickIng(${idx},'${jsEsc(m.id)}','${jsEsc(m.name)}')">
      <span>${esc(m.name)}</span>
      <span style="font-size:10px;color:var(--text2);">${esc(m.category || '')}</span>
    </div>`).join('');
}

export function brPickIng(idx: number, ingredientId: string, name: string) {
  if (!_brState) return;
  _brState.ingredients[idx].ingredientId = ingredientId;
  _brState.ingredients[idx].name = name;
  _brState.ingredients[idx].resolved = true;
  renderBatchRecipe();
}

export function brUnresolve(idx: number) {
  if (!_brState) return;
  _brState.ingredients[idx].ingredientId = null;
  _brState.ingredients[idx].name = _brState.ingredients[idx].flexLabel || 'Flexible';
  _brState.ingredients[idx].resolved = false;
  renderBatchRecipe();
}

export function brUpdateAmount(idx: number, amount: number) {
  if (!_brState) return;
  _brState.ingredients[idx].amount = amount;
}

export function brRemoveIng(idx: number) {
  if (!_brState) return;
  _brState.ingredients[idx].removed = true;
  renderBatchRecipe();
}

export function brRestoreIng(idx: number) {
  if (!_brState) return;
  _brState.ingredients[idx].removed = false;
  renderBatchRecipe();
}

export function brAddIngSearch(query: string) {
  if (!_brState) return;
  const sugEl = document.getElementById('br-add-sug');
  if (!sugEl || !query || query.length < 2) { if (sugEl) sugEl.innerHTML = ''; return; }
  const q = query.toLowerCase();
  const matches = S.ingredientDb.filter(i => i.active !== false && i.name.toLowerCase().includes(q)).slice(0, 8);
  sugEl.innerHTML = matches.map(m => `
    <div class="re-sug-item" onmousedown="brAddIng('${jsEsc(m.id)}','${jsEsc(m.name)}','${jsEsc(m.unit || 'Grams')}')">
      <span>${esc(m.name)}</span>
      <span style="font-size:10px;color:var(--text2);">${esc(m.category || '')}</span>
    </div>`).join('');
}

export function brAddIng(ingredientId: string, name: string, unit: string) {
  if (!_brState) return;
  _brState.ingredients.push({
    ingredientId,
    name,
    amount: 0,
    unit,
    isFlexible: false,
    flexLabel: null,
    flexCategory: null,
    resolved: true,
    removed: false,
  });
  renderBatchRecipe();
  // Focus the amount field of the new ingredient
  setTimeout(() => {
    const rows = document.querySelectorAll('.br-editor .re-ing-table tbody tr');
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const amtInput = lastRow.querySelector('.re-inline-num') as HTMLInputElement;
      if (amtInput) amtInput.focus();
    }
  }, 50);
}

export function brUpdateNotes(notes: string) {
  if (!_brState) return;
  _brState.cookNotes = notes;
}

export function brToggleDeduct(checked: boolean) {
  if (!_brState) return;
  _brState.deductStock = checked;
}

export function brClose() {
  _brState = null;
  const overlay = document.getElementById('br-fullscreen');
  if (overlay) overlay.remove();
  closeModal();
}

export async function brSave() {
  if (!_brState) return;
  const br = _brState;
  const batch = S.batches.find(b => b.id === br.batchId);
  if (!batch) return;

  const actualIngredients = br.ingredients
    .filter(i => !i.removed && i.resolved && i.ingredientId)
    .map(i => ({ ingredientId: i.ingredientId!, name: i.name, amount: i.amount, unit: i.unit }));

  try {
    await apiPost(`/api/batches/${br.batchId}`, {
      actualIngredients,
      cookNotes: br.cookNotes,
      stockDeducted: br.deductStock,
    }, 'PATCH');

    batch.actualIngredients = actualIngredients;
    batch.cookNotes = br.cookNotes;
    batch.stockDeducted = br.deductStock;

    if (br.deductStock) {
      const stockUpdates: Array<{ id: string; amount: number }> = [];
      actualIngredients.forEach(ai => {
        if (ai.ingredientId) {
          const grams = toGrams(ai.amount, ai.unit);
          stockUpdates.push({ id: ai.ingredientId, amount: -grams });
        }
      });
      if (stockUpdates.length > 0) {
        try {
          await apiPost('/api/ingredients/stock/bulk', {
            location: batch.location,
            updates: stockUpdates.map(u => ({ ingredientId: u.id, amount: u.amount })),
          });
        } catch (e: unknown) {
          console.warn('Failed to deduct stock:', e);
        }
      }
    }

    _brState = null;
    const overlay = document.getElementById('br-fullscreen');
    if (overlay) overlay.remove();
    closeModal();
    toast('Batch recipe saved');
    rerenderCurrentView();
  } catch (e: unknown) {
    toastError('Could not save: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}
