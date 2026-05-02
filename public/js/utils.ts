// UUID GENERATION
// ═══════════════════════════════════════════════════════════════════

import { S, DEFAULT_STORAGE_CONFIG, rebuildStorageCategories } from './state';
import type { StorageArea, Batch, Catering, TransportItem, GuestsData, PatchRequest, SaveSnapshot, SaveState, Location, KitchenEquipment } from '@shared/types';
import { doLogout } from './auth';
import { rebuildPlanner } from './core';
import { predictGuests } from './predictions';
import { esc } from './modal';
import { rerenderCurrentView } from './navigate';
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

export async function apiPost(path: string, body: unknown, method: string = 'POST'): Promise<any> {
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
      const d = S.guests[loc][day] || {};
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
    if (!prev || prev !== JSON.stringify(d)) patch.batches!.push(d);
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
    if (data.recipeIndex) S.recipeIndex = data.recipeIndex;
    if (data.recipes) S.recipes = data.recipes;
    if (data.batches) S.batches = data.batches;
    if (data.caterings) S.caterings = data.caterings;
    if (data.transportItems) S.transportItems = data.transportItems;
    takeSnapshot();
    rebuildPlanner();
    // Load ingredient DB + storage config in background (for order overview)
    loadIngredientDb();
    loadStorageConfig();
    loadKitchenEquipment();
    // Load guest history + next weeks in background (for Guests tab)
    loadGuestHistory();
    loadGuestsNextWeeks();
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

export function toast(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show';
  setTimeout(() => t.className = 'toast', 2200);
}

export function toastError(msg: string): void {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast error show';
  setTimeout(() => t.className = 'toast', 4000);
}

export function showUndoToast(msg: string, onUndo: () => void): void {
  const t = document.getElementById('toast');
  if (!t) return;
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

export function connectLiveSync(): void {
  if (_eventSource) return; // already connected
  _eventSource = new EventSource('/api/events');

  _eventSource.onmessage = (event: MessageEvent) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'connected') {
        console.log('Live sync connected (client', msg.clientId + ')');
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
    // EventSource auto-reconnects — just log it
    console.warn('Live sync: connection lost, reconnecting...');
  };
}

export function disconnectLiveSync(): void {
  if (_eventSource) {
    _eventSource.close();
    _eventSource = null;
  }
}

// Remote patch message shape (from SSE)
interface RemotePatchMessage {
  user?: string;
  batches?: Batch[];
  deletedBatches?: string[];
  guests?: GuestsData;
  caterings?: Catering[];
  deletedCaterings?: string[];
  transportItems?: TransportItem[];
  deletedTransportItems?: string[];
}

// Merge a patch from another user into local state
export function applyRemotePatch(msg: RemotePatchMessage): void {
  if (_flushUndo) _flushUndo();
  const { user, batches, deletedBatches, guests,
          caterings, deletedCaterings,
          transportItems, deletedTransportItems } = msg;

  let changed = false;

  // Merge batches
  if ((batches && batches.length) || (deletedBatches && deletedBatches.length)) {
    const batchMap = new Map(S.batches.map((b: Batch) => [b.id, b]));
    if (deletedBatches) deletedBatches.forEach((id: string) => batchMap.delete(id));
    if (batches) batches.forEach((b: Batch) => batchMap.set(b.id, b));
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

  if (changed) {
    // Only update the snapshot for items that came FROM the remote patch.
    // A full takeSnapshot() would absorb unsaved local changes into the snapshot,
    // causing computePatch() to miss them and silently drop them.
    updateSnapshotForRemote(msg);
    // Re-render current view
    rebuildPlanner();
    rerenderCurrentView();
    toast(`${user || 'Someone'} made changes — updated live`);
  }
}

// Update snapshot only for items received from a remote patch.
// Preserves local diffs so pending saves still detect unsaved changes.
function updateSnapshotForRemote(msg: RemotePatchMessage): void {
  if (msg.batches) {
    for (const b of msg.batches) {
      _lastSaved.batches.set(b.id, JSON.stringify(b));
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
