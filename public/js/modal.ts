// ─────────────────────────────────────────────────────────────────────────────
// MODAL UTILITIES — standalone module, no app dependencies
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';

// Late-bound callback for reopening inventory after served dialog
let _openInventoryFn: ((loc: string) => void) | null = null;
export function setOpenInventoryFn(fn: (loc: string) => void) { _openInventoryFn = fn; }

export function showModal(content: string) {
  // role="dialog" + aria-modal="true" so screen readers announce the modal
  // as a dialog and treat the rest of the page as inert. tabindex="-1"
  // makes the wrapper programmatically focusable for the focus shift below.
  // (Audit U1/U3 — minimum-viable a11y pass; deeper focus-trap deferred.)
  document.getElementById('modal-root')!.innerHTML =
    `<div class="modal-bg" onclick="closeModal()"><div class="modal" role="dialog" aria-modal="true" tabindex="-1" onclick="event.stopPropagation()">${content}</div></div>`;
  // Move focus into the modal so Tab walks the dialog content first instead
  // of the underlying screen. Restored to body on close (which the existing
  // close path leaves implicit). Defer to next frame so the inserted node is
  // attached and focusable before we call focus().
  requestAnimationFrame(() => {
    const m = document.querySelector('.modal') as HTMLElement | null;
    if (m) m.focus();
  });
}

export function closeModal() {
  document.getElementById('modal-root')!.innerHTML = '';
  // Reopen inventory if we came from served dialog
  if (S._inventoryLoc) {
    const loc = S._inventoryLoc;
    S._inventoryLoc = null;
    setTimeout(() => _openInventoryFn?.(loc), 200);
  }
}

// HTML-escape any value for safe embedding in templates
export function esc(str: unknown): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
