// ─────────────────────────────────────────────────────────────────────────────
// TELEMETRY COVERAGE — analyses the telemetry_event table to find user journeys
// and flags trackEvent() features that aren't covered by any e2e test.
//
// Used by:
//   - scripts/mine-telemetry-journeys.ts   (CLI, run locally or by an agent)
//   - routes/coverage.ts                    (HTTPS endpoint for remote agents)
//
// Importantly: discoverKnownFeatures() reads source files from public/js/, which
// the Railway runtime preserves alongside the compiled server (vite consumes
// public/ but doesn't delete it). If that ever changes, switch to scanning the
// built bundle in dist/client/assets/index-*.js — the trackEvent name strings
// are preserved verbatim there.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from 'fs';
import * as path from 'path';
import type { PrismaClient } from '@prisma/client';

export interface CoverageArgs {
  daysBack: number;
  topN: number;
  minLength: number;
}

export interface JourneyStats {
  journey: string;
  sessionCount: number;
  features: string[];
  uncoveredFeatures: string[];
}

export interface CoverageSnapshot {
  windowDays: number;
  totalSessions: number;
  totalEventsScanned: number;
  knownFeatures: string[];
  coveredFeatures: string[];
  uncoveredFeatures: string[];
  uncoveredFeatureFrequency: Record<string, number>;
  topJourneys: JourneyStats[];
}

interface RawEvent {
  sessionId: string;
  type: string;
  name: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Source-driven feature discovery + manifest parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scan public/js/**\/*.ts for trackEvent('feature_name') calls and return the
 * sorted set of distinct feature names.
 */
export function discoverKnownFeatures(rootDir: string = process.cwd()): string[] {
  const root = path.join(rootDir, 'public', 'js');
  if (!fs.existsSync(root)) return [];
  const features = new Set<string>();
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.ts')) {
        const src = fs.readFileSync(full, 'utf8');
        for (const m of src.matchAll(/trackEvent\(['"]([a-zA-Z0-9_-]+)['"]/g)) {
          features.add(m[1]);
        }
      }
    }
  }
  return [...features].sort();
}

/** Parse e2e/coverage-manifest.json. Returns the union set of covered features. */
export function loadCoveredFeatures(rootDir: string = process.cwd()): Set<string> {
  const file = path.join(rootDir, 'e2e', 'coverage-manifest.json');
  if (!fs.existsSync(file)) return new Set();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  const covered = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue;
    if (!Array.isArray(v)) continue;
    for (const f of v) if (typeof f === 'string') covered.add(f);
  }
  return covered;
}

// ─────────────────────────────────────────────────────────────────────────────
// Telemetry analysis
// ─────────────────────────────────────────────────────────────────────────────

async function fetchEvents(prisma: PrismaClient, daysBack: number): Promise<RawEvent[]> {
  const since = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const rows = await prisma.telemetryEvent.findMany({
    where: {
      timestamp: { gte: since },
      type: { in: ['screen_view', 'feature_use'] },
      NOT: { sessionId: null },
    },
    orderBy: [{ sessionId: 'asc' }, { timestamp: 'asc' }],
    select: { sessionId: true, type: true, name: true },
  });
  return rows
    .filter((r): r is { sessionId: string; type: string; name: string } => r.sessionId !== null)
    .map((r) => ({ sessionId: r.sessionId, type: r.type, name: r.name }));
}

function buildJourneys(events: RawEvent[]): Map<string, string[]> {
  const sessions = new Map<string, string[]>();
  for (const ev of events) {
    const arr = sessions.get(ev.sessionId) ?? [];
    const prefix = ev.type === 'screen_view' ? 'screen' : 'feature';
    arr.push(`${prefix}:${ev.name}`);
    sessions.set(ev.sessionId, arr);
  }
  return sessions;
}

function rankJourneys(
  sessions: Map<string, string[]>,
  args: CoverageArgs,
  coveredFeatures: Set<string>,
): JourneyStats[] {
  const counts = new Map<string, number>();
  for (const journey of sessions.values()) {
    if (journey.length < args.minLength) continue;
    const key = journey.join(' → ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, args.topN)
    .map(([journey, sessionCount]): JourneyStats => {
      const featureSet = new Set<string>();
      for (const seg of journey.split(' → ')) {
        if (seg.startsWith('feature:')) featureSet.add(seg.slice('feature:'.length));
      }
      const features = [...featureSet];
      return {
        journey,
        sessionCount,
        features,
        uncoveredFeatures: features.filter((f) => !coveredFeatures.has(f)),
      };
    });
}

function tallyUncoveredFrequency(
  sessions: Map<string, string[]>,
  uncovered: Set<string>,
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const f of uncovered) tally[f] = 0;
  for (const journey of sessions.values()) {
    const seenInSession = new Set<string>();
    for (const seg of journey) {
      if (!seg.startsWith('feature:')) continue;
      const name = seg.slice('feature:'.length);
      if (uncovered.has(name) && !seenInSession.has(name)) {
        tally[name]++;
        seenInSession.add(name);
      }
    }
  }
  return tally;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full coverage snapshot — same shape returned by the CLI script and
 * the HTTP endpoint. Caller provides a connected PrismaClient (so this lib
 * doesn't dictate connection management).
 */
export async function analyzeCoverage(
  prisma: PrismaClient,
  args: CoverageArgs,
  rootDir: string = process.cwd(),
): Promise<CoverageSnapshot> {
  const knownFeatures = discoverKnownFeatures(rootDir);
  const covered = loadCoveredFeatures(rootDir);
  const events = await fetchEvents(prisma, args.daysBack);
  const sessions = buildJourneys(events);
  const journeys = rankJourneys(sessions, args, covered);
  const uncoveredFeatures = knownFeatures.filter((f) => !covered.has(f));
  const uncoveredFrequency = tallyUncoveredFrequency(sessions, new Set(uncoveredFeatures));

  return {
    windowDays: args.daysBack,
    totalSessions: sessions.size,
    totalEventsScanned: events.length,
    knownFeatures,
    coveredFeatures: [...covered].sort(),
    uncoveredFeatures,
    uncoveredFeatureFrequency: uncoveredFrequency,
    topJourneys: journeys,
  };
}
