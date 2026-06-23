// ─────────────────────────────────────────────────────────────────────────────
// NOTION SHIFTS — reads the planned-shift roster ("Sering Shifts" Notion DB)
// for the live dashboard's labour block. I/O only; the maths lives in
// lib/labour.ts. Degrades gracefully: returns [] (never throws) when the
// integration isn't configured or Notion errors, so the dashboard just shows
// "labour not available" instead of breaking.
// ─────────────────────────────────────────────────────────────────────────────

import { Client } from '@notionhq/client';
import { CONFIG } from './config';
import { orgForNotionVenue, parseHm, type PlannedShift } from './labour';

export function shiftsConfigured(): boolean {
  return !!(CONFIG.NOTION_TOKEN && CONFIG.NOTION_SHIFTS_DATA_SOURCE_ID);
}

let cachedClient: Client | null = null;
function notion(): Client {
  if (!cachedClient) cachedClient = new Client({ auth: CONFIG.NOTION_TOKEN });
  return cachedClient;
}

// Defensive Notion property extractors — the roster is part free-text.
interface NotionProp {
  rich_text?: { plain_text?: string }[];
  title?: { plain_text?: string }[];
  select?: { name?: string } | null;
}
function propText(p: NotionProp | undefined): string {
  if (!p) return '';
  const arr = p.rich_text || p.title;
  return Array.isArray(arr) ? arr.map((t) => t?.plain_text || '').join('').trim() : '';
}
function propSelect(p: NotionProp | undefined): string {
  return p?.select?.name?.trim() || '';
}

// Short cache: the roster is PLANNED (rarely edited mid-service), so the
// dashboard's ~60s polling shouldn't re-hit Notion each time. Single-replica
// app, so a module-level Map is fine.
const shiftsCache = new Map<string, { at: number; shifts: PlannedShift[] }>();
const SHIFTS_TTL_MS = 10 * 60 * 1000;

// Real shifts (Kind=shift, Status != reject) for the given Amsterdam business
// day, mapped to dashboard orgs with parsed start/end minutes. Open (unfilled)
// shifts are included — they're still scheduled labour.
export async function getPlannedShiftsForDate(date: string): Promise<PlannedShift[]> {
  if (!shiftsConfigured()) return [];
  const cached = shiftsCache.get(date);
  if (cached && Date.now() - cached.at < SHIFTS_TTL_MS) return cached.shifts;
  try {
    const out: PlannedShift[] = [];
    let cursor: string | undefined;
    do {
      const query = {
        data_source_id: CONFIG.NOTION_SHIFTS_DATA_SOURCE_ID,
        filter: {
          and: [
            { property: 'Date', date: { equals: date } },
            { property: 'Kind', select: { equals: 'shift' } },
          ],
        },
        start_cursor: cursor,
        page_size: 100,
      };
      const res = await notion().dataSources.query(query as Parameters<Client['dataSources']['query']>[0]);
      for (const page of res.results) {
        const props = (page as { properties?: Record<string, NotionProp> }).properties || {};
        if (propSelect(props.Status) === 'reject') continue;
        const org = orgForNotionVenue(propSelect(props.Venue));
        if (!org) continue;
        const startMin = parseHm(propText(props.Start));
        const endMin = parseHm(propText(props.End));
        if (startMin == null || endMin == null) continue;
        out.push({ org, role: propText(props.Role), person: propText(props.Person), startMin, endMin });
      }
      cursor = res.has_more ? (res.next_cursor || undefined) : undefined;
    } while (cursor);
    shiftsCache.set(date, { at: Date.now(), shifts: out });
    return out;
  } catch {
    return cached?.shifts ?? []; // serve stale on error if we have it, else empty
  }
}
