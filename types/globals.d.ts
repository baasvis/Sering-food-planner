// ─────────────────────────────────────────────────────────────────────────────
// DOM type augmentations for elements accessed via getElementById
// ─────────────────────────────────────────────────────────────────────────────
// Instead of the migration-era catch-all `[key: string]: any`, we use proper
// type narrowing: getElementById returns HTMLElement | null, and callers
// should cast to the specific element type (HTMLInputElement, etc.) or use
// the `as` assertion at the call site.
//
// For window: we declare an index signature so that Object.assign(window, {...})
// works for onclick="" handlers. This is intentional — the app uses inline
// onclick handlers that reference window-level functions.
// ─────────────────────────────────────────────────────────────────────────────

interface Window {
  // Allow dynamic function assignment for onclick="" handlers via Object.assign
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}
