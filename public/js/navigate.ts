// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATE — screen router + late-binding renderer registry.
//
// Each screen module calls `registerRenderer('<screen>', renderFn)` at import
// time. showScreen() looks up renderers by string key, which lets navigate.ts
// stay free of any direct screen imports and avoids the cyclic import shape
// where every screen needed dashboard.ts and dashboard.ts needed every screen.
// ─────────────────────────────────────────────────────────────────────────────

import { NAV_SCREENS } from './state';

type RenderFn = () => void;
const renderers: Record<string, RenderFn> = {};

let _currentScreen = 'dashboard';

// Optional pre-render hook — used by main.ts to wire trackScreenView() without
// dragging telemetry into every screen module's import graph.
type ScreenChangeHook = (screen: string) => void;
let _onScreenChange: ScreenChangeHook | null = null;
export function setOnScreenChange(fn: ScreenChangeHook): void {
  _onScreenChange = fn;
}

export function registerRenderer(screen: string, fn: RenderFn) {
  renderers[screen] = fn;
}

export function getCurrentScreen(): string {
  return _currentScreen;
}

export function setCurrentScreen(screen: string) {
  _currentScreen = screen;
}

export function rerenderCurrentView() {
  const fn = renderers[_currentScreen];
  if (fn) fn();
}

/** Resolve a screen id from the URL hash, falling back to dashboard for
 *  unknown values. */
export function getScreenFromHash(): string {
  const hash = window.location.hash.replace('#', '');
  const validScreens = NAV_SCREENS.map(s => s.id);
  return validScreens.includes(hash) ? hash : 'dashboard';
}

/** Activate a screen by id: update hash, mark CSS .active, dispatch the
 *  registered renderer. Used to live in dashboard.ts and import every screen
 *  module directly. */
export function showScreen(name: string, pushState = true) {
  if (_onScreenChange) _onScreenChange(name);
  setCurrentScreen(name);
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-' + name)?.classList.add('active');
  document.querySelectorAll('.nav-btn, .bnav-btn').forEach(b => {
    b.classList.toggle('active', (b as HTMLElement).dataset.screen === name);
  });
  if (pushState) {
    const hash = name === 'dashboard' ? '' : '#' + name;
    if (window.location.hash !== hash && !(name === 'dashboard' && !window.location.hash)) {
      history.pushState({ screen: name }, '', hash || window.location.pathname);
    }
  }
  // Dispatch via registry. Renderers self-register at import time.
  // The previous showScreen also called rebuildPlanner() for dashboard /
  // planner / orders; that side-effect now lives inside those render fns.
  const fn = renderers[name];
  if (fn) fn();
}
