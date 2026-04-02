import { S, NAV_SCREENS } from './state';
import { loadData, connectLiveSync, saveState } from './utils';
import { rebuildPlanner } from './core';
import { renderDashboard } from './dashboard';
import { checkSession, initGoogleSignIn } from './auth';

// ── THEME ─────────────────────────────────────────────────
// Apply saved theme immediately to prevent flash
if (localStorage.getItem('theme') === 'dark') document.documentElement.classList.add('dark');

export function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  const btn = document.querySelector('.theme-toggle');
  if (btn) btn.innerHTML = isDark ? '&#9788;' : '&#9790;';
}

// ── MODAL ─────────────────────────────────────────────────
export function showModal(content: any) {
  document.getElementById('modal-root')!.innerHTML = `<div class="modal-bg" onclick="closeModal()"><div class="modal" onclick="event.stopPropagation()">${content}</div></div>`;
}
export function closeModal() {
  document.getElementById('modal-root')!.innerHTML = '';
  // Reopen inventory if we came from served dialog
  if (S._inventoryLoc) {
    const loc = S._inventoryLoc;
    S._inventoryLoc = null;
    setTimeout(() => (window as any).openInventory?.(loc), 200);
  }
}

// ── HTML ESCAPE ───────────────────────────────────────────
export function esc(str: any) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ── NAV GENERATION ────────────────────────────────────────
// Builds top bar, bottom nav, and screen containers from NAV_SCREENS
export function buildNav() {
  const topBar = document.getElementById('top-bar')!;
  const content = document.getElementById('content')!;
  const bottomNav = document.getElementById('bottom-nav')!;

  // Top bar: title + nav buttons + save indicator + user menu
  topBar.innerHTML = `
    <h1>De Sering</h1>
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
document.addEventListener('keydown', function(e: any) {
  if (e.key === 'Escape') {
    // Cancel assign mode if active
    if (S.assigningBatchId) { (window as any).cancelAssignMode?.(); return; }
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
  if (saveState !== 'saved') {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

export async function initApp() {
  await loadData();
  rebuildPlanner();
  renderDashboard();
  // Start live sync so other users' changes appear instantly
  connectLiveSync();
  // Auto-refresh every 60s so the UI updates when a service deadline passes (13:45 / 20:15)
  // Only rebuild planner data silently; re-render only non-dashboard views to avoid flash
  setInterval(() => {
    rebuildPlanner();
    const active = document.querySelector('.screen.active');
    if (active && active.id !== 'screen-dashboard') {
      const scrollY = window.scrollY;
      (window as any).rerenderCurrentView?.();
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
