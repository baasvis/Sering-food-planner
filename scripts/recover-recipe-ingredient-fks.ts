/**
 * recover-recipe-ingredient-fks.ts
 *
 * One-off recovery script for audit T19a damage. The pre-fix bulk POST
 * /api/ingredients did `deleteMany + createMany` which fired the
 * `ON DELETE SET NULL` trigger on `recipe_ingredients.ingredient_id`,
 * NULLing every recipe→ingredient pointer on every supplier import.
 *
 * Each recipe has a `versions[]` JSON column that snapshots its
 * ingredients at save time, including the original `ingredientId` per
 * row. This script walks the latest version snapshot per affected
 * recipe and restores the FK pointer if the target ingredient still
 * exists in the current Ingredient table.
 *
 * Usage:
 *   DATABASE_URL=<prod-or-staging-url> npx tsx scripts/recover-recipe-ingredient-fks.ts          # dry run (default)
 *   DATABASE_URL=<prod-or-staging-url> npx tsx scripts/recover-recipe-ingredient-fks.ts --apply  # actually update
 *
 * Output groups each NULLed row into one of:
 *   - RECOVERABLE      — version snapshot has the original ingredientId, target ingredient still exists
 *   - DELETED_TARGET   — snapshot exists but the target ingredient was deleted from the Ingredient table
 *   - NO_SNAPSHOT_ROW  — recipe has versions but no snapshot includes this row id (added after last version)
 *   - NO_VERSIONS      — recipe has never been versioned; nothing to recover from
 */

import { PrismaClient } from '@prisma/client';

interface VersionSnapshot {
  version: number;
  date: string;
  changedBy: string;
  ingredients: Array<{
    id: string;
    ingredientId: string | null;
    [k: string]: unknown;
  }>;
  notes: string;
}

type Outcome = 'RECOVERABLE' | 'DELETED_TARGET' | 'NO_SNAPSHOT_ROW' | 'NO_VERSIONS';

interface NullRow {
  id: string;
  recipeId: string;
}

interface Plan {
  rowId: string;
  recipeId: string;
  recipeName: string;
  outcome: Outcome;
  recoveredIngredientId: string | null;
  snapshotVersion: number | null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaClient();

  console.log(`Mode: ${apply ? 'APPLY (will mutate)' : 'DRY-RUN (safe)'}`);
  console.log(`DB:   ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ':***@')}\n`);

  // 1. Load every NULL-FK row.
  const nullRows: NullRow[] = await prisma.recipeIngredientRow.findMany({
    where: { ingredientId: null },
    select: { id: true, recipeId: true },
  });
  console.log(`Found ${nullRows.length} recipe_ingredients rows with ingredientId IS NULL`);
  if (nullRows.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // 2. Load every affected recipe in one query.
  const affectedRecipeIds = [...new Set(nullRows.map(r => r.recipeId))];
  const recipes = await prisma.recipe.findMany({
    where: { id: { in: affectedRecipeIds } },
    select: { id: true, name: true, versions: true },
  });
  const recipesById = new Map(recipes.map(r => [r.id, r]));

  // 3. Snapshot the current set of ingredient ids so we can detect
  //    DELETED_TARGET cases (snapshot's ingredientId no longer exists).
  const allIngredients = await prisma.ingredient.findMany({ select: { id: true } });
  const liveIngredientIds = new Set(allIngredients.map(i => i.id));

  // 4. Plan each row.
  const plans: Plan[] = nullRows.map(row => {
    const recipe = recipesById.get(row.recipeId);
    if (!recipe) {
      // shouldn't happen — FK from recipe_ingredients.recipe_id is CASCADE,
      // so the parent always exists when a row exists.
      return { rowId: row.id, recipeId: row.recipeId, recipeName: '<missing>', outcome: 'NO_VERSIONS', recoveredIngredientId: null, snapshotVersion: null };
    }
    const versions = (recipe.versions || []) as unknown as VersionSnapshot[];
    if (!Array.isArray(versions) || versions.length === 0) {
      return { rowId: row.id, recipeId: row.recipeId, recipeName: recipe.name, outcome: 'NO_VERSIONS', recoveredIngredientId: null, snapshotVersion: null };
    }
    // Walk newest-first.
    const sorted = [...versions].sort((a, b) => (b.version || 0) - (a.version || 0));
    for (const snap of sorted) {
      const match = (snap.ingredients || []).find(i => i.id === row.id);
      if (!match || !match.ingredientId) continue;
      if (!liveIngredientIds.has(match.ingredientId)) {
        return { rowId: row.id, recipeId: row.recipeId, recipeName: recipe.name, outcome: 'DELETED_TARGET', recoveredIngredientId: match.ingredientId, snapshotVersion: snap.version };
      }
      return { rowId: row.id, recipeId: row.recipeId, recipeName: recipe.name, outcome: 'RECOVERABLE', recoveredIngredientId: match.ingredientId, snapshotVersion: snap.version };
    }
    return { rowId: row.id, recipeId: row.recipeId, recipeName: recipe.name, outcome: 'NO_SNAPSHOT_ROW', recoveredIngredientId: null, snapshotVersion: null };
  });

  // 5. Report per-recipe summary.
  const byRecipe = new Map<string, Plan[]>();
  for (const p of plans) {
    const arr = byRecipe.get(p.recipeId) || [];
    arr.push(p);
    byRecipe.set(p.recipeId, arr);
  }

  const outcomes: Record<Outcome, number> = { RECOVERABLE: 0, DELETED_TARGET: 0, NO_SNAPSHOT_ROW: 0, NO_VERSIONS: 0 };
  for (const p of plans) outcomes[p.outcome]++;

  console.log('\n=== Per-recipe breakdown ===');
  for (const [recipeId, rows] of byRecipe) {
    const r = recipesById.get(recipeId);
    const counts = rows.reduce<Record<Outcome, number>>((acc, p) => { acc[p.outcome]++; return acc; }, { RECOVERABLE: 0, DELETED_TARGET: 0, NO_SNAPSHOT_ROW: 0, NO_VERSIONS: 0 });
    console.log(`  ${r?.name ?? '<missing>'} (${recipeId})`);
    for (const [outcome, n] of Object.entries(counts)) {
      if (n > 0) console.log(`    ${outcome}: ${n}`);
    }
  }

  console.log('\n=== Totals ===');
  for (const [outcome, n] of Object.entries(outcomes)) {
    console.log(`  ${outcome.padEnd(20)} ${n}`);
  }

  // 6. Apply (or report).
  const recoverable = plans.filter(p => p.outcome === 'RECOVERABLE');
  if (recoverable.length === 0) {
    console.log('\nNothing recoverable — all NULL FKs are in unrecoverable buckets.');
    await prisma.$disconnect();
    return;
  }

  if (!apply) {
    console.log(`\nDRY-RUN: would update ${recoverable.length} rows. Re-run with --apply to commit.`);
    await prisma.$disconnect();
    return;
  }

  console.log(`\nApplying ${recoverable.length} updates...`);
  let updated = 0;
  for (const p of recoverable) {
    await prisma.recipeIngredientRow.update({
      where: { id: p.rowId },
      data: { ingredientId: p.recoveredIngredientId },
    });
    updated++;
  }
  console.log(`Updated ${updated} rows.`);

  // 7. Re-check the post-state.
  const remaining = await prisma.recipeIngredientRow.count({ where: { ingredientId: null } });
  console.log(`Remaining NULL FKs after update: ${remaining}`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
