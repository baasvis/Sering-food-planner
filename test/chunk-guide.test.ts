// Unit test for the chunk teaching-guide section splitter (pure function).

const { splitGuideSections } = require('../public/js/chunk-guide');

describe('splitGuideSections', () => {
  it('splits on ## headings, capturing intro and sections', () => {
    const md = 'Opening line.\n\n## 1. First\n\nbody one\n\n## 2. Second\n\nbody two';
    const r = splitGuideSections(md);
    expect(r.intro).toBe('Opening line.');
    expect(r.sections.length).toBe(2);
    expect(r.sections[0].heading).toBe('1. First');
    expect(r.sections[0].body).toBe('body one');
    expect(r.sections[1].heading).toBe('2. Second');
    expect(r.sections[1].body).toBe('body two');
  });

  it('has an empty intro when the guide starts with a heading', () => {
    const r = splitGuideSections('## Only\n\nbody');
    expect(r.intro).toBe('');
    expect(r.sections.length).toBe(1);
    expect(r.sections[0].heading).toBe('Only');
  });

  it('does not split on ### — deeper headings stay inside the body', () => {
    const r = splitGuideSections('## Top\n\ntext\n\n### Sub\n\nmore');
    expect(r.sections.length).toBe(1);
    expect(r.sections[0].body).toContain('### Sub');
  });

  it('strips a trailing --- separator from a section body', () => {
    const r = splitGuideSections('## A\n\nalpha\n\n---\n\n## B\n\nbeta');
    expect(r.sections[0].body).toBe('alpha');
    expect(r.sections[1].body).toBe('beta');
  });

  it('returns empty parts for empty input', () => {
    const r = splitGuideSections('');
    expect(r.intro).toBe('');
    expect(r.sections).toEqual([]);
  });
});
