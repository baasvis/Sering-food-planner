// One-shot sync: copy menu + guests data from PRODUCTION to STAGING.
// Production access is READ-ONLY. Staging is wiped and replaced.
// Run with: node scripts/sync-prod-to-staging.js

const { PrismaClient } = require('@prisma/client');

const PROD_URL = 'postgresql://postgres:dsGlThBYmipITDtgfAVDsBljhbvptouX@centerbeam.proxy.rlwy.net:20242/railway';
const STAGING_URL = 'postgresql://postgres:QXwFZbYaQhZeeWUqdFUjXCRVhQvEoLgv@shuttle.proxy.rlwy.net:52350/railway';

async function main() {
  const prod = new PrismaClient({ datasources: { db: { url: PROD_URL } } });
  const stag = new PrismaClient({ datasources: { db: { url: STAGING_URL } } });

  try {
    // ── READ from production via raw SQL (prod schema is older — no `generated` col)
    console.log('[1/5] Reading from production...');
    const prodBatches = await prod.$queryRawUnsafe(`
      SELECT id, name, type, stock, serving, storage, location,
             in_transit AS "inTransit",
             allergens, extra_allergens AS "extraAllergens",
             order_for AS "orderFor",
             cook_date AS "cookDate",
             recipe_sheet_id AS "recipeSheetId",
             recipe_volume AS "recipeVolume",
             recipe_ingredients AS "recipeIngredients",
             parent_id AS "parentId",
             note,
             services,
             created_at AS "createdAt",
             recipe_id AS "recipeId",
             actual_ingredients AS "actualIngredients",
             cook_notes AS "cookNotes",
             stock_deducted AS "stockDeducted"
      FROM batches
    `);
    const prodGuests = await prod.$queryRawUnsafe(`SELECT location, day, lunch, dinner FROM guests`);
    const prodCaterings = await prod.$queryRawUnsafe(`
      SELECT id, name, date, guest_count AS "guestCount", delivery_mode AS "deliveryMode",
             dishes, logistics_notes AS "logisticsNotes", created_at AS "createdAt"
      FROM caterings
    `);
    const prodGNW = await prod.$queryRawUnsafe(`
      SELECT monday_key AS "mondayKey", location, day, meal, count
      FROM guests_next_weeks
    `);
    console.log(`  read ${prodBatches.length} batches, ${prodGuests.length} guests, ${prodCaterings.length} caterings, ${prodGNW.length} next-week entries`);

    // ── Get staging recipe IDs so we can NULL stale recipeId references
    console.log('[2/5] Looking up staging recipe IDs...');
    const stagRecipes = await stag.$queryRawUnsafe(`SELECT id FROM recipes`);
    const stagRecipeIds = new Set(stagRecipes.map(r => r.id));
    console.log(`  staging has ${stagRecipeIds.size} recipes`);

    // ── Wipe staging tables (in FK-safe order)
    console.log('[3/5] Clearing staging menu data...');
    const del1 = await stag.batch.deleteMany();
    const del2 = await stag.catering.deleteMany();
    const del3 = await stag.transportItem.deleteMany();
    const del4 = await stag.guest.deleteMany();
    const del5 = await stag.guestsNextWeeks.deleteMany();
    console.log(`  deleted ${del1.count} batches, ${del2.count} caterings, ${del3.count} transport, ${del4.count} guests, ${del5.count} next-weeks`);

    // ── Transform & insert
    console.log('[4/5] Inserting into staging...');
    let nulledRecipeRefs = 0;
    const batchData = prodBatches.map(b => {
      const keepRecipeId = b.recipeId && stagRecipeIds.has(b.recipeId);
      if (b.recipeId && !keepRecipeId) nulledRecipeRefs++;
      return {
        ...b,
        recipeId: keepRecipeId ? b.recipeId : null,
        generated: false,
      };
    });
    if (batchData.length > 0) {
      // First insert without parentId (avoids FK race), then patch parents in
      const noParents = batchData.map(b => ({ ...b, parentId: null }));
      await stag.batch.createMany({ data: noParents });
      // Patch parents (only for those whose parent ended up in the new set)
      const newIds = new Set(batchData.map(b => b.id));
      for (const b of batchData) {
        if (b.parentId && newIds.has(b.parentId)) {
          await stag.batch.update({ where: { id: b.id }, data: { parentId: b.parentId } });
        }
      }
    }
    if (prodGuests.length > 0)   await stag.guest.createMany({ data: prodGuests });
    if (prodCaterings.length > 0) await stag.catering.createMany({ data: prodCaterings });
    if (prodGNW.length > 0)       await stag.guestsNextWeeks.createMany({ data: prodGNW });
    console.log(`  inserted ${batchData.length} batches (nulled ${nulledRecipeRefs} stale recipe refs), ${prodGuests.length} guests, ${prodCaterings.length} caterings, ${prodGNW.length} next-week entries`);

    // ── Reset kitchen equipment to canonical config
    console.log('[5/5] Resetting kitchen equipment...');
    await stag.kitchenEquipment.upsert({
      where: { id: 'default' },
      update: { pots: [140, 140, 100, 100, 100, 100, 100, 100, 100, 100], gasBurners: 4, inductionBurners: 4, bigBurnerThreshold: 80 },
      create: { id: 'default', pots: [140, 140, 100, 100, 100, 100, 100, 100, 100, 100], gasBurners: 4, inductionBurners: 4, bigBurnerThreshold: 80 },
    });
    console.log('  equipment reset to 10 pots + 4 gas + 4 induction');

    console.log('\n✅ Done. Staging now mirrors production menu data.');
  } finally {
    await prod.$disconnect();
    await stag.$disconnect();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
