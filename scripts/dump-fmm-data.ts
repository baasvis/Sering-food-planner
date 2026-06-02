// READ-ONLY. Dumps exactly the state the client-side Fix-My-Menu pipeline
// consumes (S.batches/guests/caterings/kitchenEquipment/cookRhythm/closedServices),
// using the server's own dbReadAll() transformers so shapes match production.
// Run via:  railway run npx tsx scripts/dump-fmm-data.ts
// Writes:   ./fmm-2026-06-01.json  (gitignored data dir not used; this is a one-off)
import { writeFileSync } from 'fs';
import { prisma, dbReadAll } from '../lib/db';

async function main() {
  const data = await dbReadAll(); // { batches, guests, recipes, caterings, transportItems }

  const ke = await prisma.kitchenEquipment.findUnique({ where: { id: 'default' } });
  const kitchenEquipment = ke
    ? { pots: ke.pots, gasBurners: ke.gasBurners, inductionBurners: ke.inductionBurners, bigBurnerThreshold: ke.bigBurnerThreshold }
    : { pots: [], gasBurners: 0, inductionBurners: 0, bigBurnerThreshold: 80 };

  const cr = await prisma.cookRhythm.findUnique({ where: { id: 'default' } });
  const cookRhythm = cr && cr.config ? cr.config : { days: {} };

  const cs = await prisma.closedServices.findUnique({ where: { id: 'default' } });
  const closedServices = cs && cs.config ? cs.config : { recurring: {} };

  const out = {
    today: '2026-06-01',
    batches: data.batches,
    guests: data.guests,
    caterings: data.caterings,
    kitchenEquipment,
    cookRhythm,
    closedServices,
  };

  const path = 'fmm-2026-06-01.json';
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`Wrote ${path}`);
  console.log(`  batches:   ${data.batches.length}`);
  console.log(`  caterings: ${data.caterings.length}`);
  console.log(`  pots:      ${JSON.stringify(kitchenEquipment.pots)}`);
  console.log(`  cookRhythm days set: ${Object.keys((cookRhythm as { days?: Record<string, unknown> }).days || {}).join(', ') || '(none)'}`);
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
