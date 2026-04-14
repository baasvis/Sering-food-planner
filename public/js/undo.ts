import { showUndoToast, hideToast, cancelPendingSave, toast } from './utils';

const UNDO_TIMEOUT_MS = 5000;

interface UndoEntry {
  label: string;
  restore: () => void;
  commit: () => void;
  timer: ReturnType<typeof setTimeout>;
}

let pending: UndoEntry | null = null;

/** Register a new undoable action. Flushes any previous pending undo first. */
export function pushUndo(entry: Omit<UndoEntry, 'timer'>): void {
  flushUndo();
  cancelPendingSave();

  const timer = setTimeout(() => {
    const p = pending;
    pending = null;
    hideToast();
    if (p) p.commit();
  }, UNDO_TIMEOUT_MS);

  pending = { ...entry, timer };
  showUndoToast(entry.label, executeUndo);
}

/** Undo the pending action — restores state, cancels the commit. */
export function executeUndo(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  hideToast();
  p.restore();
  toast('Restored');
}

/** Immediately commit any pending undo (called on beforeunload, remote patch, new pushUndo). */
export function flushUndo(): void {
  if (!pending) return;
  clearTimeout(pending.timer);
  const p = pending;
  pending = null;
  hideToast();
  p.commit();
}
