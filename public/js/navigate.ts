// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATE — late-binding registry for screen renderers
// Breaks circular dependencies between screen modules.
// Each module calls registerRenderer() at import time;
// rerenderCurrentView() and showScreen() call them at runtime.
// ─────────────────────────────────────────────────────────────────────────────

type RenderFn = () => void;
const renderers: Record<string, RenderFn> = {};

let _currentScreen = 'dashboard';

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
