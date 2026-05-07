// Bench types for the Fix-My-Menu solver comparison.
//
// A fixture is a frozen snapshot of the world (batches, guests, caterings,
// kitchen, "today") that any solver can be asked to plan. The harness
// reconstructs S from the fixture, runs the solver, and scores the result.

import type {
  Batch, Catering, KitchenEquipment, GuestsData, StorageConfig,
  Location, Meal,
} from '../../shared/types';

/**
 * Pre-computed date-keyed guest lookup. Built at fixture-build time by
 * resolving the same fallback chain that getGuests() uses (base → nextWeeks
 * → predictions). Both the scorer and any solver that wants to skip the
 * dayName/week-Monday dance can read directly from here.
 */
export interface GuestsLookup {
  [isoDate: string]: {
    west: { lunch: number; dinner: number };
    centraal: { lunch: number; dinner: number };
  };
}

/** Per-week predictions keyed by Monday ISO date — mirrors S.guestsNextWeeks. */
export interface GuestsByWeek {
  [mondayIso: string]: GuestsData;
}

export interface Fixture {
  /** Stable identifier (also the file basename, without .json) */
  name: string;
  /** Human-readable description of what this scenario stresses */
  description: string;
  /** Anchor date for getToday() — ISO YYYY-MM-DD */
  today: string;
  /** Full batch list — past + future, will be cloned per run */
  batches: Batch[];
  /** Caterings within or near the planning window */
  caterings: Catering[];
  /** S.guests — day-name keyed base counts */
  guestsBase: GuestsData;
  /** S.guestsNextWeeks — week-Monday keyed predictions */
  guestsNextWeeks: GuestsByWeek;
  /** S.predictions — day-name keyed POS-derived predictions */
  guestsPredictions: GuestsData;
  /** Pre-computed flat lookup the scorer uses (resolved via getGuests fallback) */
  guestsLookup: GuestsLookup;
  /** Pots/pans config — affects pot-cap logic */
  kitchenEquipment: KitchenEquipment;
  /** Storage areas per location */
  storageConfig: StorageConfig;
}

export interface SolverResult {
  /** Mutated batches — services assigned by the solver */
  batches: Batch[];
  /** Solver's own warning list (free-form per strategy) */
  warnings?: unknown[];
  /** Wall-clock time in ms */
  durationMs: number;
  /** Strategy-specific stats (peers formed, iterations, etc.) — for reports */
  stats?: Record<string, number | string>;
}

/**
 * Each strategy implements one of these. Receives a sandboxed copy of S +
 * helper functions; returns the mutated batches array.
 *
 * Solvers MAY mutate the input batches (the harness clones first). They MUST
 * NOT touch the filesystem or call any I/O.
 */
export type SolverFn = (input: SolverInput) => SolverResult;

export interface SolverInput {
  /** The fixture being run, for self-contained context */
  fixture: Fixture;
  /** Mutable batch array (already cloned from fixture) — solver writes services here */
  batches: Batch[];
}

// ── Scoring ─────────────────────────────────────────────────────────────────

export interface ScoreReport {
  /** Total score — higher is better. Negative is possible. */
  total: number;
  breakdown: ScoreBreakdown;
  /** Hard-fail constraints — non-empty means the solution is INVALID */
  hardFails: string[];
  /** Soft warnings — count toward total via weights */
  softViolations: SoftViolation[];
}

export interface ScoreBreakdown {
  slotsFilledPoints: number;
  missedMatchPenalty: number;
  leftoverSurplusPenalty: number;
  overcommitPenalty: number;
  overCapPenalty: number;
  staleNotAssignedPenalty: number;
  familyBudgetPenalty: number;
  oldestFirstBonus: number;
  varietyBonus: number;
  // Counters for transparency
  slotsFilled: number;
  slotsTotal: number;
  missedMatches: number;
  leftoverSurplusLiters: number;
  overcommitDeficitLiters: number;
  overCapSlots: number;
  staleNotAssignedLiters: number;
  familyBudgetViolations: number;
  oldestFirstHits: number;
  varietySlots: number;
}

export interface SoftViolation {
  category: string;
  detail: string;
  liters?: number;
  batchId?: string;
  slot?: { loc: Location; date: string; meal: Meal };
}

// ── Runner output ───────────────────────────────────────────────────────────

export interface BenchRun {
  strategy: string;
  fixture: string;
  score: ScoreReport;
  durationMs: number;
  stats?: Record<string, number | string>;
}
