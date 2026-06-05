// One-off READ-ONLY diagnostic: compute food revenue per guest (the planner's
// food-cost-% denominator) against whatever DATABASE_URL is passed in. Only
// runs findMany() — no writes. Used to check the number on full production data
// vs sparse staging. Run: DATABASE_URL=<url> node scripts/probe-rev-per-guest.js
/* eslint-disable */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');

// `--prod` loads the production DATABASE_URL from the main repo's .env (the
// worktree's own .env points at staging). Guarded to a known prod host so it
// can't accidentally connect elsewhere. Read-only either way.
if (process.argv.includes('--prod')) {
  const envPath = path.resolve(__dirname, '../../../../.env');
  let url = null;
  try {
    const m = fs.readFileSync(envPath, 'utf8').match(/^DATABASE_URL=(.+)$/m);
    if (m) url = m[1].trim().replace(/^["']|["']$/g, '');
  } catch (_) { /* fall through */ }
  if (!url || !url.includes('centerbeam')) {
    console.error('--prod: could not find a production DATABASE_URL (centerbeam host) in ' + envPath);
    process.exit(1);
  }
  process.env.DATABASE_URL = url;
}

(async () => {
  const host = (process.env.DATABASE_URL || '').split('@')[1] || '(none)';
  console.log('Connecting to DB host:', host);
  const prisma = new PrismaClient();

  const LOCS = ['west', 'centraal'];
  const FOOD_MEALS = ['lunch', 'dinner'];
  const DAYS = 28;
  const toIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const start = toIso(new Date(today.getTime() - DAYS * 86400000));
  const end = toIso(today);

  const [foodRows, guestRows] = await Promise.all([
    prisma.productRevenue.findMany({ where: { date: { gte: start, lte: end }, location: { in: LOCS }, OR: [{ meal: { in: FOOD_MEALS } }, { productName: { contains: 'card', mode: 'insensitive' } }] } }),
    prisma.guestHistory.findMany({ where: { date: { gte: start, lte: end }, location: { in: LOCS } } }),
  ]);

  let cardPurchNet = 0, cardPurchQty = 0;
  for (const r of foodRows) {
    const n = (r.productName || '').toLowerCase();
    if (n.includes('card') && !n.includes('guest') && !n.includes('coffee') && (r.netRevenue || 0) > 0) { cardPurchNet += r.netRevenue || 0; cardPurchQty += r.quantity || 0; }
  }
  const cardMealValue = cardPurchQty > 0 ? (cardPurchNet / cardPurchQty) / 10 : 0;

  const revByKey = new Map();
  let mealSales = 0, cardUseRevenue = 0, cardUses = 0;
  for (const r of foodRows) {
    const n = (r.productName || '').toLowerCase();
    const k = `${r.location}|${r.date}`;
    if (n.includes('card') && n.includes('guest')) { const rev = (r.quantity || 0) * cardMealValue; revByKey.set(k, (revByKey.get(k) || 0) + rev); cardUseRevenue += rev; cardUses += r.quantity || 0; }
    else if (n.includes('card')) { /* purchase/coffee card — skip */ }
    else { revByKey.set(k, (revByKey.get(k) || 0) + (r.netRevenue || 0)); mealSales += r.netRevenue || 0; }
  }
  const guestByKey = new Map();
  for (const g of guestRows) { const k = `${g.location}|${g.date}`; guestByKey.set(k, (guestByKey.get(k) || 0) + (g.count || 0)); }

  let foodRevenue = 0, guests = 0, daysUsed = 0;
  const days = [];
  for (const k of new Set([...revByKey.keys(), ...guestByKey.keys()])) {
    const [loc, date] = k.split('|');
    const rev = revByKey.get(k) || 0, gu = guestByKey.get(k) || 0, used = rev > 0 && gu > 0;
    if (used) { foodRevenue += rev; guests += gu; daysUsed++; }
    days.push({ loc, date, rev: Math.round(rev), guests: gu, used });
  }
  const weekOf = (iso) => { const d = new Date(iso + 'T12:00:00'); const dow = d.getDay(); const mon = new Date(d); mon.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow)); return toIso(mon); };
  const byWeek = {};
  for (const r of days) { if (!r.used) continue; const w = weekOf(r.date); if (!byWeek[w]) byWeek[w] = { rev: 0, guests: 0, days: 0 }; byWeek[w].rev += r.rev; byWeek[w].guests += r.guests; byWeek[w].days++; }

  console.log(JSON.stringify({
    window: { start, end },
    cardMealValue, cardUses, cardUseRevenue: Math.round(cardUseRevenue), mealSales: Math.round(mealSales),
    foodRevenue: Math.round(foodRevenue), guests, daysUsedAligned: daysUsed,
    revenuePerGuest: guests > 0 ? Math.round(foodRevenue / guests * 100) / 100 : null,
    daysWithRevenue: days.filter(d => d.rev > 0).length, totalLocDayRows: days.length,
    perWeek: Object.entries(byWeek).sort().map(([week, v]) => ({ week, rev: v.rev, guests: v.guests, locDays: v.days, perGuest: Math.round(v.rev / v.guests * 100) / 100 })),
  }, null, 2));

  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
