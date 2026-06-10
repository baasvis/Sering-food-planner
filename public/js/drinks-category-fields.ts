// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — single source of truth for "which fields matter for this category".
// Both surfaces read from here, so adding/renaming a field for a category
// updates the EDIT FORM (drinks.ts → dynamicSectionsHtml) and the BAR CARD
// (drinks-service.ts → barCardHtml) together:
//   - `categorySpec(cat)`   → form behaviour: alcohol field, serve label/
//                             placeholder, and the extra info fields to render
//   - `categoryBarRows(d)`  → the label/value rows a bar card shows inline
// Keep each category's form fields and bar rows next to each other below.
// ─────────────────────────────────────────────────────────────────────────────

import type { Drink } from '@shared/types';

/** An extra per-category form field, stored in drink.info. Rendered with the
 *  id `df-info-<key>` and collected back by saveDrinkForm via the same spec. */
export interface DrinkInfoFieldDef {
  key: string;                       // DrinkInfo key
  label: string;
  input: 'text' | 'textarea' | 'check';
  col2?: boolean;                    // span both form columns
  placeholder?: string;
}

export interface DrinkCategorySpec {
  /** Show the Alcohol % input (and its default value for new drinks). */
  showAlcohol: boolean;
  defaultAbv: string;
  /** Label + placeholder for the how-to-serve textarea. */
  serveLabel: string;
  servePlaceholder: string;
  /** Legend + fields for the category's extra info section ([] = none). */
  infoLegend: string;
  infoFields: DrinkInfoFieldDef[];
}

const SERVE_DEFAULT = { serveLabel: 'How to serve', servePlaceholder: 'e.g. chilled, no ice, in a stemmed glass' };

const WINE_FIELDS: DrinkInfoFieldDef[] = [
  { key: 'producer', label: 'Producer / winery', input: 'text' },
  { key: 'region', label: 'Region', input: 'text' },
  { key: 'country', label: 'Country', input: 'text' },
  { key: 'vintage', label: 'Vintage', input: 'text' },
  { key: 'grapes', label: 'Grape(s)', input: 'text' },
  { key: 'soil', label: 'Soil', input: 'text' },
  { key: 'natural', label: 'Natural', input: 'check' },
  { key: 'bio', label: 'Bio / organic', input: 'check' },
  { key: 'profile', label: 'Flavour profile', input: 'text', col2: true, placeholder: 'e.g. dry, mineral, citrus' },
  { key: 'notes', label: 'Tasting notes', input: 'textarea', col2: true },
];

const SPECS: Record<string, Partial<DrinkCategorySpec>> = {
  wine: { showAlcohol: true, defaultAbv: '12', infoLegend: 'Wine info', infoFields: WINE_FIELDS },
  beer: { showAlcohol: true, defaultAbv: '5' },
  spirits: { showAlcohol: true, defaultAbv: '40' },
  soft: {
    showAlcohol: false,
    serveLabel: 'Serving &amp; pairing notes',
    servePlaceholder: 'e.g. tall glass over ice with lime — pairs with spicy or fried dishes',
  },
};

export function categorySpec(cat: string): DrinkCategorySpec {
  const s = SPECS[cat] || {};
  return {
    showAlcohol: s.showAlcohol ?? false,
    defaultAbv: s.defaultAbv ?? '0',
    serveLabel: s.serveLabel ?? SERVE_DEFAULT.serveLabel,
    servePlaceholder: s.servePlaceholder ?? SERVE_DEFAULT.servePlaceholder,
    infoLegend: s.infoLegend ?? 'Info',
    infoFields: s.infoFields ?? [],
  };
}

// ── Bar-card rows (kept beside the form specs above — update them together) ──

type BarRow = { k: string; v: string };
const row = (rows: BarRow[], k: string, v: string | null | undefined): void => {
  if (v) rows.push({ k, v });
};

/** The label/value lines a bar card shows for a drink, by category. Wine pulls
 *  from the WINE_FIELDS data above; the composed rows (Origin, Serve) join the
 *  underlying fields for readability on the floor. */
export function categoryBarRows(d: Drink): BarRow[] {
  const cat = d.category;
  const info = d.info || {};
  const rows: BarRow[] = [];
  if (cat === 'wine') {
    row(rows, 'Origin', [info.region, info.country].filter(Boolean).join(', '));
    row(rows, 'Grape', info.grapes);
    row(rows, 'Vintage', info.vintage);
    row(rows, 'Style', [info.natural ? 'natural' : '', info.bio ? 'bio' : ''].filter(Boolean).join(' · '));
    row(rows, 'Tasting', info.notes || info.profile);
    row(rows, 'Serve', d.servingTemp);
  } else if (cat === 'soft') {
    row(rows, 'Serve', d.servingTemp);
    row(rows, 'Serve with', d.serviceInstructions);
  } else if (cat === 'cocktail' || cat === 'homemade-na') {
    row(rows, 'Serve', [d.glass, d.serveVolumeMl ? d.serveVolumeMl + ' ml' : '', (d.garnish || []).join(', ')].filter(Boolean).join(' · '));
    row(rows, 'How to serve', d.serviceInstructions || (d.prepSteps || []).join(' · '));
  } else if (cat === 'coffee-drink') {
    row(rows, 'How to make', (d.prepSteps || []).join(' · ') || d.serviceInstructions);
    row(rows, 'Serve', [d.glass, d.servingTemp].filter(Boolean).join(' · '));
  } else {
    // beer / spirits / anything else
    row(rows, 'ABV', d.abv ? d.abv + '%' : '');
    row(rows, 'Serve', d.servingTemp);
    row(rows, 'Notes', d.serviceInstructions);
  }
  return rows;
}
