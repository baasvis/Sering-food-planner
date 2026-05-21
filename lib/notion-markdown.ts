// ─────────────────────────────────────────────────────────────────────────────
// NOTION-MARKDOWN — convert a Notion chunk page's block tree into the canonical
// `## `-delimited teaching-guide markdown the app stores and renders.
//
// Pure and dependency-free, so it is unit-testable. The async block fetching
// lives in lib/notion-sync.ts; this module only transforms fetched blocks.
// ─────────────────────────────────────────────────────────────────────────────

export interface RichSpan {
  plain_text: string;
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean };
}

// Loose mirror of a Notion API block — only the fields this module reads.
// The sync attaches a toggle's fetched children as `_children`.
export interface NotionBlock {
  type: string;
  id?: string;
  has_children?: boolean;
  _children?: NotionBlock[];
}

export interface GuideMarkdown {
  markdown: string;
  warnings: string[];
  sectionCount: number;
}

// Notion rich text → markdown, applying bold / italic / code annotations.
export function richTextToMarkdown(spans: RichSpan[] | undefined): string {
  if (!spans || !spans.length) return '';
  return spans.map(s => {
    let t = s.plain_text || '';
    if (!t) return '';
    const a = s.annotations || {};
    if (a.code) t = '`' + t + '`';
    if (a.bold) t = '**' + t + '**';
    if (a.italic) t = '*' + t + '*';
    return t;
  }).join('');
}

function plainText(spans: RichSpan[] | undefined): string {
  return (spans || []).map(s => s.plain_text || '').join('');
}

// A block's rich text lives under block[block.type].rich_text.
function richOf(b: NotionBlock): RichSpan[] {
  const c = (b as unknown as Record<string, { rich_text?: RichSpan[] }>)[b.type];
  return (c && c.rich_text) || [];
}

// Convert a flat list of body blocks (a toggle's children, or the intro) to
// markdown. Headings are downgraded to `### ` so an in-body heading can never
// create a spurious top-level `## ` section.
function bodyToMarkdown(blocks: NotionBlock[], warnings: string[]): string {
  const parts: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        parts.push(richTextToMarkdown(richOf(b)));
        break;
      case 'bulleted_list_item':
        parts.push('- ' + richTextToMarkdown(richOf(b)));
        break;
      case 'numbered_list_item':
        parts.push('1. ' + richTextToMarkdown(richOf(b)));
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        parts.push('### ' + plainText(richOf(b)));
        break;
      case 'quote':
        parts.push('> ' + richTextToMarkdown(richOf(b)));
        break;
      case 'divider':
        parts.push('---');
        break;
      case 'toggle':
        parts.push('### ' + plainText(richOf(b)));
        if (b._children && b._children.length) parts.push(bodyToMarkdown(b._children, warnings));
        break;
      default:
        warnings.push('unsupported block: ' + b.type);
    }
  }
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      const prevList = /^(- |1\. )/.test(parts[i - 1]);
      const curList = /^(- |1\. )/.test(parts[i]);
      out += (prevList && curList) ? '\n' : '\n\n';
    }
    out += parts[i];
  }
  return out;
}

// A chunk page's top-level blocks → canonical `## `-delimited guide markdown.
// Each top-level toggle is a section; content before the first toggle is intro.
export function blocksToGuideMarkdown(topBlocks: NotionBlock[]): GuideMarkdown {
  const warnings: string[] = [];
  const intro: NotionBlock[] = [];
  const sections: { heading: string; body: NotionBlock[] }[] = [];
  for (const b of topBlocks) {
    if (b.type === 'toggle') {
      sections.push({ heading: plainText(richOf(b)), body: b._children || [] });
    } else if (sections.length === 0) {
      intro.push(b);
    } else {
      sections[sections.length - 1].body.push(b);
    }
  }
  const out: string[] = [];
  const introMd = bodyToMarkdown(intro, warnings).trim();
  if (introMd) out.push(introMd);
  for (const s of sections) {
    out.push('## ' + s.heading + '\n\n' + bodyToMarkdown(s.body, warnings).trim());
  }
  return { markdown: out.join('\n\n').trim(), warnings, sectionCount: sections.length };
}
