// Unit tests for the pure helpers of the feedback-intake assistant
// (lib/feedback-ai.ts). normalizeReport and summarizeActivity have no DB
// dependency, so they run without a database.

import { normalizeReport, summarizeActivity, type ActivityRow } from '../lib/feedback-ai';

describe('normalizeReport', () => {
  it('passes a well-formed report through, trimming strings', () => {
    const r = normalizeReport({
      title: '  Drink stock button missing  ',
      category: 'issue',
      summary: '  Floor staff can\'t mark a drink out of stock during service.  ',
      doing: 'serving drinks',
      expected: 'expected a button to mark it gone',
      severity: 'medium',
    });
    expect(r).toEqual({
      title: 'Drink stock button missing',
      category: 'issue',
      summary: "Floor staff can't mark a drink out of stock during service.",
      doing: 'serving drinks',
      expected: 'expected a button to mark it gone',
      severity: 'medium',
    });
  });

  it('falls back to general for an unknown category', () => {
    expect(normalizeReport({ title: 't', category: 'banana', summary: 's' }).category).toBe('general');
  });

  it('clears an unknown severity to empty', () => {
    expect(normalizeReport({ title: 't', category: 'idea', summary: 's', severity: 'critical' }).severity).toBe('');
  });

  it('defaults missing optional fields and coerces non-strings', () => {
    const r = normalizeReport({ category: 'nice' });
    expect(r.title).toBe('');
    expect(r.summary).toBe('');
    expect(r.doing).toBe('');
    expect(r.expected).toBe('');
    expect(r.severity).toBe('');
    expect(r.category).toBe('nice');
  });

  it('survives null/garbage input without throwing', () => {
    expect(() => normalizeReport(null)).not.toThrow();
    expect(() => normalizeReport('nope')).not.toThrow();
    expect(normalizeReport(null).category).toBe('general');
  });
});

describe('summarizeActivity', () => {
  it('reports the current screen even with no telemetry rows', () => {
    expect(summarizeActivity([], 'orders')).toContain('orders');
  });

  it('returns a non-empty default when there is nothing to report', () => {
    expect(summarizeActivity([], '')).toBe('No recent activity recorded for this person.');
  });

  it('lists distinct recent screens and recent errors', () => {
    const rows: ActivityRow[] = [
      { type: 'screen_view', name: 'orders' },
      { type: 'screen_view', name: 'orders' }, // duplicate collapses
      { type: 'screen_view', name: 'planner' },
      { type: 'error', name: 'Cannot read properties of undefined (reading qty)' },
    ];
    const out = summarizeActivity(rows, 'drinks');
    expect(out).toContain('"drinks" screen');
    expect(out).toContain('orders');
    expect(out).toContain('planner');
    // de-duped: 'orders' appears once in the screens line
    expect(out.match(/orders/g)?.length).toBe(1);
    expect(out).toContain('Cannot read properties of undefined');
  });

  it('caps the number of errors surfaced', () => {
    const rows: ActivityRow[] = Array.from({ length: 9 }, (_, i) => ({ type: 'error', name: `err-${i}` }));
    const out = summarizeActivity(rows, '');
    const shown = (out.match(/err-\d/g) || []).length;
    expect(shown).toBeLessThanOrEqual(5);
  });
});
