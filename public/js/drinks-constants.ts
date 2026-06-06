// ─────────────────────────────────────────────────────────────────────────────
// DRINKS — shared frontend constants (enums from DRINKS_DOMAIN §6).
// Frontend constants for now; in-app editable lists are a future enhancement
// (see DECISIONS.md [m2]). Shared by the drinks screen sub-modules so each one
// doesn't import the big drinks.ts just for a dropdown list.
// ─────────────────────────────────────────────────────────────────────────────

export const DRINK_LOCATIONS: { key: 'west' | 'centraal'; label: string }[] = [
  { key: 'west', label: 'West' },
  { key: 'centraal', label: 'Centraal' },
];

export interface GlassType { name: string; volumeMl: number }
export const DRINK_GLASS_TYPES: GlassType[] = [
  { name: 'Beerglass 25', volumeMl: 250 },
  { name: 'Beerglass 33', volumeMl: 330 },
  { name: 'Waterglass', volumeMl: 250 },
  { name: 'Cocktail glass', volumeMl: 330 },
  { name: 'Tumbler', volumeMl: 210 },
  { name: 'Wine glass - small', volumeMl: 120 },
  { name: 'Cappucino glass', volumeMl: 160 },
  { name: 'Americano glass', volumeMl: 250 },
  { name: 'Pitcher', volumeMl: 1000 },
  { name: 'Wine bottle (750)', volumeMl: 750 },
  { name: 'Wine bottle (1000)', volumeMl: 1000 },
];

export const DRINK_GARNISHES: string[] = [
  'Ice', 'Straw', 'Lemon slice', 'Lime slice', 'Grapefruit slice', 'Orange slice',
  'Smoked salt', 'Salt', 'Foam', 'Coffee beans', 'Lavender seeds', 'Earl Grey Tea',
  'Star anise', 'Fresh herbs',
];

export const DRINK_CHARACTERISTICS: string[] = [
  'Acidic / Zesty / Crispy', 'Sweet', 'Jam / Sweet', 'Sour', 'Light', 'Heavy',
  'Green / Mineral', 'Earthy / Herbal', 'Tannine', 'Salty', 'Bubbles', 'Bitter',
  'Smokey', 'Citrusy', 'Fruity', 'Herbal',
];

export const DRINK_SERVING_TEMPS: string[] = [
  'Freezing', 'Cold', 'Cold (strained, no ice)', 'Cold (strained, on ice)',
  'Cold (pour over ice)', 'Room temperature', 'Warm', 'Hot',
  'Wine-cooler lower', 'Wine-cooler middle', 'Wine-cooler top',
];

export const DRINK_WRITEOFF_REASONS: { key: string; label: string }[] = [
  { key: 'breakage', label: 'Breakage' },
  { key: 'spillage', label: 'Spillage' },
  { key: 'expired', label: 'Expired' },
  { key: 'staff-drink', label: 'Staff drink' },
  { key: 'comp', label: 'Comp / on the house' },
  { key: 'other', label: 'Other' },
];

export interface DrinkCategoryDef { key: string; label: string; subtypes: string[] }

export const DRINK_CATALOGUE_CATEGORIES: DrinkCategoryDef[] = [
  { key: 'beer', label: 'Beer', subtypes: ['lager', 'pilsner', 'IPA', 'pale ale', 'white', 'blond', 'porter', 'weizen', '0.0'] },
  { key: 'wine', label: 'Wine', subtypes: ['white', 'red', 'rose', 'orange', 'bubbles', 'cider', '0.0'] },
  { key: 'spirits', label: 'Spirits', subtypes: ['vodka', 'gin', 'rum', 'white rum', 'tequila', 'mezcal', 'bourbon', 'liqueur', 'salmari', 'sake', 'NA-aperitif'] },
  { key: 'soft', label: 'Soft drinks', subtypes: ['cola', 'lemonade', 'soda', 'juice', 'water', 'mate'] },
  { key: 'coffee-tea-stock', label: 'Coffee & tea', subtypes: ['beans', 'oat milk', 'tea', 'chai', 'decaf'] },
  { key: 'consumables', label: 'Consumables', subtypes: ['straws', 'filters', 'cups', 'ice'] },
  { key: 'glassware', label: 'Glassware', subtypes: ['glasses', 'cups', 'bottles'] },
];

export const DRINK_RECIPE_CATEGORIES: DrinkCategoryDef[] = [
  { key: 'cocktail', label: 'Cocktail', subtypes: ['classic mixed', 'premix'] },
  { key: 'homemade-na', label: 'Homemade non-alc', subtypes: ['ice tea', 'lemonade', 'kombucha', 'spritz'] },
  { key: 'coffee-drink', label: 'Coffee drink', subtypes: ['espresso', 'milk', 'filter', 'tea', 'chai'] },
  { key: 'building-block', label: 'Building block', subtypes: ['syrup', 'super-juice', 'infusion', 'tea-base', 'kombucha-base'] },
];

/** Categories whose items are not sold directly (no serving formats / not on
 *  service cards). */
export const NON_SELLABLE_CATEGORIES = new Set(['consumables', 'glassware', 'coffee-tea-stock', 'building-block']);

/** Look up a category label across catalogue + recipe definitions. */
export function drinkCategoryLabel(key: string): string {
  const all = [...DRINK_CATALOGUE_CATEGORIES, ...DRINK_RECIPE_CATEGORIES];
  return all.find(c => c.key === key)?.label ?? key;
}
