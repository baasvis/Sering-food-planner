// UUID GENERATION
// ═══════════════════════════════════════════════════════════════════

import { S, DEFAULT_STORAGE_CONFIG, rebuildStorageCategories, canEditScreen } from './state';
import type { StorageArea, Batch, Catering, TransportItem, GuestsData, GuestDay, PatchRequest, SaveSnapshot, SaveState, Location, KitchenEquipment, CookRhythmConfig, CostTargets, ClosedServicesConfig, RecipeFull, Ingredient, StorageConfig, Supply, Drink, DrinkSupplier, DrinkConfig } from '@shared/types';
import { BATCH_SCHEMA_VERSION } from '@shared/types';
import { doLogout } from './auth';
import { rebuildPlanner } from './core';
import { predictGuests } from './predictions';
import { esc } from './modal';
import { rerenderCurrentView, getCurrentScreen } from './navigate';
import { invalidateCategoryCache } from './dashboard';

export function newId(): string {
  return crypto.randomUUID();
}

// Callback for when batches change via SSE (avoids circular import with orders.ts)
let _onBatchesChanged: (() => void) | null = null;
export function setOnBatchesChanged(fn: () => void) { _onBatchesChanged = fn; }

// Callback to flush pending undo before remote patch (avoids circular import with undo.ts)
let _flushUndo: (() => void) | null = null;
export function setFlushUndo(fn: () => void) { _flushUndo = fn; }

// Callback fired after a remote SSE patch is applied — refreshes an open
// inventory modal so its embedded row indices don't go stale. Registered by
// main.ts to avoid a utils → planner circular import.
let _onRemotePatchApplied: (() => void) | null = null;
export function setOnRemotePatchApplied(fn: () => void) { _onRemotePatchApplied = fn; }

// Callback to load the full (rich) ingredient shape (avoids circular import with ingredient-db.ts).
// Used by the bulk-reload path: when the user has the rich shape loaded, we
// must re-fetch with the rich shape so priceHistory/nutrition/pricePer100g
// don't get silently stripped by a slim-shape replace.
let _loadIngredientDbFull: (() => Promise<void>) | null = null;
export function setLoadIngredientDbFull(fn: () => Promise<void>) { _loadIngredientDbFull = fn; }

// ═══════════════════════════════════════════════════════════════════
// API + SAVE SYSTEM
// ═══════════════════════════════════════════════════════════════════

export async function apiGet(path: string): Promise<any> {
  const r = await fetch(path);
  if (r.status === 401) { doLogout(); throw new Error('Session expired'); }
  if (!r.ok) { const e = await r.json().catch(()=>({})); throw new Error(e.error || 'Request failed'); }
  return r.json();
}

// Error with HTTP status attached so callers can distinguish client vs server errors
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// Endpoints that must work regardless of the current screen's edit permission:
// auth (login/logout), telemetry, the global feedback FAB, and the batched
// state autosave (gating it could drop a legit edit made on an edit-screen).
const VIEW_ONLY_EXEMPT = ['/api/auth/', '/api/telemetry', '/api/feedback', '/api/data/patch'];

export async function apiPost(path: string, body: unknown, method: string = 'POST'): Promise<any> {
  // Role guardrail: block writes issued from a screen the user only has 'view'
  // on. This is a frontend guardrail, NOT a security boundary — the API still
  // accepts direct calls; this stops the UI from making them. Reads (GET) and a
  // small set of cross-cutting endpoints are always allowed.
  if (method.toUpperCase() !== 'GET' && !VIEW_ONLY_EXEMPT.some(p => path.startsWith(p)) && !canEditScreen(getCurrentScreen())) {
    toast("View only — you can't make changes on this page");
    throw new ApiError(403, 'view_only');
  }
  const r = await fetch(path, { method, headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.status === 401) { doLogout(); throw new ApiError(401, 'Session expired'); }
  if (!r.ok) {
    const e = await r.json().catch(()=>({}));
    throw new ApiError(r.status, e.error || `HTTP ${r.status}`);
  }
  return r.json();
}

// Save state management
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export let saveState: SaveState = 'saved';
let retryCount = 0;
const MAX_RETRIES = 3;

const SAVE_STATE_LABELS: Record<SaveState, string> = {
  saved: 'Saved',
  unsaved: 'Unsaved',
  saving: 'Saving...',
  error: 'Save failed',
};

export function setSaveState(state: SaveState, msg?: string): void {
  saveState = state;
  const dot = document.getElementById('save-dot');
  const text = document.getElementById('save-text');
  if (!dot || !text) return;
  dot.className = 'save-dot ' + state;
  text.textContent = msg || SAVE_STATE_LABELS[state];
}

// Ensure S.guests has all required locations × days × meals as numbers.
// The server's validator requires every slot; sparse state would 400 every save.
const GUEST_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function normalizeGuests(): void {
  for (const loc of ['west', 'centraal']) {
    if (!S.guests[loc]) S.guests[loc] = {};
    for (const day of GUEST_DAYS) {
      const d: Partial<GuestDay> = S.guests[loc][day] || {};
      S.guests[loc][day] = {
        lunch: typeof d.lunch === 'number' ? d.lunch : 0,
        dinner: typeof d.dinner === 'number' ? d.dinner : 0,
      };
    }
  }
}

// ── Snapshot diffing for patch saves ──
let _lastSaved: SaveSnapshot = { batches: new Map(), guests: '', caterings: new Map(), transportItems: new Map() };

export function takeSnapshot(): void {
  _lastSaved = {
    batches: new Map(S.batches.map((d: Batch) => [d.id, JSON.stringify(d)])),
    guests: JSON.stringify(S.guests),
    caterings: new Map(S.caterings.map((c: Catering) => [c.id, JSON.stringify(c)])),
    transportItems: new Map(S.transportItems.map((t: TransportItem) => [t.id, JSON.stringify(t)])),
  };
}

export function computePatch(): PatchRequest {
  const patch: Required<PatchRequest> = {
    batches: [], deletedBatches: [], guests: null,
    caterings: [], deletedCaterings: [],
    transportItems: [], deletedTransportItems: [],
  };

  // Batches
  const curBatchIds = new Set(S.batches.map((d: Batch) => d.id));
  for (const d of S.batches) {
    const prev = _lastSaved.batches.get(d.id);
    const cur = JSON.stringify(d);
    if (prev === cur) continue;                          // unchanged
    if (!prev) { patch.batches!.push(d); continue; }     // new batch — send full
    // Existing batch changed. Omit inventory[]/shipments[] when THEY are
    // unchanged, so an unrelated edit (name/note/services) can't round-trip a
    // stale stock array and revert a concurrent ship/transfer/cook (audit
    // PERF-1). The inventory editor changes them for real, so those ride along.
    const prevObj = JSON.parse(prev) as Batch;
    const toSend: Record<string, unknown> = { ...d };
    if (JSON.stringify(prevObj.inventory ?? null) === JSON.stringify(d.inventory ?? null)) delete toSend.inventory;
    if (JSON.stringify(prevObj.shipments ?? null) === JSON.stringify(d.shipments ?? null)) delete toSend.shipments;
    patch.batches!.push(toSend as unknown as Batch);
  }
  for (const [id] of _lastSaved.batches) {
    if (!curBatchIds.has(id)) patch.deletedBatches!.push(id);
  }

  // Guests (small fixed structure — send full if changed)
  // Normalize first so validation never fails due to sparse state (missing day/meal)
  normalizeGuests();
  if (JSON.stringify(S.guests) !== _lastSaved.guests) patch.guests = S.guests;

  // Caterings
  const curCatIds = new Set(S.caterings.map((c: Catering) => c.id));
  for (const c of S.caterings) {
    const prev = _lastSaved.caterings.get(c.id);
    if (!prev || prev !== JSON.stringify(c)) patch.caterings!.push(c);
  }
  for (const [id] of _lastSaved.caterings) {
    if (!curCatIds.has(id)) patch.deletedCaterings!.push(id);
  }

  // Transport items
  const curTrIds = new Set(S.transportItems.map((t: TransportItem) => t.id));
  for (const t of S.transportItems) {
    const prev = _lastSaved.transportItems.get(t.id);
    if (!prev || prev !== JSON.stringify(t)) patch.transportItems!.push(t);
  }
  for (const [id] of _lastSaved.transportItems) {
    if (!curTrIds.has(id)) patch.deletedTransportItems!.push(id);
  }

  return patch;
}

export function patchIsEmpty(p: PatchRequest): boolean {
  return (!p.batches || p.batches.length === 0) &&
         (!p.deletedBatches || p.deletedBatches.length === 0) &&
         p.guests === null &&
         (!p.caterings || p.caterings.length === 0) &&
         (!p.deletedCaterings || p.deletedCaterings.length === 0) &&
         (!p.transportItems || p.transportItems.length === 0) &&
         (!p.deletedTransportItems || p.deletedTransportItems.length === 0);
}

export function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  setSaveState('unsaved');
  // Debounce: wait 1.5s after last change before saving
  saveTimer = setTimeout(doSave, 1500);
}

export async function doSave(): Promise<void> {
  if (saveState === 'saving') return;
  const patch = computePatch();
  if (patchIsEmpty(patch)) { setSaveState('saved'); return; }
  // Snapshot exactly what is being sent — BEFORE the await — so an edit typed
  // while this save is in flight stays dirty and is sent on the next save.
  // (The old code ran takeSnapshot() AFTER the await, rebuilding the snapshot
  // from live state and silently absorbing mid-save edits.)
  // Record the FULL live batch (not the trimmed wire payload) into the save
  // snapshot. computePatch() may omit unchanged inventory[]/shipments[] from the
  // patch (PERF-1), but the server merges those from the existing DB row, so the
  // post-save state is the full local batch. Storing the trimmed payload would
  // leave a phantom diff (live batch has the field, snapshot doesn't) and the
  // save indicator would stick on "Unsaved" forever, re-sending every save
  // (regression caught by e2e/batch-assign-modal).
  const sentBatches = (patch.batches || []).map(b => {
    const full = S.batches.find((x: Batch) => x.id === b.id);
    return [b.id, JSON.stringify(full ?? b)] as const;
  });
  const sentDeletedBatches = [...(patch.deletedBatches || [])];
  const sentGuests = patch.guests ? JSON.stringify(patch.guests) : null;
  const sentCaterings = (patch.caterings || []).map(c => [c.id, JSON.stringify(c)] as const);
  const sentDeletedCaterings = [...(patch.deletedCaterings || [])];
  const sentTransport = (patch.transportItems || []).map(t => [t.id, JSON.stringify(t)] as const);
  const sentDeletedTransport = [...(patch.deletedTransportItems || [])];
  setSaveState('saving');
  try {
    const result = await apiPost('/api/data/patch', patch);
    // Apply ONLY what was sent to the save snapshot — never the live state.
    for (const [id, json] of sentBatches) _lastSaved.batches.set(id, json);
    for (const id of sentDeletedBatches) _lastSaved.batches.delete(id);
    if (sentGuests !== null) _lastSaved.guests = sentGuests;
    for (const [id, json] of sentCaterings) _lastSaved.caterings.set(id, json);
    for (const id of sentDeletedCaterings) _lastSaved.caterings.delete(id);
    for (const [id, json] of sentTransport) _lastSaved.transportItems.set(id, json);
    for (const id of sentDeletedTransport) _lastSaved.transportItems.delete(id);
    retryCount = 0;
    // If an edit landed during the in-flight save, computePatch() now still
    // sees it — keep the indicator honest instead of flashing "Saved".
    setSaveState(patchIsEmpty(computePatch()) ? 'saved' : 'unsaved');
    if (result && result.concurrent) {
      const c = result.concurrent;
      toast(`${c.recentUser} saved ${c.agoSeconds < 60 ? c.agoSeconds + 's' : Math.round(c.agoSeconds/60) + 'min'} ago — consider reloading`);
    }
  } catch (e: unknown) {
    const status = e instanceof ApiError ? e.status : 0;
    const msg = e instanceof Error ? e.message : 'Unknown error';
    console.error(`[save] failed (status ${status}):`, msg, '| patch summary:', {
      batches: patch.batches?.length || 0,
      deletedBatches: patch.deletedBatches?.length || 0,
      guests: patch.guests ? 'yes' : 'no',
      caterings: patch.caterings?.length || 0,
    });

    // Client errors (400/404/409) won't succeed on retry — surface immediately
    const isClientError = status >= 400 && status < 500;
    if (isClientError) {
      setSaveState('error', `Save failed: ${msg}`);
      toastError(`Save rejected by server: ${msg}`);
      retryCount = 0;
      return;
    }

    retryCount++;
    if (retryCount <= MAX_RETRIES) {
      setSaveState('error', `Retry ${retryCount}/${MAX_RETRIES}... (${msg})`);
      setTimeout(doSave, 2000 * retryCount);
    } else {
      setSaveState('error', `Save failed: ${msg}`);
      toastError(`Could not save changes: ${msg}`);
      retryCount = 0;
    }
  }
}

// Explicit save (for manual retry)
export function retrySave(): void {
  retryCount = 0;
  doSave();
}

export async function loadData(): Promise<void> {
  try {
    const data = await apiGet('/api/data');
    if (data.guests) S.guests = data.guests;
    if (data.recipes) S.recipes = data.recipes;
    if (data.batches) S.batches = data.batches;
    if (data.caterings) S.caterings = data.caterings;
    if (data.transportItems) S.transportItems = data.transportItems;
    if (data.supplies) S.supplies = data.supplies;
    takeSnapshot();
    rebuildPlanner();
    // Cold loaders (ingredient DB, storage config, kitchen equipment, guest
    // history, next weeks, inventory completions) are awaited from initApp()
    // so they finish BEFORE connectLiveSync(). That ordering matters: if SSE
    // connects first, an incoming patch can merge into half-loaded state and
    // get clobbered when the cold load resolves.
    hideDataError();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.warn('Could not load from server, using defaults', e);
    showDataError('Could not load data: ' + message);
  }
}

// ── Persistent error banner (stays visible until data loads) ──
export function showDataError(msg: string): void {
  let banner = document.getElementById('data-error-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'data-error-banner';
    banner.className = 'data-error-banner';
    const content = document.querySelector('.content');
    if (content) content.prepend(banner);
  }
  banner.innerHTML = `<span>${esc(msg)}</span><button onclick="retryLoad()">Retry</button>`;
  banner.style.display = '';
}

export function hideDataError(): void {
  const banner = document.getElementById('data-error-banner');
  if (banner) banner.style.display = 'none';
}

export async function retryLoad(): Promise<void> {
  const banner = document.getElementById('data-error-banner');
  if (banner) {
    const span = banner.querySelector('span');
    if (span) span.textContent = 'Retrying...';
  }
  await loadData();
  // Cold loaders moved out of loadData() into the bootstrap path; replicate
  // here so a retry after a transient error doesn't leave S.ingredientDb /
  // S.storageConfig / etc. empty until full page reload.
  await Promise.allSettled([
    loadIngredientDb(),
    loadStorageConfig(),
    loadKitchenEquipment(),
    loadCookRhythm(),
    loadClosedServices(),
    loadGuestHistory(),
    loadGuestsNextWeeks(),
    loadInventoryCompletions(),
  ]);
  rebuildPlanner();
  rerenderCurrentView();
}

export let ingredientDbLoaded = false;
export let ingredientDbError = '';
export async function loadIngredientDb(): Promise<void> {
  try {
    const result = await apiGet('/api/ingredients');
    // Handle error-as-data response
    if (result && result.error) {
      console.error('Ingredient DB API error:', result.error);
      S.ingredientDb = [];
      ingredientDbError = result.error;
    } else if (Array.isArray(result)) {
      S.ingredientDb = result;
      invalidateCategoryCache(); // invalidate choppable lookup cache
      ingredientDbError = '';
      console.log('Ingredient DB loaded:', S.ingredientDb.length, 'items');
      if (S.ingredientDb.length > 0) console.log('Sample:', S.ingredientDb[0].name, '| code:', S.ingredientDb[0].orderCode);
    } else {
      console.error('Ingredient DB unexpected response:', result);
      S.ingredientDb = [];
      ingredientDbError = 'Unexpected response format';
    }
    ingredientDbLoaded = true;
    // Notify screens that need ingredient data (e.g. Orders) so they can re-render
    // if they happened to mount before the async load completed.
    window.dispatchEvent(new CustomEvent('ingredientDbReady'));
  } catch (e: unknown) {
    console.error('Failed to load ingredient DB:', e);
    S.ingredientDb = [];
    ingredientDbLoaded = true;
    ingredientDbError = e instanceof Error ? e.message : 'Unknown error';
    window.dispatchEvent(new CustomEvent('ingredientDbReady'));
  }
}

export async function loadStorageConfig(): Promise<void> {
  try {
    const cfg = await apiGet('/api/storage-config');
    if (cfg && typeof cfg === 'object' && (cfg.west || cfg.centraal)) {
      S.storageConfig = cfg;
    } else {
      // Initialize with defaults for both locations
      S.storageConfig = { west: DEFAULT_STORAGE_CONFIG, centraal: DEFAULT_STORAGE_CONFIG.map((a: StorageArea) => ({...a})) };
    }
  } catch (_e: unknown) {
    S.storageConfig = { west: DEFAULT_STORAGE_CONFIG, centraal: DEFAULT_STORAGE_CONFIG.map((a: StorageArea) => ({...a})) };
  }
  rebuildStorageCategories(S.currentLoc || 'west');
}

export async function saveStorageConfig(): Promise<void> {
  try {
    await apiPost('/api/storage-config', S.storageConfig);
  } catch (_e: unknown) {
    toastError('Failed to save storage config');
  }
}

const DEFAULT_KITCHEN_EQUIPMENT: KitchenEquipment = {
  pots: [],
  gasBurners: 0,
  inductionBurners: 0,
  bigBurnerThreshold: 80,
};

export async function loadKitchenEquipment(): Promise<void> {
  try {
    const eq = await apiGet('/api/kitchen-equipment');
    if (eq && typeof eq === 'object' && Array.isArray(eq.pots)) {
      S.kitchenEquipment = {
        pots: eq.pots,
        gasBurners: Number(eq.gasBurners) || 0,
        inductionBurners: Number(eq.inductionBurners) || 0,
        bigBurnerThreshold: Number(eq.bigBurnerThreshold) || 80,
      };
    } else {
      S.kitchenEquipment = { ...DEFAULT_KITCHEN_EQUIPMENT };
    }
  } catch (_e: unknown) {
    S.kitchenEquipment = { ...DEFAULT_KITCHEN_EQUIPMENT };
  }
}

export async function saveKitchenEquipment(): Promise<void> {
  try {
    await apiPost('/api/kitchen-equipment', S.kitchenEquipment);
  } catch (_e: unknown) {
    toastError('Failed to save kitchen equipment');
  }
}

export async function loadCookRhythm(): Promise<void> {
  try {
    const cfg = await apiGet('/api/cook-rhythm');
    if (cfg && typeof cfg === 'object' && cfg.days && typeof cfg.days === 'object'
        && Object.keys(cfg.days).length > 0) {
      S.cookRhythm = { days: cfg.days };
    } else {
      S.cookRhythm = null; // no saved config → Fix My Menu uses DEFAULT_COOK_RHYTHM
    }
  } catch (_e: unknown) {
    S.cookRhythm = null;
  }
}

export async function saveCookRhythm(): Promise<void> {
  try {
    await apiPost('/api/cook-rhythm', S.cookRhythm);
  } catch (_e: unknown) {
    toastError('Failed to save cook rhythm');
  }
}

export async function loadCostTargets(): Promise<void> {
  try {
    const cfg = await apiGet('/api/cost-targets');
    if (cfg && typeof cfg === 'object'
        && typeof cfg.soup === 'number' && typeof cfg.main === 'number' && typeof cfg.topping === 'number') {
      S.costTargets = {
        soup: cfg.soup, main: cfg.main, topping: cfg.topping,
        foodCostPct: typeof cfg.foodCostPct === 'number' ? cfg.foodCostPct : 25,
        revenuePerGuestOverride: typeof cfg.revenuePerGuestOverride === 'number' ? cfg.revenuePerGuestOverride : null,
      };
    } else {
      S.costTargets = null; // no saved config → DEFAULT_COST_TARGETS
    }
  } catch (_e: unknown) {
    S.costTargets = null;
  }
}

export async function saveCostTargets(): Promise<void> {
  try {
    await apiPost('/api/cost-targets', S.costTargets);
  } catch (_e: unknown) {
    toastError('Failed to save cost targets');
  }
}

export async function loadRevenuePerGuest(): Promise<void> {
  try {
    const data = await apiGet('/api/finance/revenue-per-guest');
    S.revenuePerGuest = (data && typeof data.revenuePerGuest === 'number') ? data.revenuePerGuest : null;
  } catch (_e: unknown) {
    S.revenuePerGuest = null;
  }
}

export async function loadClosedServices(): Promise<void> {
  try {
    const cfg = await apiGet('/api/closed-services');
    if (cfg && typeof cfg === 'object' && cfg.recurring && typeof cfg.recurring === 'object') {
      S.closedServices = { recurring: cfg.recurring, dates: cfg.dates };
    } else {
      S.closedServices = null; // no saved config → everything open
    }
  } catch (_e: unknown) {
    S.closedServices = null;
  }
}

export async function saveClosedServices(): Promise<void> {
  try {
    await apiPost('/api/closed-services', S.closedServices);
  } catch (_e: unknown) {
    toastError('Failed to save closed services');
  }
}

// ── Drinks module loaders ──

export async function loadDrinks(): Promise<void> {
  try {
    const data = await apiGet('/api/drinks');
    if (Array.isArray(data)) S.drinks = data;
  } catch (e: unknown) {
    console.warn('Could not load drinks:', e instanceof Error ? e.message : 'Unknown error');
  }
}

export async function loadDrinkSuppliers(): Promise<void> {
  try {
    const data = await apiGet('/api/drinks/suppliers');
    if (Array.isArray(data)) S.drinkSuppliers = data;
  } catch (_e: unknown) { /* non-fatal — suppliers tab shows empty */ }
}

export async function loadDrinkConfig(): Promise<void> {
  try {
    const cfg = await apiGet('/api/drinks/config');
    if (cfg && typeof cfg === 'object') S.drinkConfig = cfg;
  } catch (_e: unknown) { S.drinkConfig = null; }
}

export async function loadGuestHistory(): Promise<void> {
  try {
    const data = await apiGet('/api/guest-history');
    S.guestHistory = data;
    if (data && (data.west || data.centraal)) {
      S.predictions = predictGuests(data);
    }
    if (data && data.flowDistribution) {
      S.guestFlowDistribution = data.flowDistribution;
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.warn('Could not load guest history:', message);
  }
}

export async function loadGuestsNextWeeks(): Promise<void> {
  try {
    const data = await apiGet('/api/guests-next-weeks');
    if (data && typeof data === 'object') S.guestsNextWeeks = data;
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.warn('Could not load next weeks data:', message);
  }
}

let _nextWeeksSaveTimer: ReturnType<typeof setTimeout> | null = null;
export function scheduleNextWeeksSave(): void {
  if (_nextWeeksSaveTimer) clearTimeout(_nextWeeksSaveTimer);
  setSaveState('unsaved');
  _nextWeeksSaveTimer = setTimeout(async () => {
    setSaveState('saving');
    try {
      await apiPost('/api/guests-next-weeks', S.guestsNextWeeks);
      setSaveState('saved', 'Saved');
    } catch (_e: unknown) {
      setSaveState('error', 'Save failed');
    }
  }, 1500);
}

// The single #toast region defaults to polite (role="status"). Toggle it to
// assertive (role="alert") for errors so a screen reader interrupts to announce
// a save/transport failure (audit UIUX-7), and back to polite for plain toasts.
function setToastPoliteness(assertive: boolean): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.setAttribute('role', assertive ? 'alert' : 'status');
  t.setAttribute('aria-live', assertive ? 'assertive' : 'polite');
}

export function toast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  setToastPoliteness(false);
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => t.className = 'toast', 2200);
}

export function toastError(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  setToastPoliteness(true);
  t.textContent = msg;
  t.className = 'toast error show';
  setTimeout(() => t.className = 'toast', 4000);
}

export function showUndoToast(msg: string, onUndo: () => void): void {
  const t = document.getElementById('toast');
  if (!t) return;
  setToastPoliteness(false);
  t.innerHTML = `<span>${msg}</span><button class="toast-undo-btn" type="button">Undo</button>`;
  t.querySelector('.toast-undo-btn')!.addEventListener('click', onUndo);
  t.className = 'toast undo show';
}

export function hideToast(): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.className = 'toast';
  t.innerHTML = '';
}

export function cancelPendingSave(): void {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
}

// ═══════════════════════════════════════════════════════════════════
// LIVE SYNC (Server-Sent Events)
// ═══════════════════════════════════════════════════════════════════

let _eventSource: EventSource | null = null;
let _lastEventAt = 0;
let _healthInterval: ReturnType<typeof setInterval> | null = null;
let _visibilityHandlerInstalled = false;

// Force reconnect: tear down the existing EventSource and re-open. After a
// disconnect we may have missed patches, so resync core data + cold loaders.
// Toast is suppressed since this is recovery, not a remote edit.
async function reconnectLiveSync(reason: string): Promise<void> {
  console.warn('Live sync: forcing reconnect —', reason);
  if (_eventSource) {
    try { _eventSource.close(); } catch (_e) { /* ignore */ }
    _eventSource = null;
  }
  // Flush pending local writes BEFORE pulling fresh server state. Otherwise
  // loadData() overwrites S with the server snapshot and takeSnapshot() makes
  // those values the new baseline — any unsaved local edits typed during the
  // disconnect would be silently dropped on the next computePatch().
  // Cancel the debounce and run doSave synchronously; if it fails (server
  // still unreachable), we proceed with the resync anyway.
  cancelPendingSave();
  if (_flushUndo) _flushUndo();
  try {
    await doSave();
  } catch (_e: unknown) { /* save failed — best-effort, continue resync */ }
  // Resync core + cold-load data we may have missed.
  try {
    await loadData();
    await Promise.allSettled([
      loadIngredientDb(),
      loadStorageConfig(),
      loadKitchenEquipment(),
      loadCookRhythm(),
      loadClosedServices(),
      loadGuestHistory(),
      loadGuestsNextWeeks(),
      loadInventoryCompletions(),
      loadRitualCompletions(),
    ]);
    rebuildPlanner();
    rerenderCurrentView();
  } catch (e: unknown) {
    console.warn('Live sync: resync failed', e);
  }
  connectLiveSync();
}

export function connectLiveSync(): void {
  if (_eventSource) return; // already connected
  _eventSource = new EventSource('/api/events');
  _lastEventAt = Date.now();

  _eventSource.onmessage = (event: MessageEvent) => {
    _lastEventAt = Date.now();
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'connected') {
        console.log('Live sync connected (client', msg.clientId + ')');
        return;
      }
      if (msg.type === 'permissions-changed') {
        // A director changed this user's role (or their role's matrix). Reload
        // to pick up fresh permissions — simplest correct refresh, and access
        // changes are rare. Autosave (1.5s debounce) has flushed by the reload.
        toast('Your access was updated — refreshing…');
        setTimeout(() => location.reload(), 1500);
        return;
      }
      if (msg.type === 'patch') {
        applyRemotePatch(msg);
      }
    } catch (_e: unknown) {
      console.warn('Live sync: bad message', _e);
    }
  };

  _eventSource.onerror = () => {
    // EventSource auto-reconnects on transient failure; we just log here.
    // The health interval will force a reconnect if no events for >90s.
    console.warn('Live sync: connection error');
  };

  // Health check: server keepalives every 30s ([routes/events.ts:30]). If we
  // haven't seen any traffic in 90s (3× keepalive), the connection is wedged.
  if (_healthInterval) clearInterval(_healthInterval);
  _healthInterval = setInterval(() => {
    if (!_eventSource) return;
    if (Date.now() - _lastEventAt > 90000) {
      reconnectLiveSync('no events for >90s');
    }
  }, 60000);

  // visibilitychange handler: when a tab is foregrounded after being hidden
  // long enough that we missed at least one keepalive, force reconnect.
  if (!_visibilityHandlerInstalled) {
    _visibilityHandlerInstalled = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - _lastEventAt > 30000) {
        reconnectLiveSync('tab restored after >30s');
      }
    });
  }
}

export function disconnectLiveSync(): void {
  if (_healthInterval) { clearInterval(_healthInterval); _healthInterval = null; }
  if (_eventSource) {
    _eventSource.close();
    _eventSource = null;
  }
}

// Remote patch message shape (from SSE)
interface RemotePatchMessage {
  user?: string;
  // Schema-version envelope (audit S4 deploy-window safety net). Server emits
  // BATCH_SCHEMA_VERSION on every patch via routes/events.ts:broadcast(); a
  // mismatched version triggers a force-reload in applyRemotePatch so a
  // stale browser tab doesn't silently merge new-shape data into old-shape
  // local state. Optional because old backends won't emit it during the
  // partial-deploy window — undefined === "compatible, don't reload".
  schemaVersion?: number;
  // Existing — handled by computePatch() snapshot diff
  batches?: Batch[];
  deletedBatches?: string[];
  guests?: GuestsData;
  caterings?: Catering[];
  deletedCaterings?: string[];
  transportItems?: TransportItem[];
  deletedTransportItems?: string[];
  // Item-delta resources (per-resource save endpoints; not in computePatch)
  recipes?: RecipeFull[];
  deletedRecipes?: string[];
  ingredients?: Ingredient[];
  deletedIngredients?: string[];
  supplies?: Supply[];
  deletedSupplies?: string[];
  // Drinks module item-deltas + config full-replace
  drinks?: Drink[];
  deletedDrinks?: string[];
  drinkSuppliers?: DrinkSupplier[];
  deletedDrinkSuppliers?: string[];
  drinkConfig?: DrinkConfig;
  // Full-replace resources
  storageConfig?: StorageConfig;
  kitchenEquipment?: KitchenEquipment;
  cookRhythm?: CookRhythmConfig;
  costTargets?: CostTargets;
  closedServices?: ClosedServicesConfig;
  // Partial slot-keyed
  prepChecklist?: { loc: string; date: string; checked: string[] };
  inventoryCompletion?: { loc: string; window: 'lunch' | 'dinner'; completedAt: string };
  ritualCompletion?: { loc: string; date: string; completed: string[] };
  // Partial week-keyed (subset of S.guestsNextWeeks)
  guestsNextWeeks?: Record<string, Record<string, Record<string, Record<string, number>>>>;
  // Reload triggers — too expensive to ship through SSE
  ingredientsBulkReload?: true;
  guestHistoryReload?: true;
  recipesReload?: true;
}

// Merge a patch from another user into local state
export function applyRemotePatch(msg: RemotePatchMessage): void {
  // Schema-version safety net (audit S4). A stale browser tab open during a
  // deploy would otherwise silently merge new-shape data into old-shape
  // local state and produce zombie fields. Force-reload on mismatch so the
  // tab picks up the fresh bundle.
  //
  // Defensive: undefined version === "old backend that doesn't emit version
  // yet". Treat as compatible during the partial-deploy window so we don't
  // force-reload everyone for a transient old-server response.
  if (msg.schemaVersion !== undefined && msg.schemaVersion !== BATCH_SCHEMA_VERSION) {
    toast('App updated. Reloading...');
    // Belt-and-braces: clear both the in-memory snapshot AND the localStorage
    // key (no-op if it doesn't exist) so a stale-data resave doesn't fire as
    // the page reloads. The reload itself blows the JS heap so the in-memory
    // nuke is mostly cosmetic, but cheap.
    _lastSaved = { batches: new Map(), guests: '', caterings: new Map(), transportItems: new Map() };
    try { localStorage.removeItem('lastSaved'); } catch (_e) { /* noop */ }
    setTimeout(() => window.location.reload(), 400);
    return;
  }

  if (_flushUndo) _flushUndo();
  const { user, batches, deletedBatches, guests,
          caterings, deletedCaterings,
          transportItems, deletedTransportItems,
          recipes, deletedRecipes,
          ingredients, deletedIngredients,
          supplies, deletedSupplies,
          drinks, deletedDrinks, drinkSuppliers, deletedDrinkSuppliers, drinkConfig,
          storageConfig, kitchenEquipment, cookRhythm, costTargets, closedServices,
          prepChecklist, inventoryCompletion, ritualCompletion,
          guestsNextWeeks,
          ingredientsBulkReload, guestHistoryReload, recipesReload } = msg;

  let changed = false;

  // Merge batches
  if ((batches && batches.length) || (deletedBatches && deletedBatches.length)) {
    const batchMap = new Map(S.batches.map((b: Batch) => [b.id, b]));
    if (deletedBatches) deletedBatches.forEach((id: string) => batchMap.delete(id));
    // Field-merge so a patch that omits unchanged inventory[]/shipments[]
    // (audit PERF-1) doesn't strip them from our local copy.
    if (batches) batches.forEach((b: Batch) => {
      const existing = batchMap.get(b.id);
      batchMap.set(b.id, existing ? { ...existing, ...b } : b);
    });
    S.batches = [...batchMap.values()];
    // Reset batch ingredient toggles so they re-read from updated orderFor
    if (_onBatchesChanged) _onBatchesChanged();
    changed = true;
  }

  // Merge guests
  if (guests) {
    for (const loc of ['west', 'centraal']) {
      if (!guests[loc]) continue;
      if (!S.guests[loc]) S.guests[loc] = {};
      for (const day of Object.keys(guests[loc])) {
        S.guests[loc][day] = guests[loc][day];
      }
    }
    changed = true;
  }

  // Merge caterings
  if ((caterings && caterings.length) || (deletedCaterings && deletedCaterings.length)) {
    const catMap = new Map(S.caterings.map((c: Catering) => [c.id, c]));
    if (deletedCaterings) deletedCaterings.forEach((id: string) => catMap.delete(id));
    if (caterings) caterings.forEach((c: Catering) => catMap.set(c.id, c));
    S.caterings = [...catMap.values()];
    changed = true;
  }

  // Merge transport items
  if ((transportItems && transportItems.length) || (deletedTransportItems && deletedTransportItems.length)) {
    const trMap = new Map(S.transportItems.map((t: TransportItem) => [t.id, t]));
    if (deletedTransportItems) deletedTransportItems.forEach((id: string) => trMap.delete(id));
    if (transportItems) transportItems.forEach((t: TransportItem) => trMap.set(t.id, t));
    S.transportItems = [...trMap.values()];
    changed = true;
  }

  // Merge recipes (item-delta by id)
  if ((recipes && recipes.length) || (deletedRecipes && deletedRecipes.length)) {
    const recipeMap = new Map(S.recipes.map((r: RecipeFull) => [r.id, r]));
    if (deletedRecipes) deletedRecipes.forEach((id: string) => recipeMap.delete(id));
    if (recipes) recipes.forEach((r: RecipeFull) => recipeMap.set(r.id, r));
    S.recipes = [...recipeMap.values()];
    changed = true;
  }

  // Merge ingredients (item-delta by id). When the rich shape is loaded,
  // do a per-row field merge so wire-shape-only fields don't strip
  // priceHistory/nutrition/pricePer100g from the existing rich row.
  if ((ingredients && ingredients.length) || (deletedIngredients && deletedIngredients.length)) {
    const ingMap = new Map(S.ingredientDb.map((i: Ingredient) => [i.id, i]));
    if (deletedIngredients) deletedIngredients.forEach((id: string) => ingMap.delete(id));
    if (ingredients) {
      ingredients.forEach((i: Ingredient) => {
        const existing = ingMap.get(i.id);
        if (existing && S.ingredientDbFullyLoaded) {
          ingMap.set(i.id, { ...existing, ...i });
        } else {
          ingMap.set(i.id, i);
        }
      });
    }
    S.ingredientDb = [...ingMap.values()];
    invalidateCategoryCache();
    window.dispatchEvent(new CustomEvent('ingredientDbReady'));
    changed = true;
  }

  // Merge supplies (item-delta by id) — toppings/bread CRUD + prep/stock events
  if ((supplies && supplies.length) || (deletedSupplies && deletedSupplies.length)) {
    const supplyMap = new Map((S.supplies || []).map((s: Supply) => [s.id, s]));
    if (deletedSupplies) deletedSupplies.forEach((id: string) => supplyMap.delete(id));
    if (supplies) supplies.forEach((s: Supply) => supplyMap.set(s.id, s));
    S.supplies = [...supplyMap.values()];
    changed = true;
  }

  // Merge drinks (item-delta by id)
  if ((drinks && drinks.length) || (deletedDrinks && deletedDrinks.length)) {
    const drinkMap = new Map((S.drinks || []).map((d: Drink) => [d.id, d]));
    if (deletedDrinks) deletedDrinks.forEach((id: string) => drinkMap.delete(id));
    if (drinks) drinks.forEach((d: Drink) => drinkMap.set(d.id, d));
    S.drinks = [...drinkMap.values()];
    changed = true;
  }

  // Merge drink suppliers (item-delta by id)
  if ((drinkSuppliers && drinkSuppliers.length) || (deletedDrinkSuppliers && deletedDrinkSuppliers.length)) {
    const supMap = new Map((S.drinkSuppliers || []).map((s: DrinkSupplier) => [s.id, s]));
    if (deletedDrinkSuppliers) deletedDrinkSuppliers.forEach((id: string) => supMap.delete(id));
    if (drinkSuppliers) drinkSuppliers.forEach((s: DrinkSupplier) => supMap.set(s.id, s));
    S.drinkSuppliers = [...supMap.values()];
    changed = true;
  }

  // Drink config (full-replace)
  if (drinkConfig) {
    S.drinkConfig = drinkConfig;
    changed = true;
  }

  // Storage config (full-replace)
  if (storageConfig) {
    S.storageConfig = storageConfig;
    rebuildStorageCategories(S.currentLoc || 'west');
    changed = true;
  }

  // Kitchen equipment (full-replace)
  if (kitchenEquipment) {
    S.kitchenEquipment = kitchenEquipment;
    changed = true;
  }

  // Cook rhythm (full-replace) — editable Fix My Menu rules
  if (cookRhythm) {
    S.cookRhythm = cookRhythm;
    changed = true;
  }

  // Cost targets (full-replace) — West-tab cost-per-guest steering
  if (costTargets) {
    S.costTargets = costTargets;
    changed = true;
  }

  // Closed services (full-replace). Unlike cook-rhythm this feeds the demand
  // allocation cache, so it must trigger a rebuildPlanner — wired via needsPlanner below.
  if (closedServices) {
    S.closedServices = closedServices;
    changed = true;
  }

  // Prep checklist (only apply if the patch is for today's date)
  if (prepChecklist && prepChecklist.date === todayIso()) {
    S.prepChecklist[prepChecklist.loc] = new Set(prepChecklist.checked);
    changed = true;
  }

  // Inventory completion timestamp
  if (inventoryCompletion) {
    const { loc, window: win, completedAt } = inventoryCompletion;
    if (!S.inventoryCompletions[loc as Location]) {
      S.inventoryCompletions[loc as Location] = { lunch: null, dinner: null };
    }
    S.inventoryCompletions[loc as Location][win] = completedAt;
    changed = true;
  }

  // Ritual completions (only apply if the patch is for today's date)
  if (ritualCompletion && ritualCompletion.date === todayIso()) {
    S.ritualCompletions[ritualCompletion.loc] = new Set(ritualCompletion.completed);
    changed = true;
  }

  // Guests next weeks (merge by mondayKey)
  if (guestsNextWeeks) {
    for (const mondayKey of Object.keys(guestsNextWeeks)) {
      S.guestsNextWeeks[mondayKey] = guestsNextWeeks[mondayKey];
    }
    changed = true;
  }

  // Reload triggers — fire-and-forget, but mark changed so toast still shows.
  // Serialize ingredient-bulk + recipe reload to avoid clobber.
  if (ingredientsBulkReload) {
    // If the user already has the rich shape (Ingredient DB editor), re-fetch
    // the rich shape so priceHistory/nutrition/pricePer100g don't get stripped
    // by the slim /api/ingredients projection.
    const reloadIngs = (S.ingredientDbFullyLoaded && _loadIngredientDbFull)
      ? _loadIngredientDbFull()
      : loadIngredientDb();
    if (recipesReload) {
      reloadIngs.then(() => apiGet('/api/recipes')).then((r: RecipeFull[]) => {
        if (Array.isArray(r)) S.recipes = r;
        rebuildPlanner();
        rerenderCurrentView();
      }).catch(() => { /* logged inside loaders */ });
    }
    changed = true;
  } else if (recipesReload) {
    apiGet('/api/recipes').then((r: RecipeFull[]) => {
      if (Array.isArray(r)) S.recipes = r;
      rebuildPlanner();
      rerenderCurrentView();
    }).catch(() => { /* ignored */ });
    changed = true;
  }
  if (guestHistoryReload) {
    loadGuestHistory();
    changed = true;
  }

  if (changed) {
    // Only update the snapshot for items that came FROM the remote patch.
    // A full takeSnapshot() would absorb unsaved local changes into the snapshot,
    // causing computePatch() to miss them and silently drop them.
    updateSnapshotForRemote(msg);
    // Skip rebuildPlanner for changes that don't affect the planner data structure
    // (storage config, kitchen equipment, prep checklist, inventory completion).
    const needsPlanner = !!(batches || deletedBatches || guests
      || caterings || deletedCaterings
      || recipes || deletedRecipes
      || ingredients || deletedIngredients
      || guestsNextWeeks
      || closedServices);
    if (needsPlanner) rebuildPlanner();
    rerenderCurrentView();
    // Rebuild an open inventory modal so its embedded row indices stay valid.
    if (_onRemotePatchApplied) _onRemotePatchApplied();
    toast(`${user || 'Someone'} made changes — updated live`);
  }
}

// Update snapshot only for items received from a remote patch.
// Preserves local diffs so pending saves still detect unsaved changes.
function updateSnapshotForRemote(msg: RemotePatchMessage): void {
  if (msg.batches) {
    // Store the MERGED batch (from S.batches after the field-merge in
    // applyRemotePatch), not the raw remote payload. A remote patch may omit
    // unchanged inventory[]/shipments[] (PERF-1); storing the trimmed payload
    // here would leave a phantom diff vs the merged local batch and peg the
    // receiving client on "Unsaved", re-sending the batch on its next save.
    for (const b of msg.batches) {
      const merged = S.batches.find((x: Batch) => x.id === b.id);
      _lastSaved.batches.set(b.id, JSON.stringify(merged ?? b));
    }
  }
  if (msg.deletedBatches) {
    for (const id of msg.deletedBatches) {
      _lastSaved.batches.delete(id);
    }
  }
  if (msg.guests) {
    const snapshotGuests = JSON.parse(_lastSaved.guests);
    for (const loc of ['west', 'centraal']) {
      if (!msg.guests[loc]) continue;
      if (!snapshotGuests[loc]) snapshotGuests[loc] = {};
      for (const day of Object.keys(msg.guests[loc])) {
        snapshotGuests[loc][day] = msg.guests[loc][day];
      }
    }
    _lastSaved.guests = JSON.stringify(snapshotGuests);
  }
  if (msg.caterings) {
    for (const c of msg.caterings) {
      _lastSaved.caterings.set(c.id, JSON.stringify(c));
    }
  }
  if (msg.deletedCaterings) {
    for (const id of msg.deletedCaterings) {
      _lastSaved.caterings.delete(id);
    }
  }
  if (msg.transportItems) {
    for (const t of msg.transportItems) {
      _lastSaved.transportItems.set(t.id, JSON.stringify(t));
    }
  }
  if (msg.deletedTransportItems) {
    for (const id of msg.deletedTransportItems) {
      _lastSaved.transportItems.delete(id);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// PREP CHECKLIST API
// ═══════════════════════════════════════════════════════════════════

// todayIso: see @shared/dates. Local Y-M-D — never UTC.
// `import` + `export` (not pure re-export) so the name is in local scope;
// loadPrepChecklist below calls `todayIso()`.
import { todayIso } from '@shared/dates';
export { todayIso };

export async function loadInventoryCompletions(): Promise<void> {
  try {
    const data = await apiGet('/api/inventory-completions/latest');
    if (data && typeof data === 'object') {
      for (const loc of ['west', 'centraal'] as const) {
        const slot = data[loc] || {};
        S.inventoryCompletions[loc] = {
          lunch: typeof slot.lunch === 'string' ? slot.lunch : null,
          dinner: typeof slot.dinner === 'string' ? slot.dinner : null,
        };
      }
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Unknown error';
    console.warn('Could not load inventory completions:', message);
  }
}

/** Render an ISO timestamp as a short "X ago" relative string. Returns
 *  '—' when the timestamp is null/invalid. Intended for soft freshness
 *  hints; the dashboard re-renders this on a 60s tick so the value stays
 *  current without polling the server. */
export function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (isNaN(t)) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export async function loadPrepChecklist(loc: string): Promise<void> {
  try {
    const data = await apiGet(`/api/prep-checklist?loc=${loc}&date=${todayIso()}`);
    S.prepChecklist[loc] = new Set(Array.isArray(data) ? data : []);
  } catch (_e: unknown) {
    S.prepChecklist[loc] = new Set();
  }
}

let _prepSaveTimer: ReturnType<typeof setTimeout> | null = null;
export function schedulePrepSave(loc: string): void {
  if (_prepSaveTimer) clearTimeout(_prepSaveTimer);
  _prepSaveTimer = setTimeout(async () => {
    try {
      await apiPost('/api/prep-checklist', {
        loc,
        date: todayIso(),
        checked: [...(S.prepChecklist[loc] || new Set())],
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.warn('Could not save prep checklist:', message);
    }
  }, 600);
}

// ═══════════════════════════════════════════════════════════════════
// RITUAL COMPLETIONS API
// ═══════════════════════════════════════════════════════════════════
//
// Backs the dashboard "Today" guidance panel. Mirrors the prep-checklist API
// above: a per-(loc, date) set of completed step keys, persisted server-side
// and live-synced over SSE. Loaded for BOTH locations at boot (not just the
// current one) so markRitualStep never overwrites the other location's row
// with an empty set when a step is marked for a location that wasn't loaded.

/** Hydrate S.ritualCompletions for both locations from today's rows. */
export async function loadRitualCompletions(): Promise<void> {
  const date = todayIso();
  await Promise.all((['west', 'centraal'] as const).map(async (loc) => {
    try {
      const data = await apiGet(`/api/ritual-completions?loc=${loc}&date=${date}`);
      S.ritualCompletions[loc] = new Set(Array.isArray(data) ? data : []);
    } catch (_e: unknown) {
      S.ritualCompletions[loc] = new Set();
    }
  }));
}

/** True iff ritual `step` is marked done for `loc` today. */
export function isRitualStepDone(loc: string, step: string): boolean {
  return !!S.ritualCompletions[loc]?.has(step);
}

/** Mark (done=true) or clear (done=false) a ritual step for `loc` today, then
 *  schedule a debounced save. No-op if already in the desired state. The set
 *  is created lazily, so this is safe to call for any location from anywhere
 *  (e.g. Fix My Menu marking a West step while the user is elsewhere). */
export function markRitualStep(loc: string, step: string, done = true): void {
  let set = S.ritualCompletions[loc];
  if (!set) { set = new Set(); S.ritualCompletions[loc] = set; }
  if (done) {
    if (set.has(step)) return;
    set.add(step);
  } else {
    if (!set.has(step)) return;
    set.delete(step);
  }
  scheduleRitualSave(loc);
}

// Per-location debounce timers so a mark for one location never clobbers a
// pending save for the other.
const _ritualSaveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
export function scheduleRitualSave(loc: string): void {
  if (_ritualSaveTimers[loc]) clearTimeout(_ritualSaveTimers[loc]);
  _ritualSaveTimers[loc] = setTimeout(async () => {
    try {
      await apiPost('/api/ritual-completions', {
        loc,
        date: todayIso(),
        completed: [...(S.ritualCompletions[loc] || new Set())],
      });
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : 'Unknown error';
      console.warn('Could not save ritual completions:', message);
    }
  }, 600);
}

// ═══════════════════════════════════════════════════════════════════
