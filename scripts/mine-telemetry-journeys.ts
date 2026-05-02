#!/usr/bin/env node
/**
 * CLI wrapper around lib/telemetry-coverage.ts. Outputs the coverage snapshot
 * as JSON to stdout — consumed by the weekly-test-coverage agent and useful
 * for local exploration.
 *
 * Env:
 *   DATABASE_URL_PROD   read-only prod URL (preferred)
 *   DATABASE_URL        fallback (e.g. local development)
 *   TELEMETRY_DAYS      lookback window in days (default 14)
 *   TELEMETRY_TOP_N     how many distinct journeys to return (default 20)
 *   TELEMETRY_MIN_LEN   minimum journey length to include (default 3)
 *
 * Usage:
 *   DATABASE_URL_PROD="postgresql://..." npm run telemetry:mine
 *
 * Why a separate `_PROD` var: the test/setup-env.ts guard refuses to run if
 * DATABASE_URL points at a production host. Reading telemetry from prod is
 * safe (read-only) but we don't want any other tooling that assumes
 * DATABASE_URL is a scratch DB to touch prod by accident.
 */

import { PrismaClient } from '@prisma/client';
import { analyzeCoverage } from '../lib/telemetry-coverage';

interface OutputWithHost {
  databaseHost: string;
  windowDays: number;
  totalSessions: number;
  totalEventsScanned: number;
  knownFeatures: string[];
  coveredFeatures: string[];
  uncoveredFeatures: string[];
  uncoveredFeatureFrequency: Record<string, number>;
  topJourneys: unknown[];
}

async function main(): Promise<void> {
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
    const snapshot = await analyzeCoverage(prisma, {
      daysBack: Number(process.env.TELEMETRY_DAYS ?? 14),
      topN: Number(process.env.TELEMETRY_TOP_N ?? 20),
      minLength: Number(process.env.TELEMETRY_MIN_LEN ?? 3),
    });
    const out: OutputWithHost = { databaseHost: host, ...snapshot };
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
