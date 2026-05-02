// ─────────────────────────────────────────────────────────────────────────────
// SHARED DATE HELPERS
//
// Single source of truth for "format Date as YYYY-MM-DD (local)" and the few
// derived functions. Four equivalent implementations were drifting:
//   - dateToIso (public/js/core.ts)
//   - localDateStr (public/js/predictions.ts)
//   - fmtDate (public/js/finance.ts)
//   - todayIso (public/js/utils.ts)
//
// All return local Y-M-D. NEVER use `toISOString().slice(0,10)` — that's UTC,
// which flips to yesterday in Amsterdam between 00:00 and ~02:00 local and
// broke prep-checklist keys (audit §1.4).
// ─────────────────────────────────────────────────────────────────────────────

/** Format a Date as `YYYY-MM-DD` in local time. */
export function formatIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's local date as `YYYY-MM-DD`. */
export function todayIso(): string {
  return formatIso(new Date());
}

/** Return a new Date `n` days after `d`. Negative `n` for earlier. Does not
 *  mutate the input. */
export function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(d.getDate() + n);
  return r;
}

/** ISO weekday short name for `d.getDay()` value (0..6, Sunday-first). */
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Weekday short name (`Mon`..`Sun`) for a Date. Use this when querying the
 *  Guest table whose `day` column stores weekday names (NOT ISO dates — that
 *  was the AI-analyzer bug, audit §1.1). */
export function weekdayShort(d: Date): string {
  return WEEKDAY_SHORT[d.getDay()];
}

/** Monday-key for the week a date belongs to, as `YYYY-MM-DD`. Used by the
 *  GuestsNextWeeks model. */
export function mondayKeyOf(d: Date): string {
  const dow = d.getDay(); // 0=Sun
  const off = dow === 0 ? -6 : 1 - dow;
  return formatIso(addDays(d, off));
}

/** Render `YYYY-MM-DD` as `DD/MM` for compact display. Returns input on parse failure. */
export function shortDayMonth(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}`;
}
