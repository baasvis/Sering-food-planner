// Unit tests for the Notion-block → teaching-guide-markdown converter (pure).

const { richTextToMarkdown, blocksToGuideMarkdown } = require('../lib/notion-markdown');

function span(text: string, ann?: object) {
  return { plain_text: text, annotations: ann || {} };
}
function para(text: string) {
  return { type: 'paragraph', paragraph: { rich_text: [span(text)] } };
}
function toggle(heading: string, children: object[]) {
  return { type: 'toggle', toggle: { rich_text: [span(heading)] }, _children: children };
}

describe('richTextToMarkdown', () => {
  it('applies bold and italic annotations', () => {
    expect(richTextToMarkdown([span('plain '), span('bold', { bold: true })])).toBe('plain **bold**');
    expect(richTextToMarkdown([span('x', { italic: true })])).toBe('*x*');
  });
  it('returns an empty string for no spans', () => {
    expect(richTextToMarkdown([])).toBe('');
    expect(richTextToMarkdown(undefined)).toBe('');
  });
});

describe('blocksToGuideMarkdown', () => {
  it('converts top-level toggles into ## sections', () => {
    const r = blocksToGuideMarkdown([
      toggle('1. First', [para('alpha body')]),
      toggle('2. Second', [para('beta body')]),
    ]);
    expect(r.sectionCount).toBe(2);
    expect(r.markdown).toContain('## 1. First');
    expect(r.markdown).toContain('alpha body');
    expect(r.markdown).toContain('## 2. Second');
    expect(r.warnings).toEqual([]);
  });

  it('reports sectionCount 0 when the page has no toggles', () => {
    const r = blocksToGuideMarkdown([para('just a paragraph')]);
    expect(r.sectionCount).toBe(0);
  });

  it('flags unsupported block types as warnings', () => {
    const r = blocksToGuideMarkdown([toggle('S', [{ type: 'image', image: {} }])]);
    expect(r.warnings.some((w: string) => w.includes('image'))).toBe(true);
  });

  it('downgrades an in-body heading to ### so it adds no spurious section', () => {
    const r = blocksToGuideMarkdown([
      toggle('S', [{ type: 'heading_2', heading_2: { rich_text: [span('Sub')] } }]),
    ]);
    expect(r.sectionCount).toBe(1);
    expect(r.markdown).toContain('### Sub');
  });

  it('renders bulleted list items', () => {
    const r = blocksToGuideMarkdown([
      toggle('S', [
        { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [span('one')] } },
        { type: 'bulleted_list_item', bulleted_list_item: { rich_text: [span('two')] } },
      ]),
    ]);
    expect(r.markdown).toContain('- one');
    expect(r.markdown).toContain('- two');
  });
});
