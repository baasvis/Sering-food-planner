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
    // ── Schema probe: confirm prod is on the unified-batch schema. If the
    // `inventory` column is missing, this DB is pre-migration — abort before
    // we try to read columns that don't exist.
    const probe = await prod.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'batches' AND column_name = 'inventory'`,
    );
    if (probe.length === 0) {
      console.error('ERROR: prod database does not have the unified-batch schema. Run the migration first (see prisma/migrations/DEPLOY.md). Aborting.');
      console.error('Schema probe: SELECT column_name FROM information_schema.columns WHERE table_name=batches AND column_name=inventory returned 0 rows — prod has not been migrated yet.');
      process.exit(1);
    }

    // ── READ from production via raw SQL (unified-batch schema)
    console.log('[1/5] Reading from production...');
    const prodBatches = await prod.$queryRawUnsafe(`
      SELECT id, name, type, serving,
             allergens, extra_allergens AS "extraAllergens",
             order_for AS "orderFor",
             cook_date AS "cookDate",
             note,
             services,
             created_at AS "createdAt",
             recipe_id AS "recipeId",
             actual_ingredients AS "actualIngredients",
             cook_notes AS "cookNotes",
             stock_deducted AS "stockDeducted",
             generated,
             inventory,
             shipments
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
      };
    });
    if (batchData.length > 0) {
      await stag.batch.createMany({ data: batchData });
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
