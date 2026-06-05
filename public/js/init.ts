import { S, NAV_SCREENS, setGlobalLocation, rebuildStorageCategories, restoreGlobalLocation, screenPermission } from './state';
import type { Location } from '@shared/types';
import { loadData, connectLiveSync, saveState,
         loadIngredientDb, loadStorageConfig, loadKitchenEquipment, loadCookRhythm, loadCostTargets, loadRevenuePerGuest, loadClosedServices,
         loadGuestHistory, loadGuestsNextWeeks, loadInventoryCompletions,
         loadRitualCompletions } from './utils';
import { flushUndo } from './undo';
import { rebuildPlanner } from './core';
import { renderDashboard, showScreen, getScreenFromHash } from './dashboard';
import { checkSession, initGoogleSignIn } from './auth';
import { closeModal, showModal } from './modal';
import { rerenderCurrentView } from './navigate';

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
/** Inner HTML of the switcher pill: coloured dot + "Sering <Loc>" + swap hint. */
function locTitleHtml(loc: Location): string {
  const name = loc === 'west' ? 'West' : 'Centraal';
  return `<span class="app-title-dot"></span>Sering <span class="app-title-loc">${name}</span><span class="app-title-swap" aria-hidden="true">⇄</span>`;
}

/** Mirror the active location onto <body> so the accent colour (--loc-accent)
 *  cascades to the top bar, bottom nav and anything else outside the title. */
export function applyLocationTheme(loc: Location): void {
  document.body.classList.toggle('loc-west', loc === 'west');
  document.body.classList.toggle('loc-centraal', loc === 'centraal');
}

/** Step 1: clicking the switcher asks for confirmation — switching changes the
 *  whole app's location context, so it shouldn't happen on an accidental tap. */
export function confirmSwitchLocation() {
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
}

/** Step 2: actually flip the location (called from the confirm button, which
 *  passes the exact target it displayed so the two can't drift). Falls back to
 *  toggling the current location if called without a valid target. */
export function switchGlobalLocation(target?: Location) {
  const newLoc: Location = (target === 'west' || target === 'centraal')
    ? target
    : (S.currentLoc === 'west' ? 'centraal' : 'west');
  setGlobalLocation(newLoc);
  applyLocationTheme(newLoc);

  // Update the switcher pill
  const title = document.getElementById('app-title');
  if (title) {
    title.className = 'app-title ' + (newLoc === 'west' ? 'loc-west' : 'loc-centraal');
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
    <h1 class="app-title ${S.currentLoc === 'west' ? 'loc-west' : 'loc-centraal'}" id="app-title" onclick="confirmSwitchLocation()" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();confirmSwitchLocation();}" title="Switch location" role="button" tabindex="0">${locTitleHtml(S.currentLoc)}</h1>
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

export async function initApp() {
  await loadData();
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
  ]);
  rebuildPlanner();
  // Restore screen from URL hash (e.g. #planner, #orders) or default to dashboard
  const startScreen = getScreenFromHash();
  showScreen(startScreen, false);
  // Start live sync so other users' changes appear instantly
  connectLiveSync();
  // Auto-refresh every 60s so the UI updates when a service deadline passes (13:45 / 20:15)
  // Only rebuild planner data silently; re-render only non-dashboard views to avoid flash
  setInterval(() => {
    rebuildPlanner();
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 'screen-dashboard') {
      const scrollY = window.scrollY;
      rerenderCurrentView();
      requestAnimationFrame(() => window.scrollTo(0, scrollY));
    }
  }, 60000);
}

// On page load: build nav, then check for existing session or show login
export async function bootstrap() {
  restoreGlobalLocation(); // must run before buildNav so the label renders the saved location
  buildNav();

  const hasSession = await checkSession();
  if (!hasSession) {
    initGoogleSignIn();
  }
}
