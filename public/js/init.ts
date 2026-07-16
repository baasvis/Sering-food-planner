import { S, NAV_SCREENS, setGlobalLocation, rebuildStorageCategories, restoreGlobalLocation, screenPermission, allActiveLocations, isEventLoc } from './state';
import { locName, isPermanentLocation } from '@shared/location';
import type { Location } from '@shared/types';
import { loadData, connectLiveSync, saveState, toast, setOnRegistryChanged,
         loadIngredientDb, loadStorageConfig, loadKitchenEquipment, loadCookRhythm, loadCostTargets, loadRevenuePerGuest, loadClosedServices,
         loadGuestHistory, loadGuestsNextWeeks, loadInventoryCompletions,
         loadRitualCompletions, loadDrinks, loadDrinkSuppliers, loadDrinkConfig } from './utils';
import { flushUndo } from './undo';
import { rebuildPlanner } from './core';
import { renderDashboard, showScreen, getScreenFromHash } from './dashboard';
import { checkSession, initGoogleSignIn } from './auth';
import { closeModal, showModal, esc } from './modal';
import { rerenderCurrentView } from './navigate';
import { checkInventoryReminder } from './planner';
import { checkPendingFmmSnapshots } from './fmm-snapshot';

// Re-export modal functions so existing imports from init.ts keep working
export { showModal, closeModal, esc } from './modal';

// ── THEME ─────────────────────────────────────────────────
// Apply saved theme immediately to prevent flash
if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

export function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.innerHTML = isDark ? '&#9788;' : '&#9790;';
}

// ── GLOBAL LOCATION SWITCH ───────────────────────────────
/** Inner HTML of the switcher pill: coloured dot + "Sering <Loc>" + swap hint.
 *  Event locations show their registry name (no "Sering" prefix). */
function locTitleHtml(loc: Location): string {
  if (isPermanentLocation(loc)) {
    const name = loc === 'west' ? 'West' : 'Centraal';
    return `<span class="app-title-dot"></span>Sering <span class="app-title-loc">${name}</span><span class="app-title-swap" aria-hidden="true">⇄</span>`;
  }
  return `<span class="app-title-dot"></span><span class="app-title-loc">${esc(locName(loc))}</span><span class="app-title-swap" aria-hidden="true">⇄</span>`;
}

/** CSS class for the active location: permanent keys keep their own accent,
 *  every event location shares the generic loc-event accent. */
export function locThemeClass(loc: Location | string): string {
  return loc === 'west' ? 'loc-west' : loc === 'centraal' ? 'loc-centraal' : 'loc-event';
}

/** Mirror the active location onto <body> so the accent colour (--loc-accent)
 *  cascades to the top bar, bottom nav and anything else outside the title. */
export function applyLocationTheme(loc: Location): void {
  document.body.classList.toggle('loc-west', loc === 'west');
  document.body.classList.toggle('loc-centraal', loc === 'centraal');
  document.body.classList.toggle('loc-event', isEventLoc(loc));
}

/** Step 1: clicking the switcher asks for confirmation — switching changes the
 *  whole app's location context, so it shouldn't happen on an accidental tap.
 *  With only the two permanent locations the classic ⇄ confirm stays; with an
 *  active event location there is no "the other", so a picker opens instead. */
export function confirmSwitchLocation() {
  const locs = allActiveLocations();
  if (locs.length <= 2) {
    const target: Location = S.currentLoc === 'west' ? 'centraal' : 'west';
    const targetName = target === 'west' ? 'West' : 'Centraal';
    const currentName = S.currentLoc === 'west' ? 'West' : 'Centraal';
    showModal(`
      <div class="loc-switch-modal loc-${target}">
        <h3>Switch location?</h3>
        <p class="modal-note">You're currently working in <strong>Sering ${currentName}</strong>.</p>
        <p style="margin-top:8px;">Switch the whole app to <strong class="loc-switch-target">Sering ${targetName}</strong>?</p>
        <div class="modal-actions">
          <button class="btn" onclick="closeModal()">Cancel</button>
          <button class="btn loc-switch-confirm" onclick="switchGlobalLocation('${target}')">Switch to Sering ${targetName}</button>
        </div>
      </div>
    `);
    return;
  }
  const btns = locs.map(l => {
    const here = l === S.currentLoc;
    return `<button class="btn loc-switch-confirm loc-pick-btn ${locThemeClass(l)}" data-testid="loc-pick-${esc(l)}" ${here ? 'disabled' : ''} onclick="switchGlobalLocation('${esc(l)}')">${esc(locName(l))}${here ? ' — you are here' : ''}</button>`;
  }).join('');
  showModal(`
    <div class="loc-switch-modal">
      <h3>Switch location?</h3>
      <p class="modal-note">You're currently working in <strong>${esc(locName(S.currentLoc))}</strong>. Pick where you're working:</p>
      <div class="loc-pick-list" style="display:flex;flex-direction:column;gap:8px;margin:12px 0;">${btns}</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">Cancel</button>
      </div>
    </div>
  `);
}

/** Step 2: actually flip the location (called from the confirm button, which
 *  passes the exact target it displayed so the two can't drift). Falls back to
 *  toggling the current location if called without a valid target. */
export function switchGlobalLocation(target?: Location) {
  if (target && !allActiveLocations().includes(target)) {
    // The picked location vanished under us (archived via SSE while the
    // picker modal was open). Falling back to the binary toggle here would
    // silently send the user to the WRONG restaurant — stay put and say so.
    closeModal();
    toast(`${locName(target)} is no longer active`);
    return;
  }
  const newLoc: Location = target ?? (S.currentLoc === 'west' ? 'centraal' : 'west');
  setGlobalLocation(newLoc);
  applyLocationTheme(newLoc);

  // Update the switcher pill
  const title = document.getElementById('app-title');
  if (title) {
    title.className = 'app-title ' + locThemeClass(newLoc);
    title.innerHTML = locTitleHtml(newLoc);
  }

  // Sync finance filter to new location
  S.financeProductLoc = newLoc;

  // Rebuild storage categories for new location
  rebuildStorageCategories(newLoc);

  // Close the confirm modal and re-render the active screen
  closeModal();
  rerenderCurrentView();
}

// ── NAV GENERATION ────────────────────────────────────────
// Builds top bar, bottom nav, and screen containers from NAV_SCREENS
export function buildNav() {
  const topBar = document.getElementById('top-bar')!;
  const content = document.getElementById('content')!;
  const bottomNav = document.getElementById('bottom-nav')!;

  // Director-only screens (e.g. Team / access requests) are hidden from
  // everyone else — both the nav buttons and the screen container. The
  // matching API endpoints are director-gated server-side too (defence in
  // depth), so this is purely UX, not the security boundary.
  const screens = NAV_SCREENS.filter((s: any) => (!s.directorOnly || S.user?.isDirector) && screenPermission(s.id) !== 'hidden');

  // Top bar: title + nav buttons + save indicator + user menu
  topBar.innerHTML = `
    <h1 class="app-title ${locThemeClass(S.currentLoc)}" id="app-title" onclick="confirmSwitchLocation()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();confirmSwitchLocation();}" title="Switch location" role="button" tabindex="0">${locTitleHtml(S.currentLoc)}</h1>
    ${screens.map((s: any, i: any) =>
      `<button class="nav-btn${i === 0 ? ' active' : ''}" data-screen="${s.id}" onclick="showScreen('${s.id}')">${s.topLabel}</button>`
    ).join('')}
    <div class="save-indicator" id="save-indicator" role="status" aria-live="polite">
      <div class="save-dot saved" id="save-dot"></div>
      <span id="save-text">Saved</span>
    </div>
    <div class="user-menu" id="user-menu">
      <img id="user-avatar" src="" alt="" style="display:none;">
      <span id="user-name"></span>
      <button class="theme-toggle" onclick="toggleTheme()" title="Toggle dark mode">${document.documentElement.classList.contains('dark') ? '&#9788;' : '&#9790;'}</button>
      <button onclick="doLogout()">Logout</button>
    </div>
  `;

  // Screen containers
  content.innerHTML = screens.map((s: any, i: any) =>
    `<div id="screen-${s.id}" class="screen${i === 0 ? ' active' : ''}"></div>`
  ).join('');

  // Bottom nav
  bottomNav.innerHTML = screens.map((s: any, i: any) =>
    `<button class="bnav-btn${i === 0 ? ' active' : ''}" data-screen="${s.id}" onclick="showScreen('${s.id}')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${s.icon}</svg>
      <span>${s.bottomLabel}</span>
    </button>`
  ).join('');

  // Mirror the active location onto <body> for the accent-colour cascade
  applyLocationTheme(S.currentLoc);
}

// ── GLOBAL KEY HANDLERS ──────────────────────────────────
document.addEventListener('keydown', function(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // Close modal if open
    const modal = document.querySelector('.modal-bg');
    if (modal) closeModal();
  }
});

// ── NUMBER INPUT UX ──────────────────────────────────────
// Prevent scroll wheel from changing number input values (confusing for users)
document.addEventListener('wheel', function(e: any) {
  if (document.activeElement && (document.activeElement as HTMLInputElement).type === 'number') {
    (document.activeElement as HTMLInputElement).blur();
  }
}, { passive: true });

// Enter key advances to next input in the same container (order tables, stocktake, etc.)
document.addEventListener('keydown', function(e: any) {
  if (e.key !== 'Enter') return;
  const el = document.activeElement as HTMLInputElement;
  if (!el || el.tagName !== 'INPUT') return;
  // Don't interfere with search inputs or modal inputs
  if (el.type === 'text' && el.closest('.modal')) return;
  e.preventDefault();
  // Find all visible inputs in the same scrollable container or screen
  const container = el.closest('.inv-list, .stocktake-area, .ing-table, .si-table, .screen') || document.body;
  const inputs = Array.from(container.querySelectorAll('input:not([type=hidden])')) as HTMLInputElement[];
  const idx = inputs.indexOf(el);
  if (idx >= 0 && idx < inputs.length - 1) {
    inputs[idx + 1].focus();
    inputs[idx + 1].select();
  }
});

// ── BEFOREUNLOAD GUARD ────────────────────────────────────
window.addEventListener('beforeunload', function(e: any) {
  flushUndo();
  if (saveState !== 'saved') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ── URL ROUTING ──────────────────────────────────────────
// Browser back/forward navigates between screens
window.addEventListener('popstate', () => {
  const screen = getScreenFromHash();
  showScreen(screen, false); // false = don't push state again
});

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

/** Move the user home when their current location stops being active —
 *  shared by the post-loadData boot check and the SSE registry-replace hook
 *  (a director archiving the festival must not strand the on-site cook on a
 *  location whose ritual/prep/inventory writes now silently 400). */
function revalidateCurrentLocation(): void {
  if (allActiveLocations().includes(S.currentLoc)) return;
  const staleName = locName(S.currentLoc);
  setGlobalLocation('west');
  applyLocationTheme('west');
  if (S.plannerSubTab && !allActiveLocations().includes(S.plannerSubTab)) S.plannerSubTab = 'west';
  buildNav();
  rerenderCurrentView();
  toast(`Location "${staleName}" is archived — switched to Sering West`);
}

export async function initApp() {
  // Registered at runtime (not module load): utils ↔ init sit in an import
  // cycle, and a top-level call here runs while utils' module-level `let`s
  // are still in their temporal dead zone.
  setOnRegistryChanged(revalidateCurrentLocation);
  await loadData();
  // Re-validate a tentatively-restored location now the registry is loaded
  // (restoreGlobalLocation accepts "ev-…" slugs before loadData): a saved
  // event slug that is archived/unknown falls back to West.
  if (!allActiveLocations().includes(S.currentLoc)) {
    const staleName = locName(S.currentLoc);
    setGlobalLocation('west');
    applyLocationTheme('west');
    buildNav();
    toast(`Location "${staleName}" is archived — switched to Sering West`);
  } else {
    // The registry may have arrived after buildNav (event name/theme unknown
    // at boot) — repaint the pill/theme for an event location.
    applyLocationTheme(S.currentLoc);
    const title = document.getElementById('app-title');
    if (title && !isPermanentLocation(S.currentLoc)) {
      title.className = 'app-title ' + locThemeClass(S.currentLoc);
      title.innerHTML = locTitleHtml(S.currentLoc);
    }
  }
  // Wait for cold-load resources (ingredient DB, storage config, etc.) before
  // SSE connects, so a remote patch can't land against half-loaded state and
  // be clobbered when the cold loader resolves. allSettled so a single
  // failing loader doesn't block startup.
  await Promise.allSettled([
    loadIngredientDb(),
    loadStorageConfig(),
    loadKitchenEquipment(),
    loadCookRhythm(),
    loadCostTargets(),
    loadRevenuePerGuest(),
    loadClosedServices(),
    loadGuestHistory(),
    loadGuestsNextWeeks(),
    loadInventoryCompletions(),
    loadRitualCompletions(),
    loadDrinks(),
    loadDrinkSuppliers(),
    loadDrinkConfig(),
  ]);
  rebuildPlanner();
  // Restore screen from URL hash (e.g. #planner, #orders) or default to dashboard
  const startScreen = getScreenFromHash();
  showScreen(startScreen, false);
  // Start live sync so other users' changes appear instantly
  connectLiveSync();
  // Re-arm any pending Fix-My-Menu +30min snapshot left over from before a reload.
  checkPendingFmmSnapshots();
  // Auto-refresh every 60s so the UI updates when a service deadline passes (13:45 / 20:15)
  // Only rebuild planner data silently; re-render only non-dashboard views to avoid flash.
  // Guarded so repeated logout→login in one tab doesn't stack timers (audit ARCH-3).
  if (!_autoRefreshStarted) {
    _autoRefreshStarted = true;
    setInterval(() => {
      rebuildPlanner();
      const active = document.querySelector('.screen.active');
      if (active && active.id !== 'screen-dashboard') {
        const scrollY = window.scrollY;
        rerenderCurrentView();
        requestAnimationFrame(() => window.scrollTo(0, scrollY));
      }
      // Nag for the cooked-food inventory once a deadline (13:45 / 20:15) passes.
      checkInventoryReminder();
    }, 60000);
    // Prompt initial check shortly after login, so a cook opening the app after
    // a deadline gets reminded without waiting for the first 60s tick.
    setTimeout(() => checkInventoryReminder(), 5000);
  }
}

// Guard: initApp() runs on every login and doLogout doesn't reload the page,
// so without this module-level flag each logout→login would stack another 60s
// auto-refresh timer (audit ARCH-3).
let _autoRefreshStarted = false;

// On page load: build nav, then check for existing session or show login
export async function bootstrap() {
  restoreGlobalLocation(); // must run before buildNav so the label renders the saved location
  buildNav();

  const hasSession = await checkSession();
  if (!hasSession) {
    initGoogleSignIn();
  }
}
