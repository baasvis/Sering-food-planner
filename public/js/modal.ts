// ─────────────────────────────────────────────────────────────────────────────
// MODAL UTILITIES — standalone module, no app dependencies
// ─────────────────────────────────────────────────────────────────────────────

import { S } from './state';

// Late-bound callback for reopening inventory after served dialog
let _openInventoryFn: ((loc: string) => void) | null = null;
export function setOpenInventoryFn(fn: (loc: string) => void) { _openInventoryFn = fn; }

export function showModal(content: string) {
  document.getElementById('modal-root')!.innerHTML =
    `<div class="modal-bg" onclick="closeModal()"><div class="modal" onclick="event.stopPropagation()">${content}</div></div>`;
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
