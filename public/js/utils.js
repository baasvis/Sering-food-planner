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

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  setSaveState('unsaved');
  // Debounce: wait 1.5s after last change before saving
  saveTimer = setTimeout(doSave, 1500);
}

async function doSave() {
  if (saveState === 'saving') return;
  setSaveState('saving');
  try {
    const result = await apiPost('/api/data', { guests: S.guests, dishes: S.dishes, caterings: S.caterings, transportItems: S.transportItems });
    setSaveState('saved', 'Saved');
    retryCount = 0;
  } catch (e) {
    retryCount++;
    if (retryCount <= MAX_RETRIES) {
      setSaveState('error', `Retry ${retryCount}/${MAX_RETRIES}...`);
      setTimeout(doSave, 2000 * retryCount); // exponential-ish backoff
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
