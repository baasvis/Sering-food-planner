// UUID GENERATION
// ═══════════════════════════════════════════════════════════════════
function newId() {
  return crypto.randomUUID();
}

// ═══════════════════════════════════════════════════════════════════
// API + SAVE SYSTEM
// ═══════════════════════════════════════════════════════════════════

async function apiGet(path) {
  const r = await fetch(path);
  if (r.status === 401) { doLogout(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || 'Request failed'); }
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.status === 401) { doLogout(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || 'Save failed'); }
  return r.json();
}

// Save state management
let saveTimer = null;
let saveState = 'saved'; // 'saved' | 'unsaved' | 'saving' | 'error'
let retryCount = 0;
const MAX_RETRIES = 3;

function setSaveState(state, msg) {
  saveState = state;
  const dot = document.getElementById('save-dot');
  const text = document.getElementById('save-text');
  if (!dot || !text) return;
  dot.className = 'save-dot ' + state;
  text.textContent = msg || {saved:'Saved',unsaved:'Unsaved',saving:'Saving...',error:'Save failed'}[state];
}

// ── Snapshot diffing for patch saves ──
let _lastSaved = { dishes: new Map(), guests: '', caterings: new Map(), transportItems: new Map() };

function takeSnapshot() {
  _lastSaved = {
    dishes: new Map(S.dishes.map(d => [d.id, JSON.stringify(d)])),
    guests: JSON.stringify(S.guests),
    caterings: new Map(S.caterings.map(c => [c.id, JSON.stringify(c)])),
    transportItems: new Map(S.transportItems.map(t => [t.id, JSON.stringify(t)])),
  };
}

function computePatch() {
  const patch = { dishes: [], deletedDishes: [], guests: null,
                  caterings: [], deletedCaterings: [],
                  transportItems: [], deletedTransportItems: [] };

  // Dishes
  const curDishIds = new Set(S.dishes.map(d => d.id));
  for (const d of S.dishes) {
    const prev = _lastSaved.dishes.get(d.id);
    if (!prev || prev !== JSON.stringify(d)) patch.dishes.push(d);
  }
  for (const [id] of _lastSaved.dishes) {
    if (!curDishIds.has(id)) patch.deletedDishes.push(id);
  }

  // Guests (small fixed structure — send full if changed)
  if (JSON.stringify(S.guests) !== _lastSaved.guests) patch.guests = S.guests;

  // Caterings
  const curCatIds = new Set(S.caterings.map(c => c.id));
  for (const c of S.caterings) {
    const prev = _lastSaved.caterings.get(c.id);
    if (!prev || prev !== JSON.stringify(c)) patch.caterings.push(c);
  }
  for (const [id] of _lastSaved.caterings) {
    if (!curCatIds.has(id)) patch.deletedCaterings.push(id);
  }

  // Transport items
  const curTrIds = new Set(S.transportItems.map(t => t.id));
  for (const t of S.transportItems) {
    const prev = _lastSaved.transportItems.get(t.id);
    if (!prev || prev !== JSON.stringify(t)) patch.transportItems.push(t);
  }
  for (const [id] of _lastSaved.transportItems) {
    if (!curTrIds.has(id)) patch.deletedTransportItems.push(id);
  }

  return patch;
}

function patchIsEmpty(p) {
  return p.dishes.length === 0 && p.deletedDishes.length === 0 &&
         p.guests === null &&
         p.caterings.length === 0 && p.deletedCaterings.length === 0 &&
         p.transportItems.length === 0 && p.deletedTransportItems.length === 0;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  setSaveState('unsaved');
  // Debounce: wait 1.5s after last change before saving
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
  if (saveState === 'saving') return;
  const patch = computePatch();
  if (patchIsEmpty(patch)) { setSaveState('saved'); return; }
  setSaveState('saving');
  try {
    const result = await apiPost('/api/data/patch', patch);
    takeSnapshot();
    setSaveState('saved', 'Saved');
    retryCount = 0;
    if (result && result.concurrent) {
      const c = result.concurrent;
      toast(`${c.recentUser} saved ${c.agoSeconds < 60 ? c.agoSeconds + 's' : Math.round(c.agoSeconds/60) + 'min'} ago — consider reloading`);
    }
  } catch (e) {
    retryCount++;
    if (retryCount <= MAX_RETRIES) {
      setSaveState('error', `Retry ${retryCount}/${MAX_RETRIES}...`);
      setTimeout(doSave, 2000 * retryCount);
    } else {
      setSaveState('error', 'Save failed — check connection');
      toastError('Could not save changes. Check your internet connection and try again.');
      retryCount = 0;
    }
  }
}

// Explicit save (for manual retry)
function retrySave() {
  retryCount = 0;
  doSave();
}

async function loadData() {
  try {
    const data = await apiGet('/api/data');
    if (data.guests) S.guests = data.guests;
    if (data.recipeIndex) S.recipeIndex = data.recipeIndex;
    if (data.dishes) S.dishes = data.dishes;
    if (data.caterings) S.caterings = data.caterings;
    if (data.transportItems) S.transportItems = data.transportItems;
    takeSnapshot();
    rebuildPlanner();
    // Load ingredient DB in background (for order overview)
    loadIngredientDb();
    // Load guest history + next weeks in background (for Guests tab)
    loadGuestHistory();
    loadGuestsNextWeeks();
  } catch (e) {
    console.warn('Could not load from server, using defaults');
    toastError('Could not load data: ' + e.message);
  }
}

let ingredientDbLoaded = false;
let ingredientDbError = '';
async function loadIngredientDb() {
  try {
    const result = await apiGet('/api/ingredients');
    // Handle error-as-data response
    if (result && result.error) {
      console.error('Ingredient DB API error:', result.error);
      S.ingredientDb = [];
      ingredientDbError = result.error;
    } else if (Array.isArray(result)) {
      S.ingredientDb = result;
      ingredientDbError = '';
      console.log('Ingredient DB loaded:', S.ingredientDb.length, 'items');
      if (S.ingredientDb.length > 0) console.log('Sample:', S.ingredientDb[0].name, '| code:', S.ingredientDb[0].orderCode);
    } else {
      console.error('Ingredient DB unexpected response:', result);
      S.ingredientDb = [];
      ingredientDbError = 'Unexpected response format';
    }
    ingredientDbLoaded = true;
  } catch (e) {
    console.error('Failed to load ingredient DB:', e);
    S.ingredientDb = [];
    ingredientDbLoaded = true;
    ingredientDbError = e.message || 'Unknown error';
  }
}

async function loadGuestHistory() {
  try {
    const data = await apiGet('/api/guest-history');
    S.guestHistory = data;
    if (data && (data.west || data.centraal)) {
      S.predictions = predictGuests(data);
    }
  } catch (e) {
    console.warn('Could not load guest history:', e.message);
  }
}

async function loadGuestsNextWeeks() {
  try {
    const data = await apiGet('/api/guests-next-weeks');
    if (data && typeof data === 'object') S.guestsNextWeeks = data;
  } catch (e) {
    console.warn('Could not load next weeks data:', e.message);
  }
}

let _nextWeeksSaveTimer = null;
function scheduleNextWeeksSave() {
  if (_nextWeeksSaveTimer) clearTimeout(_nextWeeksSaveTimer);
  setSaveState('unsaved');
  _nextWeeksSaveTimer = setTimeout(async () => {
    setSaveState('saving');
    try {
      await apiPost('/api/guests-next-weeks', S.guestsNextWeeks);
      setSaveState('saved', 'Saved');
    } catch (e) {
      setSaveState('error', 'Save failed');
    }
  }, 1500);
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => t.className = 'toast', 2200);
}

function toastError(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast error show';
  setTimeout(() => t.className = 'toast', 4000);
}

// ═══════════════════════════════════════════════════════════════════
// PREP CHECKLIST API
// ═══════════════════════════════════════════════════════════════════

function todayIso() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

async function loadPrepChecklist(loc) {
  try {
    const data = await apiGet(`/api/prep-checklist?loc=${loc}&date=${todayIso()}`);
    S.prepChecklist[loc] = new Set(Array.isArray(data) ? data : []);
  } catch (e) {
    S.prepChecklist[loc] = new Set();
  }
}

let _prepSaveTimer = null;
function schedulePrepSave(loc) {
  if (_prepSaveTimer) clearTimeout(_prepSaveTimer);
  _prepSaveTimer = setTimeout(async () => {
    try {
      await apiPost('/api/prep-checklist', {
        loc,
        date: todayIso(),
        checked: [...(S.prepChecklist[loc] || new Set())],
      });
    } catch (e) {
      console.warn('Could not save prep checklist:', e.message);
    }
  }, 600);
}

// ═══════════════════════════════════════════════════════════════════
