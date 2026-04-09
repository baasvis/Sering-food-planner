// ─────────────────────────────────────────────────────────────────────────────
// RECIPE EDITOR — multi-step guided creation & editing for Recipe v2
// ─────────────────────────────────────────────────────────────────────────────

import { S, ALLERGENS, INGREDIENT_CATEGORIES } from './state';
import { apiGet, apiPost, toast, toastError, loadIngredientDb } from './utils';
import { typeBadge, TYPES } from './core';
import { showModal, closeModal, esc } from './modal';
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
  step: number;                  // 1-5
  name: string;
  type: string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  recipeVolume: number | null;
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

// ── Public entry points ──

export function openRecipeEditor(recipeId?: string) {
  if (recipeId) {
    loadRecipeForEdit(recipeId);
  } else {
    ed = {
      recipeId: null, step: 1,
      name: '', type: 'Soup', structure: '', seasonality: '', servingTemp: '',
      servingSize: 280, recipeVolume: null,
      ingredients: [], prepSteps: [], coolingMethod: '', storageMethod: '',
      extraAllergens: [], photoFile: null, hasPhoto: false, isComplete: false,
    };
    renderEditor();
  }
}

export function openRecipeDetail(recipeId: string) {
  const r = S.recipes.find(x => x.id === recipeId);
  if (!r) { toastError('Recipe not found'); return; }
  renderDetailModal(r);
}

// ── Load recipe for editing ──

async function loadRecipeForEdit(id: string) {
  try {
    const r: RecipeFull = await apiGet(`/api/recipes/${id}`);
    ed = {
      recipeId: r.id, step: 1,
      name: r.name, type: r.type, structure: r.structure, seasonality: r.seasonality,
      servingTemp: r.servingTemp, servingSize: r.servingSize, recipeVolume: r.recipeVolume,
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

// ── Step navigation ──

export function recipeEditorStep(step: number) {
  if (!ed) return;
  ed.step = step;
  renderEditorBody();
}

// ── Render the editor modal shell ──

function renderEditor() {
  if (!ed) return;
  const isNew = !ed.recipeId;
  showModal(`
    <div class="re-editor" style="width:600px;max-width:90vw;">
      <div class="re-header">
        <h3>${isNew ? 'Create new recipe' : 'Edit recipe'}</h3>
        ${renderCompleteness()}
      </div>
      ${renderStepNav()}
      <div id="re-body"></div>
    </div>
  `);
  // Widen modal for recipe editor
  const modal = document.querySelector('.modal') as HTMLElement;
  if (modal) { modal.style.width = '640px'; modal.style.maxWidth = '95vw'; }
  renderEditorBody();
}

function renderCompleteness(): string {
  if (!ed) return '';
  let done = 0, total = 5;
  if (ed.name && ed.type) done++;
  if (ed.ingredients.length > 0) done++;
  if (ed.prepSteps.length > 0) done++;
  if (ed.coolingMethod || ed.storageMethod) done++;
  if (ed.ingredients.length > 0 && ed.name) done++; // review = ready
  const pct = Math.round((done / total) * 100);
  return `<div class="re-completeness">
    <div class="re-completeness-bar"><div class="re-completeness-fill" style="width:${pct}%"></div></div>
    <span class="re-completeness-text">${pct}% complete</span>
  </div>`;
}

function renderStepNav(): string {
  if (!ed) return '';
  const steps = [
    { n: 1, label: 'Basics' },
    { n: 2, label: 'Ingredients' },
    { n: 3, label: 'Prep steps' },
    { n: 4, label: 'Storage' },
    { n: 5, label: 'Review' },
  ];
  return `<div class="re-step-nav">
    ${steps.map(s => `<button class="re-step-btn${ed!.step === s.n ? ' active' : ''}" onclick="recipeEditorStep(${s.n})">${s.n}. ${s.label}</button>`).join('')}
  </div>`;
}

function renderEditorBody() {
  if (!ed) return;
  const body = document.getElementById('re-body');
  if (!body) return;
  switch (ed.step) {
    case 1: body.innerHTML = renderStep1(); break;
    case 2: body.innerHTML = renderStep2(); break;
    case 3: body.innerHTML = renderStep3(); break;
    case 4: body.innerHTML = renderStep4(); break;
    case 5: body.innerHTML = renderStep5(); break;
  }
}

// ── STEP 1: Basics ──

function renderStep1(): string {
  if (!ed) return '';
  return `
    <div class="re-step">
      <div class="fr"><label>Recipe name *</label>
        <input type="text" id="re-name" value="${esc(ed.name)}" onchange="reUpdateField('name',this.value)" placeholder="e.g. North African lentil soup" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="fr"><label>Type *</label>
          <select id="re-type" onchange="reUpdateField('type',this.value)">
            ${['Soup', 'Main course', 'Dessert'].map(t => `<option${ed!.type === t ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </div>
        <div class="fr"><label>Structure</label>
          <select id="re-structure" onchange="reUpdateField('structure',this.value)">
            ${STRUCTURES.map(s => `<option value="${esc(s)}"${ed!.structure === s ? ' selected' : ''}>${s || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="fr"><label>Seasonality</label>
          <select id="re-season" onchange="reUpdateField('seasonality',this.value)">
            ${SEASONS.map(s => `<option value="${esc(s)}"${ed!.seasonality === s ? ' selected' : ''}>${s || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="fr"><label>Serving temp</label>
          <select id="re-temp" onchange="reUpdateField('servingTemp',this.value)">
            ${TEMPS.map(t => `<option value="${esc(t)}"${ed!.servingTemp === t ? ' selected' : ''}>${t || '—'}</option>`).join('')}
          </select>
        </div>
        <div class="fr"><label>Serving size (ml) *</label>
          <input type="number" id="re-serving" value="${ed.servingSize}" min="1" onchange="reUpdateField('servingSize',+this.value)" />
        </div>
        <div class="fr"><label>Recipe volume (liters)</label>
          <input type="number" id="re-volume" value="${ed.recipeVolume || ''}" min="0" step="0.1" onchange="reUpdateField('recipeVolume',this.value ? +this.value : null)" />
        </div>
      </div>
      <div class="fr"><label>Photo</label>
        <div class="re-photo-area">
          ${ed.hasPhoto && ed.recipeId ? `<img src="/api/recipes/${ed.recipeId}/photo" class="re-photo-preview" />` : ''}
          <input type="file" id="re-photo-input" accept="image/*" onchange="rePhotoSelected(this)" style="font-size:12px;" />
          ${ed.hasPhoto ? '<button class="btn btn-sm btn-danger" onclick="reRemovePhoto()" style="margin-top:4px;">Remove photo</button>' : ''}
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="recipeEditorStep(2)">Next: Ingredients &rarr;</button>
      </div>
    </div>`;
}

// ── STEP 2: Ingredients ──

function renderStep2(): string {
  if (!ed) return '';
  const rows = ed.ingredients.map((ing, i) => renderIngredientRow(ing, i)).join('');
  const costHtml = calcEditorCost();
  return `
    <div class="re-step">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:500;">${ed.ingredients.length} ingredient${ed.ingredients.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-sm" onclick="reAddIngredient()">+ Add ingredient</button>
      </div>
      <div class="re-ingredients-list" id="re-ingredients-list">
        ${rows || '<div class="empty" style="padding:16px;">No ingredients yet. Click "+ Add ingredient" to start.</div>'}
      </div>
      ${costHtml}
      <div class="modal-actions">
        <button class="btn" onclick="recipeEditorStep(1)">&larr; Basics</button>
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="recipeEditorStep(3)">Next: Prep steps &rarr;</button>
      </div>
    </div>`;
}

function renderIngredientRow(ing: EditorIngredient, idx: number): string {
  if (ing.isFlexible) {
    return `<div class="re-ing-row re-ing-flexible" data-idx="${idx}">
      <div class="re-ing-header">
        <span class="re-ing-num">${idx + 1}</span>
        <span class="badge" style="background:var(--purple-bg);color:var(--purple);font-size:10px;">Flexible</span>
        <div style="flex:1;"></div>
        <button class="btn btn-sm" onclick="reMoveIngredient(${idx},-1)" ${idx === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
        <button class="btn btn-sm" onclick="reMoveIngredient(${idx},1)" ${idx === ed!.ingredients.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
        <button class="btn btn-sm btn-danger" onclick="reRemoveIngredient(${idx})" title="Remove">&times;</button>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px;">
        <div class="fr"><label>Label</label>
          <input type="text" value="${esc(ing.flexLabel || '')}" onchange="reUpdateIngredient(${idx},'flexLabel',this.value)" placeholder="e.g. Any vegetables" />
        </div>
        <div class="fr"><label>Category</label>
          <select onchange="reUpdateIngredient(${idx},'flexCategory',this.value)">
            <option value="">Select category...</option>
            ${FOOD_CATEGORIES.map(c => `<option value="${esc(c)}"${ing.flexCategory === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="fr"><label>Suggested names (comma-separated)</label>
        <input type="text" value="${esc(ing.suggestedNames.join(', '))}" onchange="reUpdateIngredient(${idx},'suggestedNames',this.value)" placeholder="e.g. Carrot, Pumpkin, Celeriac" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <div class="fr"><label>Raw amount</label>
          <input type="number" value="${ing.rawAmount || ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'rawAmount',+this.value)" />
        </div>
        <div class="fr"><label>Cooked amount</label>
          <input type="number" value="${ing.cookedAmount ?? ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'cookedAmount',this.value ? +this.value : null)" />
        </div>
        <div class="fr"><label>Unit</label>
          <select onchange="reUpdateIngredient(${idx},'unit',this.value)">
            ${UNITS.map(u => `<option${ing.unit === u ? ' selected' : ''}>${u}</option>`).join('')}
          </select>
        </div>
      </div>
    </div>`;
  }

  return `<div class="re-ing-row" data-idx="${idx}">
    <div class="re-ing-header">
      <span class="re-ing-num">${idx + 1}</span>
      <div style="flex:1;position:relative;">
        <input type="text" class="re-ing-search" value="${esc(ing.ingredientName)}"
          placeholder="Search ingredient..."
          oninput="reIngredientSearch(${idx},this.value)"
          onfocus="reIngredientSearch(${idx},this.value)"
          onblur="setTimeout(()=>reHideSuggestions(${idx}),200)"
          data-idx="${idx}" />
        <div class="re-ing-suggestions" id="re-sug-${idx}"></div>
      </div>
      <button class="btn btn-sm" style="font-size:10px;" onclick="reToggleFlexible(${idx})" title="Make flexible">Flex</button>
      <button class="btn btn-sm" onclick="reMoveIngredient(${idx},-1)" ${idx === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
      <button class="btn btn-sm" onclick="reMoveIngredient(${idx},1)" ${idx === ed!.ingredients.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
      <button class="btn btn-sm btn-danger" onclick="reRemoveIngredient(${idx})" title="Remove">&times;</button>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:4px;">
      <div class="fr"><label>Raw amount</label>
        <input type="number" value="${ing.rawAmount || ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'rawAmount',+this.value)" />
      </div>
      <div class="fr"><label>Cooked amount</label>
        <input type="number" value="${ing.cookedAmount ?? ''}" min="0" step="1" onchange="reUpdateIngredient(${idx},'cookedAmount',this.value ? +this.value : null)" />
      </div>
      <div class="fr"><label>Unit</label>
        <select onchange="reUpdateIngredient(${idx},'unit',this.value)">
          ${UNITS.map(u => `<option${ing.unit === u ? ' selected' : ''}>${u}</option>`).join('')}
        </select>
      </div>
    </div>
  </div>`;
}

function calcEditorCost(): string {
  if (!ed || ed.ingredients.length === 0) return '';
  let totalCost = 0;
  let hasPrice = 0;
  ed.ingredients.forEach(ing => {
    if (ing.ingredientId && !ing.isFlexible) {
      const dbIng = S.ingredientDb.find(i => i.id === ing.ingredientId);
      if (dbIng && dbIng.pricePer100 > 0) {
        const grams = toGrams(ing.rawAmount, ing.unit);
        totalCost += (grams / 100) * dbIng.pricePer100;
        hasPrice++;
      }
    }
  });
  if (hasPrice === 0) return '';
  const servings = ed.recipeVolume && ed.servingSize ? Math.round((ed.recipeVolume * 1000) / ed.servingSize) : null;
  const perServing = servings && servings > 0 ? totalCost / servings : null;
  return `<div class="re-cost-summary">
    <span>Total ingredient cost: <strong>&euro;${totalCost.toFixed(2)}</strong></span>
    ${perServing !== null ? `<span style="margin-left:12px;">Per serving: <strong>&euro;${perServing.toFixed(2)}</strong></span>` : ''}
    <span style="margin-left:12px;font-size:11px;color:var(--text2);">(${hasPrice}/${ed.ingredients.filter(i => !i.isFlexible).length} ingredients have prices)</span>
  </div>`;
}

function toGrams(amount: number, unit: string): number {
  switch (unit) {
    case 'Kilos': return amount * 1000;
    case 'Liters': return amount * 1000;
    case 'ML': return amount;
    default: return amount; // Grams
  }
}

// ── STEP 3: Prep steps ──

function renderStep3(): string {
  if (!ed) return '';
  const steps = ed.prepSteps.map((ps, i) => `
    <div class="re-prep-step" data-idx="${i}">
      <div class="re-prep-header">
        <span class="re-ing-num">${i + 1}</span>
        <button class="btn btn-sm" onclick="reMovePrepStep(${i},-1)" ${i === 0 ? 'disabled' : ''} title="Move up">&uarr;</button>
        <button class="btn btn-sm" onclick="reMovePrepStep(${i},1)" ${i === ed!.prepSteps.length - 1 ? 'disabled' : ''} title="Move down">&darr;</button>
        <button class="btn btn-sm btn-danger" onclick="reRemovePrepStep(${i})" title="Remove">&times;</button>
      </div>
      <textarea class="re-prep-text" rows="2" onchange="reUpdatePrepStep(${i},'text',this.value)" placeholder="Describe this step...">${esc(ps.text)}</textarea>
      <input type="text" class="re-prep-note" value="${esc(ps.note || '')}" onchange="reUpdatePrepStep(${i},'note',this.value)" placeholder="Optional note (e.g. Don't walk away)" />
    </div>`).join('');

  return `
    <div class="re-step">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
        <span style="font-size:13px;font-weight:500;">${ed.prepSteps.length} step${ed.prepSteps.length !== 1 ? 's' : ''}</span>
        <button class="btn btn-sm" onclick="reAddPrepStep()">+ Add step</button>
      </div>
      <div id="re-prep-list">
        ${steps || '<div class="empty" style="padding:16px;">No prep steps yet.</div>'}
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="recipeEditorStep(2)">&larr; Ingredients</button>
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="recipeEditorStep(4)">Next: Storage &rarr;</button>
      </div>
    </div>`;
}

// ── STEP 4: Storage ──

function renderStep4(): string {
  if (!ed) return '';
  return `
    <div class="re-step">
      <div class="fr"><label>Cooling method</label>
        <textarea id="re-cooling" rows="3" style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);resize:vertical;" onchange="reUpdateField('coolingMethod',this.value)" placeholder="e.g. Cool in ice bath within 2 hours, then refrigerate">${esc(ed.coolingMethod)}</textarea>
      </div>
      <div class="fr"><label>Storage method</label>
        <textarea id="re-storage" rows="3" style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);resize:vertical;" onchange="reUpdateField('storageMethod',this.value)" placeholder="e.g. Walk-in fridge, shelf 2, labelled with date">${esc(ed.storageMethod)}</textarea>
      </div>
      <div class="modal-actions">
        <button class="btn" onclick="recipeEditorStep(3)">&larr; Prep steps</button>
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="recipeEditorStep(5)">Next: Review &rarr;</button>
      </div>
    </div>`;
}

// ── STEP 5: Review & Save ──

function renderStep5(): string {
  if (!ed) return '';
  const allergens = calcAutoAllergens();
  const allAllergens = [...new Set([...allergens, ...ed.extraAllergens])];
  const servings = ed.recipeVolume && ed.servingSize ? Math.round((ed.recipeVolume * 1000) / ed.servingSize) : null;

  let checklistHtml = '';
  const checks = [
    { ok: !!ed.name, label: 'Recipe name' },
    { ok: !!ed.type, label: 'Dish type' },
    { ok: ed.servingSize > 0, label: 'Serving size' },
    { ok: ed.ingredients.length > 0, label: 'At least 1 ingredient' },
    { ok: ed.prepSteps.length > 0, label: 'At least 1 prep step' },
    { ok: !!(ed.coolingMethod || ed.storageMethod), label: 'Storage info' },
  ];
  checklistHtml = checks.map(c => `<div class="re-check ${c.ok ? 're-check-ok' : ''}">
    <span>${c.ok ? '&#10003;' : '&#9675;'}</span> ${esc(c.label)}
  </div>`).join('');
  const allOk = checks.every(c => c.ok);

  return `
    <div class="re-step">
      <h4 style="margin-bottom:6px;">${esc(ed.name) || 'Unnamed recipe'}</h4>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;">
        ${typeBadge((ed.type || 'Soup') as DishType)}
        ${ed.structure ? `<span class="badge" style="background:var(--bg2);color:var(--text2);">${esc(ed.structure)}</span>` : ''}
        ${ed.seasonality ? `<span class="badge" style="background:var(--bg2);color:var(--text2);">${esc(ed.seasonality)}</span>` : ''}
        ${servings ? `<span class="badge" style="background:var(--blue-bg);color:var(--blue);">${servings} servings</span>` : ''}
      </div>

      <div class="re-review-section">
        <strong>Ingredients (${ed.ingredients.length})</strong>
        <div class="re-review-ingredients">
          ${ed.ingredients.map(ing => `<div class="re-review-ing">
            ${ing.isFlexible
              ? `<em>${esc(ing.flexLabel || 'Flexible')}</em> (${esc(ing.flexCategory || '')})`
              : esc(ing.ingredientName || 'Unnamed')}
            <span class="re-review-amt">${ing.rawAmount} ${ing.unit}</span>
          </div>`).join('') || '<span style="color:var(--text2);">None</span>'}
        </div>
      </div>

      <div class="re-review-section">
        <strong>Allergens</strong>
        <div style="margin-top:4px;">
          ${allAllergens.map(a => `<span class="allergen-pill">${esc(a)}</span>`).join(' ') || '<span style="color:var(--text2);">None detected</span>'}
        </div>
        <div style="margin-top:8px;">
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
      </div>

      <div class="re-review-section">
        <strong>Completeness</strong>
        <div style="margin-top:4px;">${checklistHtml}</div>
      </div>

      <div class="modal-actions">
        <button class="btn" onclick="recipeEditorStep(4)">&larr; Storage</button>
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" onclick="reSaveRecipe(false)">Save${allOk ? '' : ' (incomplete)'}</button>
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
type EditorNumField = 'servingSize' | 'recipeVolume';
type EditorField = EditorTextField | EditorNumField;

export function reUpdateField(field: EditorField, value: string | number | null) {
  if (!ed) return;
  if (field === 'servingSize') ed.servingSize = Number(value) || 0;
  else if (field === 'recipeVolume') ed.recipeVolume = value != null ? Number(value) || null : null;
  else ed[field] = String(value ?? '');
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
}

export function reRemoveIngredient(idx: number) {
  if (!ed) return;
  ed.ingredients.splice(idx, 1);
  ed.ingredients.forEach((ing, i) => ing.sortOrder = i);
  renderEditorBody();
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
}

type IngredientField = 'rawAmount' | 'cookedAmount' | 'unit' | 'flexCategory' | 'flexLabel' | 'suggestedNames';

export function reUpdateIngredient(idx: number, field: IngredientField, value: string | number | null) {
  if (!ed) return;
  const ing = ed.ingredients[idx];
  switch (field) {
    case 'suggestedNames': ing.suggestedNames = String(value ?? '').split(',').map(s => s.trim()).filter(Boolean); break;
    case 'rawAmount': ing.rawAmount = Number(value) || 0; break;
    case 'cookedAmount': ing.cookedAmount = value != null ? Number(value) || null : null; break;
    case 'unit': ing.unit = String(value ?? 'Grams'); break;
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
  if (!ed) return;
  if (!ed.name.trim()) { toastError('Recipe name is required'); return; }
  if (ed.servingSize <= 0) { toastError('Serving size must be positive'); return; }

  const payload = {
    name: ed.name.trim(),
    type: ed.type,
    structure: ed.structure,
    seasonality: ed.seasonality,
    servingTemp: ed.servingTemp,
    servingSize: ed.servingSize,
    recipeVolume: ed.recipeVolume,
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
      // Dynamically import to avoid circular dep
      const { renderRecipeIndex } = await import('./recipes');
      renderRecipeIndex();
    }
  } catch (e: unknown) {
    toastError('Could not save recipe: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Read-only detail modal ──

function renderDetailModal(r: RecipeFull) {
  const allAllergens = [...new Set([...(r.autoAllergens || []), ...(r.extraAllergens || [])])];
  const servings = r.recipeVolume && r.servingSize ? Math.round((r.recipeVolume * 1000) / r.servingSize) : null;

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

  showModal(`
    <div style="width:600px;max-width:90vw;">
      <div style="display:flex;gap:16px;margin-bottom:16px;">
        ${r.photoUrl ? `<img src="${r.photoUrl}" style="width:120px;height:120px;object-fit:cover;border-radius:var(--radius);" />` : ''}
        <div>
          <h3 style="margin-bottom:4px;">${esc(r.name)}</h3>
          <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">
            ${typeBadge((r.type || 'Soup') as DishType)}
            ${r.structure ? `<span class="badge" style="background:var(--bg2);color:var(--text2);">${esc(r.structure)}</span>` : ''}
            ${r.seasonality ? `<span class="badge" style="background:var(--bg2);color:var(--text2);">${esc(r.seasonality)}</span>` : ''}
            ${servings ? `<span class="badge" style="background:var(--blue-bg);color:var(--blue);">${servings} servings</span>` : ''}
            ${r.costPerServing != null ? `<span class="badge" style="background:var(--green-bg);color:var(--green);">&euro;${r.costPerServing.toFixed(2)}/serving</span>` : ''}
            ${r.isComplete ? '<span class="badge" style="background:var(--green-bg);color:var(--green);">Complete</span>' : '<span class="badge" style="background:var(--amber-bg);color:var(--amber);">In progress</span>'}
          </div>
          <div>${allAllergens.map(a => `<span class="allergen-pill">${esc(a)}</span>`).join(' ') || '<span style="color:var(--text2);font-size:12px;">No allergens</span>'}</div>
        </div>
      </div>

      ${r.ingredients.length > 0 ? `
        <div class="re-review-section">
          <strong>Ingredients (${r.ingredients.length})</strong>
          <table class="re-detail-table">
            <thead><tr><th>Ingredient</th><th>Raw</th><th>Cooked</th><th>Unit</th></tr></thead>
            <tbody>
              ${r.ingredients.map(ing => `<tr${ing.isFlexible ? ' style="font-style:italic;color:var(--purple);"' : ''}>
                <td>${ing.isFlexible ? esc(ing.flexLabel || 'Flexible') + ' (' + esc(ing.flexCategory || '') + ')' : esc(ing.ingredientName || 'Unknown')}</td>
                <td>${ing.rawAmount}</td>
                <td>${ing.cookedAmount ?? '—'}</td>
                <td>${esc(ing.unit)}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}

      ${nutritionHtml}

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

      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Close</button>
        <button class="btn" onclick="rePrintRecipe('${esc(r.id)}')">Print A4</button>
        <button class="btn" onclick="reVersionRecipe('${esc(r.id)}')">Save version</button>
        <button class="btn btn-primary" onclick="openRecipeEditor('${esc(r.id)}')">Edit</button>
      </div>
    </div>
  `);
  const modal = document.querySelector('.modal') as HTMLElement;
  if (modal) { modal.style.width = '640px'; modal.style.maxWidth = '95vw'; }
}

// ── Print ──

export function rePrintRecipe(recipeId: string) {
  window.open(`/api/recipes/${recipeId}/print`, '_blank');
}

// ── Version snapshot ──

export async function reVersionRecipe(recipeId: string) {
  const notes = prompt('Version notes (optional):') ?? '';
  try {
    await apiPost(`/api/recipes/${recipeId}/version`, { notes });
    toast('Version saved');
    // Reload detail
    const r: RecipeFull = await apiGet(`/api/recipes/${recipeId}`);
    const idx = S.recipes.findIndex(x => x.id === r.id);
    if (idx >= 0) S.recipes[idx] = r;
    renderDetailModal(r);
  } catch (e: unknown) {
    toastError('Could not save version: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}

// ── Post-cook recording ──

interface PostCookIngredient {
  ingredientId: string | null;
  name: string;
  amount: number;
  unit: string;
  isFlexible: boolean;
  resolved: boolean; // flexible slot has been picked
}

let _postCookState: {
  batchId: string;
  ingredients: PostCookIngredient[];
  cookNotes: string;
  deductStock: boolean;
} | null = null;

/**
 * Called after confirmCooked() for batches with a v2 recipeId.
 * Shows a modal to record actual ingredients used.
 */
export function openPostCookRecording(batchId: string) {
  const batch = S.batches.find(b => b.id === batchId);
  if (!batch || !batch.recipeId) return;
  const recipe = S.recipes.find(r => r.id === batch.recipeId);
  if (!recipe) return;

  // Scale ingredients from recipe to batch
  let scaleFactor = 1;
  if (recipe.recipeVolume && recipe.recipeVolume > 0) {
    // Use batch stock if > 0, otherwise recipe volume (uncooked batch = 1:1 scale)
    const batchLiters = (batch.stock || 0) > 0 ? batch.stock : recipe.recipeVolume;
    scaleFactor = batchLiters / recipe.recipeVolume;
  }

  _postCookState = {
    batchId,
    cookNotes: '',
    deductStock: false,
    ingredients: recipe.ingredients.map(ing => ({
      ingredientId: ing.isFlexible ? null : ing.ingredientId,
      name: ing.isFlexible ? (ing.flexLabel || 'Flexible') : (ing.ingredientName || 'Unknown'),
      amount: Math.round(ing.rawAmount * scaleFactor),
      unit: ing.unit,
      isFlexible: ing.isFlexible,
      resolved: !ing.isFlexible,
    })),
  };
  renderPostCookModal();
}

function renderPostCookModal() {
  if (!_postCookState) return;
  const pc = _postCookState;
  const batch = S.batches.find(b => b.id === pc.batchId);
  if (!batch) return;

  const ingRows = pc.ingredients.map((ing, i) => {
    if (ing.isFlexible && !ing.resolved) {
      return `<div class="re-ing-row re-ing-flexible" style="padding:8px;">
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <span class="badge" style="background:var(--purple-bg);color:var(--purple);font-size:10px;">Flex</span>
          <span style="font-size:13px;font-style:italic;">${esc(ing.name)}</span>
        </div>
        <div style="position:relative;">
          <input type="text" class="re-ing-search" placeholder="Pick ingredient..."
            oninput="rePostCookSearch(${i},this.value)"
            onfocus="rePostCookSearch(${i},this.value)"
            onblur="setTimeout(()=>{const el=document.getElementById('pc-sug-${i}');if(el)el.innerHTML='';},200)" />
          <div class="re-ing-suggestions" id="pc-sug-${i}"></div>
        </div>
      </div>`;
    }
    return `<div class="re-ing-row" style="padding:8px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:13px;flex:1;">${esc(ing.name)}${ing.isFlexible ? ' <span style="font-size:10px;color:var(--purple);">(was flexible)</span>' : ''}</span>
        <input type="number" style="width:80px;font-size:13px;height:28px;border:1px solid var(--border2);border-radius:var(--radius);padding:0 6px;text-align:right;"
          value="${ing.amount}" min="0" onchange="rePostCookUpdateAmount(${i},+this.value)" />
        <span style="font-size:12px;color:var(--text2);width:50px;">${esc(ing.unit)}</span>
      </div>
    </div>`;
  }).join('');

  showModal(`
    <div style="width:560px;max-width:90vw;">
      <h3>Post-cook recording</h3>
      <p style="font-size:13px;color:var(--text2);margin-bottom:12px;">Record what was actually used for <strong>${esc(batch.name)}</strong> (${batch.stock}L)</p>

      <div style="max-height:40vh;overflow-y:auto;margin-bottom:12px;" id="pc-ingredients">
        ${ingRows}
      </div>

      <div class="fr"><label>Cook notes</label>
        <textarea style="width:100%;font-size:13px;border:1px solid var(--border2);border-radius:var(--radius);padding:8px;background:var(--bg);color:var(--text);resize:vertical;font-family:inherit;"
          rows="2" onchange="rePostCookNotes(this.value)" placeholder="Any notes about this cook...">${esc(pc.cookNotes)}</textarea>
      </div>

      <label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-bottom:12px;">
        <input type="checkbox" ${pc.deductStock ? 'checked' : ''} onchange="rePostCookDeduct(this.checked)" />
        Deduct ingredients from stock
      </label>

      <div class="modal-actions">
        <button class="btn" onclick="rePostCookSkip()">Skip</button>
        <button class="btn btn-primary" onclick="rePostCookSave()">Save recording</button>
      </div>
    </div>
  `);
  const modal = document.querySelector('.modal') as HTMLElement;
  if (modal) { modal.style.width = '580px'; modal.style.maxWidth = '95vw'; }
}

export function rePostCookSearch(idx: number, query: string) {
  if (!_postCookState) return;
  const sugEl = document.getElementById(`pc-sug-${idx}`);
  if (!sugEl || !query || query.length < 2) { if (sugEl) sugEl.innerHTML = ''; return; }

  // Filter by flex category if available
  const recipe = S.recipes.find(r => r.id === S.batches.find(b => b.id === _postCookState!.batchId)?.recipeId);
  const recipeIng = recipe?.ingredients[idx];
  const flexCat = recipeIng?.flexCategory;

  const q = query.toLowerCase();
  let matches = S.ingredientDb.filter(i => i.active !== false && i.name.toLowerCase().includes(q));
  if (flexCat) matches = matches.filter(i => i.category === flexCat).concat(matches.filter(i => i.category !== flexCat));
  matches = matches.slice(0, 8);

  sugEl.innerHTML = matches.map(m => `
    <div class="re-sug-item" onmousedown="rePostCookResolve(${idx},'${jsEsc(m.id)}','${jsEsc(m.name)}')">
      <span>${esc(m.name)}</span>
      <span style="font-size:10px;color:var(--text2);">${esc(m.category || '')}</span>
    </div>`).join('');
}

export function rePostCookResolve(idx: number, ingredientId: string, name: string) {
  if (!_postCookState) return;
  _postCookState.ingredients[idx].ingredientId = ingredientId;
  _postCookState.ingredients[idx].name = name;
  _postCookState.ingredients[idx].resolved = true;
  renderPostCookModal();
}

export function rePostCookUpdateAmount(idx: number, amount: number) {
  if (!_postCookState) return;
  _postCookState.ingredients[idx].amount = amount;
}

export function rePostCookNotes(notes: string) {
  if (!_postCookState) return;
  _postCookState.cookNotes = notes;
}

export function rePostCookDeduct(checked: boolean) {
  if (!_postCookState) return;
  _postCookState.deductStock = checked;
}

export function rePostCookSkip() {
  _postCookState = null;
  closeModal();
}

export async function rePostCookSave() {
  if (!_postCookState) return;
  const pc = _postCookState;
  const batch = S.batches.find(b => b.id === pc.batchId);
  if (!batch) return;

  const actualIngredients = pc.ingredients
    .filter(i => i.resolved && i.ingredientId)
    .map(i => ({ ingredientId: i.ingredientId!, name: i.name, amount: i.amount, unit: i.unit }));

  try {
    await apiPost(`/api/batches/${pc.batchId}`, {
      actualIngredients,
      cookNotes: pc.cookNotes,
      stockDeducted: pc.deductStock,
    }, 'PATCH');

    // Update local state
    batch.actualIngredients = actualIngredients;
    batch.cookNotes = pc.cookNotes;
    batch.stockDeducted = pc.deductStock;

    // Deduct stock from ingredient DB if requested
    if (pc.deductStock) {
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

    _postCookState = null;
    closeModal();
    toast('Cook recording saved');
  } catch (e: unknown) {
    toastError('Could not save recording: ' + (e instanceof Error ? e.message : 'Unknown error'));
  }
}
