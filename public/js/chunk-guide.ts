// ─────────────────────────────────────────────────────────────────────────────
// CHUNK-GUIDE — split a chunk's teaching-guide markdown into sections.
//
// A teaching guide is one markdown string; its structure lives in the writing.
// Each `## ` heading starts a section. Collapsed, those section headlines ARE
// the teaching checklist (the handover calls it "the spine of the chunk").
// Pure and dependency-free, so it is trivially unit-testable.
// ─────────────────────────────────────────────────────────────────────────────

export interface GuideSection {
  heading: string;
  body: string;
}

export interface GuideParts {
  intro: string; // text before the first `## ` heading (always-open)
  sections: GuideSection[];
}

// Split on `## ` (H2) headings only — `### ` and deeper stay inside a section
// body. Text before the first H2 is the intro.
export function splitGuideSections(md: string): GuideParts {
  const intro: string[] = [];
  const raw: GuideSection[] = [];
  let current: GuideSection | null = null;

  for (const line of (md || '').split('\n')) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      current = { heading: m[1], body: '' };
      raw.push(current);
    } else if (current) {
      current.body += current.body ? '\n' + line : line;
    } else {
      intro.push(line);
    }
  }

  const sections = raw.map(s => ({
    heading: s.heading,
    // Drop a trailing `---` rule that sits between sections in the source.
    body: s.body.trim().replace(/\n+-{3,}\s*$/, '').trim(),
  }));
  return { intro: intro.join('\n').trim(), sections };
}
