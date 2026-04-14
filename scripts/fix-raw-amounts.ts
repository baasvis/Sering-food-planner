/**
 * One-time script: fix raw amounts in v2 recipes.
 *
 * During migration the "cooked" column (80% of raw) was accidentally used as
 * rawAmount.  This script pulls the real raw amounts from the legacy Google
 * Sheets and updates the DB.
 *
 * Usage:
 *   npx tsx scripts/fix-raw-amounts.ts --dry-run   # preview changes
 *   npx tsx scripts/fix-raw-amounts.ts              # apply changes
 */

import { PrismaClient } from '@prisma/client';
import { calcRecipeCost } from '../lib/db';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

// ── helpers ─────────────────────────────────────────────────────────────────

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let inQuote = false;
    let field = '';
    for (const c of line) {
      if (c === '"') { inQuote = !inQuote; continue; }
      if (c === ',' && !inQuote) { fields.push(field); field = ''; continue; }
      field += c;
    }
    fields.push(field);
    rows.push(fields);
  }
  return rows;
}

interface SheetIngredient {
  name: string;
  unit: string;
  rawAmount: number;
  cookedAmount: number | null;
}

async function fetchSheetIngredients(sheetId: string): Promise<SheetIngredient[]> {
  const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&range=J6:N80`;
  const resp = await fetch(url);
  const rows = parseCSV(await resp.text());
  const result: SheetIngredient[] = [];

  for (const fields of rows) {
    const name = (fields[0] || '').trim();
    if (!name) continue;
    const rawStr = (fields[2] || '').replace(',', '.');
    const cookedStr = (fields[3] || '').replace(',', '.');
    const rawAmt = parseFloat(rawStr) || 0;
    const cookedAmt = parseFloat(cookedStr) || 0;
    if (rawAmt <= 0 && cookedAmt <= 0) continue;
    result.push({
      name: name.toLowerCase(),
      unit: fields[1] || 'Grams',
      rawAmount: rawAmt,
      cookedAmount: cookedAmt > 0 ? cookedAmt : null,
    });
  }
  return result;
}

function calcVolume(ingredients: Array<{ rawAmount: number; cookedAmount: number | null; unit: string }>): number {
  let totalML = 0;
  for (const ing of ingredients) {
    const amt = ing.cookedAmount ?? ing.rawAmount;
    if (!amt) continue;
    switch (ing.unit) {
      case 'Kilos': case 'Liters': totalML += amt * 1000; break;
      case 'ML': case 'Grams': default: totalML += amt; break;
    }
  }
  return Math.round(totalML) / 1000;
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '=== DRY RUN ===' : '=== APPLYING CHANGES ===');
  console.log();

  const recipes = await prisma.recipe.findMany({
    where: { legacySheetId: { not: null } },
    include: {
      ingredients: {
        orderBy: { sortOrder: 'asc' },
        include: { ingredient: { select: { name: true } } },
      },
    },
    orderBy: { name: 'asc' },
  });

  let recipesUpdated = 0;
  let rowsUpdated = 0;
  let recipesSkipped = 0;
  let recipesFailed = 0;

  for (const recipe of recipes) {
    if (!recipe.legacySheetId || recipe.ingredients.length === 0) {
      recipesSkipped++;
      continue;
    }

    try {
      const sheetIngs = await fetchSheetIngredients(recipe.legacySheetId);
      const changes: Array<{ name: string; oldRaw: number; newRaw: number; unit: string }> = [];

      for (const dbIng of recipe.ingredients) {
        const dbName = (dbIng.ingredient?.name || '').toLowerCase().trim();
        if (!dbName) continue;

        const match = sheetIngs.find(
          si => si.name === dbName || si.name.includes(dbName) || dbName.includes(si.name),
        );
        if (!match || match.rawAmount <= 0) continue;

        const diff = Math.abs(dbIng.rawAmount - match.rawAmount);
        const relDiff = diff / Math.max(dbIng.rawAmount, match.rawAmount, 1);
        if (relDiff < 0.01) continue; // close enough

        changes.push({ name: dbName, oldRaw: dbIng.rawAmount, newRaw: match.rawAmount, unit: dbIng.unit });

        if (!DRY_RUN) {
          await prisma.recipeIngredientRow.update({
            where: { id: dbIng.id },
            data: { rawAmount: match.rawAmount },
          });
        }
      }

      if (changes.length === 0) {
        recipesSkipped++;
        continue;
      }

      recipesUpdated++;
      rowsUpdated += changes.length;
      console.log(`--- ${recipe.name} (${changes.length} ingredients) ---`);
      for (const c of changes) {
        console.log(`  ${c.name}: ${c.oldRaw} → ${c.newRaw} ${c.unit}`);
      }

      // Recalculate volume
      if (!DRY_RUN) {
        const updatedIngs = await prisma.recipeIngredientRow.findMany({
          where: { recipeId: recipe.id },
          orderBy: { sortOrder: 'asc' },
        });
        const newVolume = calcVolume(updatedIngs);

        // Recalculate cost
        const newCost = await calcRecipeCost(
          updatedIngs.map(i => ({
            ingredientId: i.ingredientId,
            rawAmount: i.rawAmount,
            unit: i.unit,
            isFlexible: i.isFlexible,
          })),
          recipe.servingSize,
          newVolume > 0 ? newVolume : recipe.recipeVolume,
        );

        await prisma.recipe.update({
          where: { id: recipe.id },
          data: {
            recipeVolume: newVolume > 0 ? newVolume : undefined,
            costPerServing: newCost ?? undefined,
          },
        });

        console.log(`  → volume: ${recipe.recipeVolume}L → ${newVolume}L, cost: €${newCost?.toFixed(2) ?? '?'}/serving`);
      }

      console.log();

      // Rate limit Google Sheets
      await new Promise(r => setTimeout(r, 250));
    } catch (e: unknown) {
      recipesFailed++;
      console.error(`ERROR ${recipe.name}:`, e instanceof Error ? e.message : e);
    }
  }

  console.log('========== SUMMARY ==========');
  console.log(`Recipes updated: ${recipesUpdated}`);
  console.log(`Ingredient rows updated: ${rowsUpdated}`);
  console.log(`Recipes skipped (no changes): ${recipesSkipped}`);
  console.log(`Recipes failed: ${recipesFailed}`);
  if (DRY_RUN) console.log('\n(Dry run — no changes were written to the database)');

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
