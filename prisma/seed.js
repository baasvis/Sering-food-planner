// ─────────────────────────────────────────────────────────────────────────────
// PRISMA SEED SCRIPT — Seeds fresh Postgres with initial data
// ─────────────────────────────────────────────────────────────────────────────

const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

const prisma = new PrismaClient();

async function main() {
  // Seed ingredients
  const ingredientsSeed = path.join(__dirname, '..', 'seeds', 'ingredients.json');
  if (fs.existsSync(ingredientsSeed)) {
    const count = await prisma.ingredient.count();
    if (count === 0) {
      const ingredients = JSON.parse(fs.readFileSync(ingredientsSeed, 'utf8'));
      await prisma.ingredient.createMany({ data: ingredients });
      console.log(`Seeded ${ingredients.length} ingredients`);
    } else {
      console.log(`Ingredients already exist (${count} rows) — skipping seed`);
    }
  }

  // Seed standard inventory
  const stdInvSeed = path.join(__dirname, '..', 'seeds', 'standard-inventory.json');
  if (fs.existsSync(stdInvSeed)) {
    const count = await prisma.standardInventory.count();
    if (count === 0) {
      const items = JSON.parse(fs.readFileSync(stdInvSeed, 'utf8'));
      await prisma.standardInventory.createMany({ data: items });
      console.log(`Seeded ${items.length} standard inventory items`);
    } else {
      console.log(`Standard inventory already exists (${count} rows) — skipping seed`);
    }
  }

  // Seed default guests
  const count = await prisma.guest.count();
  if (count === 0) {
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const guestData = [];
    for (const loc of ['west', 'centraal']) {
      for (const day of days) {
        const isWeekend = day === 'Sat' || day === 'Sun';
        guestData.push({
          location: loc,
          day,
          lunch: isWeekend ? 0 : (loc === 'west' ? 100 : 80),
          dinner: isWeekend ? 0 : (loc === 'west' ? 110 : 85),
        });
      }
    }
    await prisma.guest.createMany({ data: guestData });
    console.log('Seeded default guest counts (14 rows)');
  } else {
    console.log(`Guests already exist (${count} rows) — skipping seed`);
  }
}

main()
  .then(() => {
    console.log('Seed complete');
    return prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error('Seed error:', e);
    await prisma.$disconnect();
    process.exit(1);
  });
