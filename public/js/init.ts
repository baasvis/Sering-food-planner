import { S, NAV_SCREENS, setGlobalLocation, rebuildStorageCategories } from './state';
import type { Location } from '@shared/types';
import { loadData, connectLiveSync, saveState } from './utils';
import { flushUndo } from './undo';
import { rebuildPlanner } from './core';
import { renderDashboard, showScreen, getScreenFromHash } from './dashboard';
import { checkSession, initGoogleSignIn } from './auth';
import { closeModal } from './modal';
import { rerenderCurrentView } from './navigate';
import { cancelAssignMode } from './planner';

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
export function switchGlobalLocation() {
  const newLoc: Location = S.currentLoc === 'west' ? 'centraal' : 'west';
  setGlobalLocation(newLoc);

  // Update title
  const title = document.getElementById('app-title');
  if (title) {
    title.className = 'app-title ' + (newLoc === 'west' ? 'loc-west' : 'loc-centraal');
    title.innerHTML = `Sering <span class="app-title-loc">${newLoc === 'west' ? 'West' : 'Centraal'}</span>`;
  }

  // Sync finance filter to new location
  S.financeProductLoc = newLoc;

  // Rebuild storage categories for new location
  rebuildStorageCategories(newLoc);

  // Re-render active screen
  rerenderCurrentView();
}

// ── NAV GENERATION ────────────────────────────────────────
// Builds top bar, bottom nav, and screen containers from NAV_SCREENS
export function buildNav() {
  const topBar = document.getElementById('top-bar')!;
  const content = document.getElementById('content')!;
  const bottomNav = document.getElementById('bottom-nav')!;

  // Top bar: title + nav buttons + save indicator + user menu
  topBar.innerHTML = `
    <h1 class="app-title ${S.currentLoc === 'west' ? 'loc-west' : 'loc-centraal'}" id="app-title" onclick="switchGlobalLocation()" title="Click to switch location">Sering <span class="app-title-loc">${S.currentLoc === 'west' ? 'West' : 'Centraal'}</span></h1>
    ${NAV_SCREENS.map((s: any, i: any) =>
      `<button class="nav-btn${i === 0 ? ' active' : ''}" data-screen="${s.id}" onclick="showScreen('${s.id}')">${s.topLabel}</button>`
    ).join('')}
    <div class="save-indicator" id="save-indicator">
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
  content.innerHTML = NAV_SCREENS.map((s: any, i: any) =>
    `<div id="screen-${s.id}" class="screen${i === 0 ? ' active' : ''}"></div>`
  ).join('');

  // Bottom nav
  bottomNav.innerHTML = NAV_SCREENS.map((s: any, i: any) =>
    `<button class="bnav-btn${i === 0 ? ' active' : ''}" data-screen="${s.id}" onclick="showScreen('${s.id}')">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${s.icon}</svg>
      <span>${s.bottomLabel}</span>
    </button>`
  ).join('');
}

// ── GLOBAL KEY HANDLERS ──────────────────────────────────
document.addEventListener('keydown', function(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // Cancel assign mode if active
    if (S.assigningBatchId) { cancelAssignMode(); return; }
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
  buildNav();

  const hasSession = await checkSession();
  if (!hasSession) {
    initGoogleSignIn();
  }
}
