// ─────────────────────────────────────────────────────────────────────────────
// AI ANALYZER — data quality checks, telemetry aggregation, and Claude insights
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from './db';
import { errMsg } from './config';
import type { InsightCategory, InsightSeverity } from '../shared/types';

// ── Types ──

interface DataQualityReport {
  staleBatches: Array<{ id: string; name: string; cookDate: string | null; stock: number }>;
  unusedRecipes: Array<{ id: string; name: string; createdAt: string }>;
  staleFeedback: Array<{ id: number; type: string; text: string; timestamp: string }>;
  missingGuestDays: string[];
  financeSyncGaps: string[];
  batchesWithoutServices: Array<{ id: string; name: string; stock: number }>;
}

interface TelemetrySummary {
  errors: Array<{ name: string; count: number; last_seen: string }>;
  screenViews: Array<{ name: string; views: number; avg_duration: number | null }>;
  apiPerf: Array<{ name: string; calls: number; avg_ms: number; max_ms: number; errors: number }>;
  featureUsage: Array<{ name: string; uses: number }>;
  uniqueUsers: number;
  totalEvents: number;
}

interface ParsedInsight {
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

// ── Inventory helpers (private to this module) ──
//
// Used by the unified-batch Prisma queries below. JSON-field reads come
// back as `Prisma.JsonValue` (which Array.isArray narrows), and each
// entry's `qty` field can be NaN/missing on corrupted rows — defensive
// numeric guard keeps the cron from throwing on bad data.

function sumInventoryQty(inv: unknown): number {
  if (!Array.isArray(inv)) return 0;
  return (inv as Array<{ qty: number }>).reduce((s, e) => s + (typeof e.qty === 'number' ? e.qty : 0), 0);
}

function sumNonFrozenInventoryQty(inv: unknown): number {
  if (!Array.isArray(inv)) return 0;
  return (inv as Array<{ storage: string; qty: number }>)
    .filter(e => e.storage !== 'Frozen')
    .reduce((s, e) => s + (typeof e.qty === 'number' ? e.qty : 0), 0);
}

// ── Data Quality Checks ──

export async function runDataQualityChecks(): Promise<DataQualityReport> {
  const today = new Date().toISOString().slice(0, 10);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);

  // Batches with cook date in the past and stock > 0 at a non-Frozen
  // storage (possibly forgotten). Frozen entries legitimately sit in stock
  // for weeks. Unified-batch model means we filter on the inventory JSON
  // array in JS (Prisma can't query into JSONB array elements without raw
  // SQL); pre-filter by `cookDate < today` to keep the candidate pool
  // small, then post-filter in memory. ~1.3k batches is well within
  // budget for a daily cron.
  const staleBatchCandidates = await prisma.batch.findMany({
    where: { cookDate: { lt: today, not: null } },
    select: { id: true, name: true, cookDate: true, inventory: true, services: true },
    take: 100,
  });
  const staleBatchesFiltered = staleBatchCandidates
    .filter(b => {
      // Must have stock at a non-Frozen storage.
      if (sumNonFrozenInventoryQty(b.inventory) <= 0) return false;
      // No future services
      const services = b.services as Array<{ date: string }> | null;
      if (!services || !Array.isArray(services)) return true;
      return !services.some(s => s.date >= today);
    })
    .map(b => ({
      id: b.id,
      name: b.name,
      cookDate: b.cookDate,
      // "stock" surfaces total non-Frozen liters — same semantic as the
      // old scalar `b.stock` field on rows the legacy query returned.
      stock: sumNonFrozenInventoryQty(b.inventory),
    }))
    .slice(0, 20);

  // Recipes with timesServed=0 older than 30 days
  const unusedRecipes = await prisma.recipe.findMany({
    where: { timesServed: 0, createdAt: { lt: thirtyDaysAgo } },
    select: { id: true, name: true, createdAt: true },
    take: 20,
  });

  // Unprocessed feedback older than 7 days
  const staleFeedback = await prisma.feedback.findMany({
    where: { processed: false, timestamp: { lt: sevenDaysAgo } },
    select: { id: true, type: true, text: true, timestamp: true },
    take: 20,
  });

  // Missing guest counts for next 7 weekdays.
  //
  // Guest.day stores weekday short names ('Mon'..'Sun'), not ISO dates.
  // The previous version queried Guest.day with ISO date strings and
  // always returned 0 rows, then reported every future weekday as
  // "missing" — flooding insights with false positives. We compare
  // against the weekday name and use the ISO date only for the
  // human-readable insight body.
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
  const futureDayPairs: { weekday: string; iso: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() + i * 86400000);
    if (d.getDay() === 0) continue; // Skip Sunday — restaurant closed
    futureDayPairs.push({
      weekday: WEEKDAY_NAMES[d.getDay()],
      iso: d.toISOString().slice(0, 10),
    });
  }
  const futureWeekdays = futureDayPairs.map(p => p.weekday);
  const existingGuests = await prisma.guest.findMany({
    where: { day: { in: futureWeekdays } },
    select: { day: true, location: true, lunch: true, dinner: true },
  });
  const guestDaySet = new Set(existingGuests
    .filter(g => g.lunch > 0 || g.dinner > 0)
    .map(g => `${g.location}:${g.day}`));
  const missingGuestDays = futureDayPairs.flatMap(({ weekday, iso }) =>
    ['west', 'centraal']
      .filter(loc => !guestDaySet.has(`${loc}:${weekday}`))
      .map(loc => `${loc}:${iso}`)
  );

  // Finance sync gaps — check last 7 days
  const recentRevenue = await prisma.dailyRevenue.findMany({
    where: { date: { gte: sevenDaysAgo } },
    select: { date: true, location: true },
  });
  const revDaySet = new Set(recentRevenue.map(r => `${r.location}:${r.date}`));
  const revDays: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() - i * 86400000);
    if (d.getDay() === 0) continue; // Skip Sunday
    revDays.push(d.toISOString().slice(0, 10));
  }
  const financeSyncGaps = revDays.flatMap(day =>
    ['west', 'centraal']
      .filter(loc => !revDaySet.has(`${loc}:${day}`))
      .map(loc => `${loc}:${day}`)
  );

  // Batches with stock > 0 but no services assigned. Same JS-side filter
  // story as staleBatches above — over-fetch with `take: 200` since we
  // can't pre-filter on stock>0 against the JSONB inventory array, then
  // post-filter + slice(20).
  const orphanCandidates = await prisma.batch.findMany({
    select: { id: true, name: true, inventory: true, services: true },
    take: 200,
  });
  const orphanBatches = orphanCandidates
    .filter(b => {
      if (sumInventoryQty(b.inventory) <= 0) return false;
      const services = b.services as unknown[];
      return !services || !Array.isArray(services) || services.length === 0;
    })
    .map(b => ({
      id: b.id,
      name: b.name,
      // "stock" surfaces total liters across all entries (any storage).
      stock: sumInventoryQty(b.inventory),
    }))
    .slice(0, 20);

  return {
    staleBatches: staleBatchesFiltered,
    unusedRecipes,
    staleFeedback,
    missingGuestDays,
    financeSyncGaps,
    batchesWithoutServices: orphanBatches,
  };
}

// ── Telemetry Aggregation ──

export async function aggregateTelemetry(hours = 24): Promise<TelemetrySummary> {
  const since = new Date(Date.now() - hours * 3600000);

  const [errors, screenViews, apiPerf, featureUsage, uniqueUsersResult, totalEventsResult] = await Promise.all([
    // Error summary
    prisma.$queryRaw<Array<{ name: string; count: number; last_seen: Date }>>`
      SELECT name, COUNT(*)::int as count, MAX(timestamp) as last_seen
      FROM telemetry_event WHERE type = 'error' AND timestamp > ${since}
      GROUP BY name ORDER BY count DESC LIMIT 20
    `,
    // Screen usage
    prisma.$queryRaw<Array<{ name: string; views: number; avg_duration: number | null }>>`
      SELECT name, COUNT(*)::int as views,
             AVG((data->>'duration')::float) as avg_duration
      FROM telemetry_event WHERE type = 'screen_view' AND timestamp > ${since}
      GROUP BY name ORDER BY views DESC
    `,
    // API performance
    prisma.$queryRaw<Array<{ name: string; calls: number; avg_ms: number; max_ms: number; errors: number }>>`
      SELECT name, COUNT(*)::int as calls,
             AVG((data->>'duration')::float) as avg_ms,
             MAX((data->>'duration')::float) as max_ms,
             COUNT(*) FILTER (WHERE (data->>'statusCode')::int >= 500)::int as errors
      FROM telemetry_event WHERE type = 'api_call' AND timestamp > ${since}
      GROUP BY name ORDER BY avg_ms DESC LIMIT 20
    `,
    // Feature usage
    prisma.$queryRaw<Array<{ name: string; uses: number }>>`
      SELECT name, COUNT(*)::int as uses
      FROM telemetry_event WHERE type = 'feature_use' AND timestamp > ${since}
      GROUP BY name ORDER BY uses DESC
    `,
    // Unique users
    prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(DISTINCT user_id)::int as count
      FROM telemetry_event WHERE timestamp > ${since} AND user_id IS NOT NULL
    `,
    // Total events
    prisma.$queryRaw<Array<{ count: number }>>`
      SELECT COUNT(*)::int as count FROM telemetry_event WHERE timestamp > ${since}
    `,
  ]);

  return {
    errors: errors.map(e => ({ ...e, last_seen: String(e.last_seen) })),
    screenViews,
    apiPerf,
    featureUsage,
    uniqueUsers: uniqueUsersResult[0]?.count ?? 0,
    totalEvents: totalEventsResult[0]?.count ?? 0,
  };
}

// ── Claude API Analysis ──

const SYSTEM_PROMPT = `You are an app quality analyst for "De Sering Food Planner", a food planning web app used by a community kitchen organization in Amsterdam (~57 staff + volunteers). The app manages:
- Batches of food (soups, mains, desserts) with lifecycle: PLANNED → COOKED → SERVING → DONE. Each batch has an \`inventory\` array — entries shaped {loc, storage, qty, cookDate} — so a single batch can hold stock across multiple locations and storage types simultaneously. Pending transfers between locations live in a separate \`shipments\` array on the batch.
- Guest counts per location (Sering West, Sering Centraal) per meal (lunch, dinner)
- Recipes with ingredients, ratings, and cost tracking
- Ingredient ordering with Hanos supplier integration
- Finance tracking from Tebi POS system
- Two locations: "west" (HQ, larger) and "centraal" (newer, growing). The \`stock\` field in the data quality reports below is a sum across inventory entries — non-Frozen for stale batches; total across all entries for orphan batches.

Your job: analyze telemetry data and data quality checks, then produce actionable insights for the developer/maintainer. Each insight must be a JSON object with:
- "category": one of "bug", "ux", "data_quality", "performance", "suggestion"
- "severity": "critical" (needs immediate attention), "warning" (should fix soon), "info" (nice to know)
- "title": short summary (max 100 chars)
- "body": detailed explanation with evidence from the data. Include specific numbers, endpoints, or screen names.
- "data": optional object with supporting metrics

Focus on:
1. Recurring frontend/backend errors (patterns, not one-offs)
2. Screens or features that are never/rarely used (possible UX issues or dead code)
3. Slow API endpoints (>500ms average is concerning, >1000ms is critical)
4. Data inconsistencies (stale batches, missing guest counts, unprocessed feedback)
5. Patterns suggesting user confusion (rapid screen switching, repeated errors on same screen)

Be specific and actionable. Don't include filler insights. If everything looks healthy, return fewer insights rather than inventing problems. Return ONLY a JSON array of insight objects, no other text.`;

export async function generateInsights(): Promise<number> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('ANTHROPIC_API_KEY not set, skipping AI analysis');
    return 0;
  }

  const model = process.env.AI_ANALYSIS_MODEL || 'claude-sonnet-4-6';

  const [telemetry, dataQuality] = await Promise.all([
    aggregateTelemetry(24),
    runDataQualityChecks(),
  ]);

  // Skip if there's essentially no data
  if (telemetry.totalEvents === 0 && telemetry.errors.length === 0) {
    // Still run data quality checks through AI if there are issues
    const hasDataIssues = dataQuality.staleBatches.length > 0 ||
      dataQuality.staleFeedback.length > 0 ||
      dataQuality.missingGuestDays.length > 0 ||
      dataQuality.batchesWithoutServices.length > 0;
    if (!hasDataIssues) {
      console.log('AI analysis: no telemetry data and no data quality issues, skipping');
      return 0;
    }
  }

  const userMessage = `Here is the telemetry and data quality report for the last 24 hours:

## Telemetry Summary
- Total events: ${telemetry.totalEvents}
- Unique users: ${telemetry.uniqueUsers}

### Errors (${telemetry.errors.length} unique)
${JSON.stringify(telemetry.errors, null, 2)}

### Screen Views
${JSON.stringify(telemetry.screenViews, null, 2)}

### API Performance (sorted by avg response time)
${JSON.stringify(telemetry.apiPerf, null, 2)}

### Feature Usage
${JSON.stringify(telemetry.featureUsage, null, 2)}

## Data Quality Issues
### Stale Batches (cook date past, still has stock, no future services): ${dataQuality.staleBatches.length}
${JSON.stringify(dataQuality.staleBatches.slice(0, 10), null, 2)}

### Unused Recipes (0 times served, older than 30 days): ${dataQuality.unusedRecipes.length}
${JSON.stringify(dataQuality.unusedRecipes.slice(0, 10), null, 2)}

### Unprocessed Feedback (older than 7 days): ${dataQuality.staleFeedback.length}
${JSON.stringify(dataQuality.staleFeedback.slice(0, 5), null, 2)}

### Missing Guest Counts (next 7 days): ${dataQuality.missingGuestDays.length}
${dataQuality.missingGuestDays.join(', ') || 'none'}

### Finance Sync Gaps (last 7 days): ${dataQuality.financeSyncGaps.length}
${dataQuality.financeSyncGaps.join(', ') || 'none'}

### Batches Without Services (has stock but no meal assignments): ${dataQuality.batchesWithoutServices.length}
${JSON.stringify(dataQuality.batchesWithoutServices.slice(0, 10), null, 2)}

Analyze this data and return insights as a JSON array.`;

  // Dynamic import to avoid requiring the SDK when not needed
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text : '';
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.error('AI analysis: response did not contain valid JSON array');
    console.error('Response:', text.slice(0, 500));
    return 0;
  }

  let insights: ParsedInsight[];
  try {
    insights = JSON.parse(jsonMatch[0]);
  } catch (e: unknown) {
    console.error('AI analysis: failed to parse JSON:', errMsg(e));
    return 0;
  }

  // Validate and store insights
  const validCategories = new Set(['bug', 'ux', 'data_quality', 'performance', 'suggestion']);
  const validSeverities = new Set(['critical', 'warning', 'info']);
  let stored = 0;

  for (const insight of insights) {
    if (!insight.title || !insight.body) continue;
    const category = validCategories.has(insight.category) ? insight.category : 'suggestion';
    const severity = validSeverities.has(insight.severity) ? insight.severity : 'info';

    await prisma.aiInsight.create({
      data: {
        category,
        severity,
        title: insight.title.slice(0, 200),
        body: insight.body,
        data: (insight.data || {}) as unknown as import('@prisma/client').Prisma.InputJsonValue,
        status: 'new',
      },
    });
    stored++;
  }

  console.log(`AI analysis complete: ${stored} insights stored`);
  return stored;
}

// ── Telemetry Cleanup ──

export async function cleanupOldTelemetry(daysToKeep = 90): Promise<number> {
  const cutoff = new Date(Date.now() - daysToKeep * 86400000);
  const { count } = await prisma.telemetryEvent.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });
  return count;
}
