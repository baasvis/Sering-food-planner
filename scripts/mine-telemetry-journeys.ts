#!/usr/bin/env node
/**
 * Mines the telemetry_event table for the most common user journeys over the
 * last N days, then cross-references with e2e/coverage-manifest.json to flag
 * trackEvent features that aren't covered by any e2e test.
 *
 * Output: JSON to stdout — consumed by the weekly-test-coverage agent.
 *
 * Env:
 *   DATABASE_URL_PROD   read-only prod URL (preferred)
 *   DATABASE_URL        fallback (e.g. local development)
 *   TELEMETRY_DAYS      lookback window in days (default 14)
 *   TELEMETRY_TOP_N     how many distinct journeys to return (default 20)
 *   TELEMETRY_MIN_LEN   minimum journey length to include (default 3)
 *
 * Usage (local):
 *   DATABASE_URL_PROD="postgresql://..." npm run telemetry:mine
 *
 * Why a separate `_PROD` var: the test/setup-env.ts guard refuses to run if
 * DATABASE_URL points at a production host. Reading telemetry from prod is
 * safe (read-only), but we don't want any other tooling that assumes
 * DATABASE_URL is a scratch DB to touch prod by accident.
 */

import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

interface Args {
  daysBack: number;
  topN: number;
  minLength: number;
}

interface RawEvent {
  sessionId: string;
  type: string;
  name: string;
}

interface JourneyStats {
  journey: string;            // human-readable signature: "screen:guests → feature:predictions_apply → ..."
  sessionCount: number;       // how many distinct sessions traced this exact path
  features: string[];         // distinct feature_use names referenced (deduped, in order)
  uncoveredFeatures: string[]; // subset of features not covered by any e2e test
}

interface MiningOutput {
  databaseHost: string;
  windowDays: number;
  totalSessions: number;
  totalEventsScanned: number;
  knownFeatures: string[];           // every distinct trackEvent name in the source
  coveredFeatures: string[];         // union of e2e/coverage-manifest.json values
  uncoveredFeatures: string[];       // knownFeatures \ coveredFeatures (set diff)
  uncoveredFeatureFrequency: Record<string, number>; // sessions in window that triggered each uncovered feature
  topJourneys: JourneyStats[];
}

function parseArgs(): Args {
  return {
    daysBack: Number(process.env.TELEMETRY_DAYS ?? 14),
    topN: Number(process.env.TELEMETRY_TOP_N ?? 20),
    minLength: Number(process.env.TELEMETRY_MIN_LEN ?? 3),
  };
}

/** Read every distinct trackEvent('...') name from the public/js source tree. */
function discoverKnownFeatures(): string[] {
  const root = path.join(process.cwd(), 'public', 'js');
  const features = new Set<string>();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.ts')) {
        const src = fs.readFileSync(full, 'utf8');
        // Match trackEvent('feature_name', ...) — first arg only.
        for (const m of src.matchAll(/trackEvent\(['"]([a-zA-Z0-9_-]+)['"]/g)) {
          features.add(m[1]);
        }
      }
    }
  }
  return [...features].sort();
}

/** Read e2e/coverage-manifest.json and return the union of covered features. */
function loadCoveredFeatures(): { perFile: Record<string, string[]>; covered: Set<string> } {
  const file = path.join(process.cwd(), 'e2e', 'coverage-manifest.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string[] | string>;
  const perFile: Record<string, string[]> = {};
  const covered = new Set<string>();
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('_')) continue; // skip _doc and other meta keys
    if (!Array.isArray(v)) continue;
    perFile[k] = v;
    for (const f of v) covered.add(f);
  }
  return { perFile, covered };
}

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
    .filter((r): r is RawEvent => r.sessionId !== null)
    .map((r) => ({ sessionId: r.sessionId as string, type: r.type, name: r.name }));
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
  args: Args,
  coveredFeatures: Set<string>,
): { journeys: JourneyStats[]; totalSessions: number } {
  const counts = new Map<string, number>();
  for (const journey of sessions.values()) {
    if (journey.length < args.minLength) continue;
    const key = journey.join(' → ');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()]
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
  return { journeys: sorted, totalSessions: sessions.size };
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

async function main() {
  const args = parseArgs();
  const dbUrl = process.env.DATABASE_URL_PROD ?? process.env.DATABASE_URL ?? '';
  if (!dbUrl) {
    console.error('No database URL set (DATABASE_URL_PROD or DATABASE_URL).');
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  let host = 'unknown';
  try {
    host = new URL(dbUrl.replace(/^postgresql:/, 'http:')).host;
  } catch { /* ignore parse failures */ }

  try {
    const knownFeatures = discoverKnownFeatures();
    const { perFile: _perFile, covered } = loadCoveredFeatures();
    const events = await fetchEvents(prisma, args.daysBack);
    const sessions = buildJourneys(events);
    const { journeys, totalSessions } = rankJourneys(sessions, args, covered);

    const uncoveredFeatures = knownFeatures.filter((f) => !covered.has(f));
    const uncoveredFreq = tallyUncoveredFrequency(sessions, new Set(uncoveredFeatures));

    const out: MiningOutput = {
      databaseHost: host,
      windowDays: args.daysBack,
      totalSessions,
      totalEventsScanned: events.length,
      knownFeatures,
      coveredFeatures: [...covered].sort(),
      uncoveredFeatures,
      uncoveredFeatureFrequency: uncoveredFreq,
      topJourneys: journeys,
    };

    console.log(JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
