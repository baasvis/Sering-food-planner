// ─────────────────────────────────────────────────────────────────────────────
// SEED: Toppings & bread recipes
// ─────────────────────────────────────────────────────────────────────────────
// Creates the "Aquafaba" ingredient (a free leftover product) and the two
// flagship count-mode recipes — Aioli and Slippurin Bread — transcribed from
// Darren's recipe sheets.
//
// Why a standalone script (not prisma/seed.js): prisma/seed.js only runs when a
// table is empty. These two recipes need to be added to an ALREADY-POPULATED
// recipes table (e.g. production after the Toppings & bread feature deploys).
//
// Idempotent — upserts by fixed id, so re-running is safe.
//
// Ingredient links are resolved by NAME at run time (ingredient ids differ
// between databases). Each ingredient lists candidate names; the first one that
// exists wins. Anything unmatched becomes a "flexible" recipe row and is logged
// so it can be linked by hand in the recipe editor.
//
// Usage:
//   node scripts/seed-toppings-recipes.js          # uses DATABASE_URL from .env
//   DATABASE_URL=<url> node scripts/seed-toppings-recipes.js
// ─────────────────────────────────────────────────────────────────────────────

try { require('dotenv').config(); } catch (_e) { /* dotenv optional */ }
const crypto = require('crypto');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// ── The Aquafaba ingredient — the liquid drained from cooked/canned
//    chickpeas. A free by-product, so it carries €0 cost. ──
const AQUAFABA = {
  id: 'ingredient-aquafaba',
  name: 'Aquafaba',
  category: 'Legumes & Proteins',
  types: ['Food'],
  unit: 'Grams',
  measureMode: 'weight',
  orderPrice: 0,
  orderUnitSize: 0,
  pricePer100: 0,
  allergens: '',
  notes: 'Leftover product — the liquid drained from cooked/canned chickpeas. Counted as €0 (free by-product).',
  active: true,
};

// ── Recipe definitions ────────────────────────────────────────────────────────
// `ingredients[].names` — candidate ingredient names, tried in order.
// `ingredients[].amount` is the quantity for the WHOLE base batch (outputCount).
const RECIPES = [
  {
    id: 'recipe-aioli',
    name: 'Aioli',
    type: 'Topping',
    yieldType: 'count',
    outputCount: 20,
    outputUnit: 'containers',
    seasonality: 'Year round',
    servingTemp: 'Cold',
    extraAllergens: ['Mustard'],
    ingredients: [
      { names: ['Aquafaba'], amount: 5760, unit: 'Grams' },
      { names: ['Apple Cider Vinegar', 'Apple cider vinegar'], amount: 720, unit: 'Grams' },
      { names: ['Lemon juice', 'Lemon Juice'], amount: 720, unit: 'Grams' },
      { names: ['Garlic (whole cloves)', 'Garlic cloves', 'Garlic'], amount: 960, unit: 'Grams' },
      { names: ['Salt'], amount: 288, unit: 'Grams' },
      { names: ['Dijon Mustard', 'Dijon mustard'], amount: 240, unit: 'Grams' },
      { names: ['Sunflower oil', 'Sunflower Oil'], amount: 21600, unit: 'ML' },
    ],
    prepSteps: [
      'Put all ingredients (apart from the oil) into a container and blend to bring together (~30 seconds).',
      'Slowly pour the oil into the mix while continuing to blend.',
    ],
  },
  {
    id: 'recipe-slippurin-bread',
    name: 'Slippurin Bread',
    type: 'Bread',
    yieldType: 'count',
    outputCount: 10,
    outputUnit: 'loaves',
    seasonality: 'Year round',
    servingTemp: 'Room temperature',
    extraAllergens: ['Gluten'],
    ingredients: [
      { names: ['Flour (white)', 'White Flour', 'White flour', 'Plain flour', 'Wheat flour'], amount: 4000, unit: 'Grams' },
      { names: ['Wholeweat Flour', 'Wholewheat Flour', 'Wholemeal Flour', 'Wholemeal flour'], amount: 2000, unit: 'Grams' },
      { names: ['active yeast', 'Active yeast', 'Dry yeast', 'Active dry yeast', 'Yeast'], amount: 2.5, unit: 'Grams' },
      { names: ['Salt'], amount: 80, unit: 'Grams' },
      { names: ['Water'], amount: 4000, unit: 'ML' },
    ],
    prepSteps: [
      'Mix with hands and ferment at room temperature for 6 to 8 hours.',
      'Put into molds and let it raise again.',
      'Put salt on top.',
      'Bake at 180 °C for 1 hour and 15-20 minutes.',
      'Expert overnight method: make the dough the night before and leave it in the walk-in for 12 hours. Next day take it out, do a stretch-and-fold, and another stretch-and-fold 2 hours later. Let the dough rest 1 hour, then shape individual loaves into tins. Bake with a bottom tray holding a big handful of ice cubes, ventilation on 3. After 10 minutes remove the water tray, set ventilation to 5 and finish the hour.',
    ],
  },
];

// Grams-equivalent of an amount. Grams/ML count 1:1; Kilos/Liters scale ×1000.
// Mirrors shared/units.ts toGrams() for the units these recipes use.
function toGrams(amount, unit) {
  if (unit === 'Kilos' || unit === 'Liters') return amount * 1000;
  return amount; // Grams, ML
}

async function main() {
  console.log(`Seeding toppings & bread recipes into ${process.env.DATABASE_URL ? 'the configured DATABASE_URL' : '(no DATABASE_URL set!)'}\n`);

  // 1. Upsert the Aquafaba ingredient.
  await prisma.ingredient.upsert({
    where: { id: AQUAFABA.id },
    create: AQUAFABA,
    update: AQUAFABA,
  });
  console.log(`✓ ingredient "${AQUAFABA.name}" (€0, ${AQUAFABA.category})`);

  // 2. Build a name → ingredient lookup (case-insensitive). Includes Aquafaba,
  //    which was just upserted.
  const dbIngredients = await prisma.ingredient.findMany({
    select: { id: true, name: true, pricePer100: true, allergens: true },
  });
  const byName = new Map();
  for (const ing of dbIngredients) byName.set(ing.name.toLowerCase().trim(), ing);

  const now = new Date().toISOString();

  for (const r of RECIPES) {
    const unmatched = [];
    const rows = r.ingredients.map((ing, i) => {
      let match = null;
      for (const n of ing.names) {
        const found = byName.get(n.toLowerCase().trim());
        if (found) { match = found; break; }
      }
      if (!match) unmatched.push(ing.names[0]);
      return {
        id: crypto.randomUUID(),
        recipeId: r.id,
        ingredientId: match ? match.id : null,
        sortOrder: i,
        rawAmount: ing.amount,
        cookedAmount: ing.amount,
        unit: ing.unit,
        // Unmatched → a flexible row labelled with the intended ingredient,
        // so the recipe still saves and reads cleanly.
        isFlexible: !match,
        flexCategory: null,
        flexLabel: match ? null : ing.names[0],
        suggestedNames: match ? [] : ing.names,
        _match: match, // local-only, stripped before write
      };
    });

    // Auto-allergens from the linked ingredients' allergen strings.
    const allergenSet = new Set();
    for (const row of rows) {
      if (row._match && row._match.allergens) {
        for (const a of row._match.allergens.split(',')) {
          const t = a.trim();
          if (t) allergenSet.add(t);
        }
      }
    }
    const autoAllergens = [...allergenSet].sort();

    // Cost per output unit = Σ(grams/100 × pricePer100) ÷ outputCount.
    let totalCost = 0;
    for (const row of rows) {
      if (!row._match) continue;
      totalCost += (toGrams(row.rawAmount, row.unit) / 100) * (row._match.pricePer100 || 0);
    }
    const costPerServing = r.outputCount > 0
      ? Math.round((totalCost / r.outputCount) * 100) / 100
      : null;

    const recipeData = {
      name: r.name,
      type: r.type,
      structure: '',
      seasonality: r.seasonality || '',
      servingTemp: r.servingTemp || '',
      servingSize: 280, // unused for count recipes; column is non-null
      recipeVolume: null,
      yieldType: r.yieldType,
      outputCount: r.outputCount,
      outputUnit: r.outputUnit,
      autoAllergens,
      extraAllergens: r.extraAllergens || [],
      costPerServing,
      prepSteps: r.prepSteps.map((text, idx) => ({ step: idx + 1, text })),
      coolingMethod: '',
      storageMethod: '',
      isComplete: true,
      createdBy: 'seed-script',
      updatedAt: now,
    };

    const rowData = rows.map(({ _match, ...row }) => row); // strip _match

    await prisma.$transaction(async (tx) => {
      // Replace child rows so a re-run doesn't duplicate them.
      await tx.recipeIngredientRow.deleteMany({ where: { recipeId: r.id } });
      await tx.recipe.upsert({
        where: { id: r.id },
        create: { id: r.id, createdAt: now, ...recipeData },
        update: recipeData,
      });
      await tx.recipeIngredientRow.createMany({ data: rowData });
    });

    const linked = rows.filter(x => x._match).length;
    console.log(`✓ recipe "${r.name}" — ${r.type}, makes ${r.outputCount} ${r.outputUnit}, ` +
      `€${costPerServing != null ? costPerServing.toFixed(2) : '—'} per ${r.outputUnit}, ` +
      `${linked}/${rows.length} ingredients linked`);
    if (unmatched.length > 0) {
      console.log(`  ⚠ not found in the ingredient DB — left as flexible rows, link them by hand: ${unmatched.join(', ')}`);
    }
  }

  console.log('\nDone.');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
