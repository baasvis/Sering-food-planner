// ─────────────────────────────────────────────────────────────────────────────
// NOTION-SYNC — pull the competency chunk library from Notion into Postgres.
//
// Notion is the source of truth for chunk content; this sync is one-way and the
// app is a read replica. Triggered by POST /api/competencies/sync-chunks and a
// daily cron. Upsert-only: a chunk removed from Notion is reported, never
// deleted (it may carry teaching history).
// ─────────────────────────────────────────────────────────────────────────────

import { Client } from '@notionhq/client';
import { CONFIG, errMsg } from './config';
import { prisma, withWriteLock } from './db';
import { blocksToGuideMarkdown, NotionBlock, RichSpan } from './notion-markdown';

export interface SyncReport {
  ok: boolean;
  synced: string[];
  flagged: { name: string; reason: string }[];
  error?: string;
}

export function notionConfigured(): boolean {
  return !!(CONFIG.NOTION_TOKEN && CONFIG.NOTION_CHUNKS_DATA_SOURCE_ID);
}

let cachedClient: Client | null = null;
function notion(): Client {
  if (!cachedClient) cachedClient = new Client({ auth: CONFIG.NOTION_TOKEN });
  return cachedClient;
}

// ── Notion property readers — defensive: a property may be absent or empty ──
function pTitle(p: unknown): string {
  const t = (p as { title?: RichSpan[] } | undefined)?.title;
  return Array.isArray(t) ? t.map(x => x.plain_text || '').join('') : '';
}
function pRichText(p: unknown): string {
  const t = (p as { rich_text?: RichSpan[] } | undefined)?.rich_text;
  return Array.isArray(t) ? t.map(x => x.plain_text || '').join('') : '';
}
function pSelect(p: unknown): string {
  return (p as { select?: { name?: string } | null } | undefined)?.select?.name || '';
}
function pMultiSelect(p: unknown): string[] {
  const m = (p as { multi_select?: { name: string }[] } | undefined)?.multi_select;
  return Array.isArray(m) ? m.map(x => x.name) : [];
}
function pNumber(p: unknown): number {
  const n = (p as { number?: number | null } | undefined)?.number;
  return typeof n === 'number' ? n : 0;
}
function pUrl(p: unknown): string | null {
  return (p as { url?: string | null } | undefined)?.url || null;
}

interface NotionPage { id: string; properties: Record<string, unknown>; }

async function queryAllPages(): Promise<NotionPage[]> {
  const out: NotionPage[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion().dataSources.query({
      data_source_id: CONFIG.NOTION_CHUNKS_DATA_SOURCE_ID,
      start_cursor: cursor,
      page_size: 100,
    });
    for (const r of res.results) {
      const page = r as unknown as NotionPage;
      if (page.id && page.properties) out.push(page);
    }
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

async function listChildren(blockId: string): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion().blocks.children.list({
      block_id: blockId, start_cursor: cursor, page_size: 100,
    });
    out.push(...(res.results as unknown as NotionBlock[]));
    cursor = res.has_more && res.next_cursor ? res.next_cursor : undefined;
  } while (cursor);
  return out;
}

// Fetch a page's top-level blocks, with each toggle's children attached.
async function fetchPageBlocks(pageId: string): Promise<NotionBlock[]> {
  const top = await listChildren(pageId);
  for (const b of top) {
    if (b.type === 'toggle' && b.id) b._children = await listChildren(b.id);
  }
  return top;
}

function chunkFields(props: Record<string, unknown>, teachingGuide: string) {
  return {
    name: pTitle(props['Name']) || '(untitled)',
    station: pSelect(props['Station']),
    locations: pMultiSelect(props['Location']),
    type: pSelect(props['Type']) || 'practical',
    goal: pRichText(props['Goal']),
    requiredFor: pMultiSelect(props['Required for']),
    prerequisites: [] as string[],
    deeperLink: pUrl(props['Deeper link']),
    teachingGuide,
    sortOrder: pNumber(props['Sort order']),
  };
}

export async function syncChunksFromNotion(): Promise<SyncReport> {
  if (!notionConfigured()) {
    return {
      ok: false, synced: [], flagged: [],
      error: 'Notion is not configured — set NOTION_TOKEN and NOTION_CHUNKS_DATA_SOURCE_ID.',
    };
  }

  let pages: NotionPage[];
  try {
    pages = await queryAllPages();
  } catch (e: unknown) {
    return { ok: false, synced: [], flagged: [], error: errMsg(e) };
  }

  const flagged: { name: string; reason: string }[] = [];
  const ready: { id: string; label: string; fields: ReturnType<typeof chunkFields> }[] = [];

  // Phase 1 — fetch + convert. Slow + network-bound, so no write lock here.
  for (const page of pages) {
    const name = pTitle(page.properties['Name']) || '(untitled)';
    try {
      const blocks = await fetchPageBlocks(page.id);
      const { markdown, warnings, sectionCount } = blocksToGuideMarkdown(blocks);
      if (sectionCount === 0) {
        flagged.push({ name, reason: 'no sections — the teaching guide needs at least one toggle' });
        continue;
      }
      const n = warnings.length;
      ready.push({
        id: page.id,
        label: n ? `${name} (${n} warning${n > 1 ? 's' : ''})` : name,
        fields: chunkFields(page.properties, markdown),
      });
    } catch (e: unknown) {
      flagged.push({ name, reason: errMsg(e) });
    }
  }

  // Phase 2 — upsert. The write lock is held only for the DB writes.
  const synced: string[] = [];
  try {
    await withWriteLock(async () => {
      for (const c of ready) {
        await prisma.chunk.upsert({
          where: { id: c.id },
          create: { id: c.id, ...c.fields },
          update: c.fields,
        });
        synced.push(c.label);
      }
    });
  } catch (e: unknown) {
    return { ok: false, synced, flagged, error: errMsg(e) };
  }
  return { ok: true, synced, flagged };
}
