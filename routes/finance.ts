// ─────────────────────────────────────────────────────────────────────────────
// FINANCE — Revenue data from Tebi POS
// ─────────────────────────────────────────────────────────────────────────────

import express, { Request, Response } from 'express';
import { prisma } from '../lib/db';
import { asyncHandler } from '../lib/config';
import { runTebiSync, cancelSync, getStatus, isSyncing } from '../lib/tebi-sync';
import { requireScreenEdit } from './auth';
import { formatIso, addDays } from '../shared/dates';
import type { Prisma } from '@prisma/client';

const router = express.Router();

router.get('/revenue', asyncHandler(async (req: Request, res: Response) => {
  const { start, end } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const rows = await prisma.dailyRevenue.findMany({
    where: { date: { gte: start as string, lte: end as string } },
    orderBy: [{ date: 'asc' }, { location: 'asc' }],
  });

  res.json(rows);
}));

// Rolling org-wide (West + Centraal) FOOD revenue per guest, for the planner's
// food-cost-%. We want food cost as a share of FOOD revenue only — drinks/bar
// would dilute it and flatter the %. Food income = direct lunch/dinner sales
// PLUS each prepaid meal-card USE valued at one card-meal (card price ÷ 10).
// A big share of lunch covers pay with a 10-meal card: the POS books the card
// PURCHASE in one lump (outside the meal) and rings each USE at €0, so counting
// purchases mis-times the income. Instead we value every "…card guest" use at
// the per-meal card price (derived from card purchases in the window) — income
// then tracks when guests actually eat. The denominator is EVERY meal served —
// lunch, dinner AND free staff/volunteer meals — because the kitchen cooks for
// staff/volunteers too; their €0 meals honestly lower revenue per guest.
// DailyRevenue.covers is always 0 (the POS never records covers — see TEBI.md),
// so guests come from the app's OWN counts (GuestHistory). Aligned on
// (location, date) where BOTH exist, so a sparse revenue history can't divide
// the fuller guest history and read too low. null when there's no overlap yet.
router.get('/revenue-per-guest', asyncHandler(async (_req: Request, res: Response) => {
  const LOCS = ['west', 'centraal'];
  const FOOD_MEALS = ['lunch', 'dinner'];
  const DAYS = 28;
  const toIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - DAYS);
  const start = toIso(startDate);
  const end = toIso(today);

  const [foodRows, guestRows] = await Promise.all([
    // Food revenue = lunch/dinner food items + prepaid MEAL CARDS. The card
    // PURCHASE ("Lunch card") is the income for card guests — booked once, up
    // front, outside the meal — so a meal-only filter misses it while still
    // counting the card USES ("Lunch card guest") as covers. Drinks/bar/coffee
    // stay excluded (they're outside the food meals and aren't cards).
    prisma.productRevenue.findMany({
      where: {
        date: { gte: start, lte: end },
        location: { in: LOCS },
        OR: [
          { meal: { in: FOOD_MEALS } },
          { productName: { contains: 'card', mode: 'insensitive' } },
        ],
      },
    }),
    // Denominator = every meal the kitchen serves, INCLUDING free
    // staff/volunteer meals (they eat the same food, so they count as guests we
    // feed). Their €0 revenue then correctly lowers revenue per guest, which is
    // the honest picture — we cook for people who don't pay.
    prisma.guestHistory.findMany({
      where: { date: { gte: start, lte: end }, location: { in: LOCS } },
    }),
  ]);

  // Per-meal value of a 10-meal lunch card, derived from card PURCHASES in the
  // window (a "…card" line that isn't a guest-use line and isn't a coffee card).
  let cardPurchNet = 0;
  let cardPurchQty = 0;
  for (const r of foodRows) {
    const n = (r.productName || '').toLowerCase();
    if (n.includes('card') && !n.includes('guest') && !n.includes('coffee') && (r.netRevenue || 0) > 0) {
      cardPurchNet += r.netRevenue || 0;
      cardPurchQty += r.quantity || 0;
    }
  }
  const cardMealValue = cardPurchQty > 0 ? (cardPurchNet / cardPurchQty) / 10 : 0;

  // Per (location, date) food revenue: direct paid lunch/dinner sales PLUS each
  // meal-card USE valued at one card-meal (cardMealValue) — instead of the lumpy
  // card-purchase income, which lands in one week and doesn't track when guests
  // actually eat. Card-purchase / coffee-card lines are dropped (the uses replace
  // them). Card-use lines themselves are €0 in the POS; we impute their value.
  const revByKey = new Map<string, number>();
  let mealSales = 0;
  let cardUseRevenue = 0;
  let cardUses = 0;
  for (const r of foodRows) {
    const n = (r.productName || '').toLowerCase();
    const k = `${r.location}|${r.date}`;
    if (n.includes('card') && n.includes('guest')) {
      const rev = (r.quantity || 0) * cardMealValue;
      revByKey.set(k, (revByKey.get(k) || 0) + rev);
      cardUseRevenue += rev;
      cardUses += r.quantity || 0;
    } else if (n.includes('card')) {
      // card purchase or coffee card — skip (uses are imputed above)
    } else {
      revByKey.set(k, (revByKey.get(k) || 0) + (r.netRevenue || 0));
      mealSales += r.netRevenue || 0;
    }
  }
  const guestByKey = new Map<string, number>();
  for (const g of guestRows) {
    const k = `${g.location}|${g.date}`;
    guestByKey.set(k, (guestByKey.get(k) || 0) + (g.count || 0));
  }
  let foodRevenue = 0;
  let guests = 0;
  let locationDaysUsed = 0;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const allKeys = new Set<string>([...revByKey.keys(), ...guestByKey.keys()]);
  const rows: Array<{ loc: string; date: string; foodRevenue: number; guests: number; used: boolean }> = [];
  for (const k of allKeys) {
    const [loc, date] = k.split('|');
    const rev = revByKey.get(k) || 0;
    const gu = guestByKey.get(k) || 0;
    const used = rev > 0 && gu > 0;
    if (used) { foodRevenue += rev; guests += gu; locationDaysUsed++; }
    rows.push({ loc, date, foodRevenue: r2(rev), guests: gu, used });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.loc.localeCompare(b.loc));

  // Unaligned totals (every day, no overlap requirement) for comparison.
  let allRev = 0; for (const v of revByKey.values()) allRev += v;
  let allGuests = 0; for (const v of guestByKey.values()) allGuests += v;

  const revenuePerGuest = guests > 0 ? r2(foodRevenue / guests) : null;

  res.json({
    revenuePerGuest,
    foodRevenue: r2(foodRevenue),
    guests,
    locationDaysUsed,
    days: DAYS,
    from: start,
    to: end,
    components: {
      mealSales: r2(mealSales),
      cardMealValue: r2(cardMealValue),
      cardUses,
      cardUseRevenue: r2(cardUseRevenue),
    },
    unaligned: { foodRevenue: r2(allRev), guests: allGuests, perGuest: allGuests > 0 ? r2(allRev / allGuests) : null },
    rows,
  });
}));

router.get('/products', asyncHandler(async (req: Request, res: Response) => {
  const { start, end, location, meal, groupBy } = req.query;
  if (!start || !end) {
    return res.status(400).json({ error: 'start and end query params required (YYYY-MM-DD)' });
  }

  const where: Prisma.ProductRevenueWhereInput = { date: { gte: start as string, lte: end as string } };
  if (location) where.location = location as string;
  if (meal) where.meal = meal as string;

  const rows = await prisma.productRevenue.findMany({
    where,
    orderBy: [{ grossRevenue: 'desc' }],
  });

  if (groupBy === 'category') {
    interface CategoryAgg { productCategory: string; quantity: number; grossRevenue: number; netRevenue: number; products: number }
    const categories: Record<string, CategoryAgg> = {};
    for (const row of rows) {
      const cat = row.productCategory || 'Other';
      if (!categories[cat]) {
        categories[cat] = { productCategory: cat, quantity: 0, grossRevenue: 0, netRevenue: 0, products: 0 };
      }
      categories[cat].quantity += row.quantity;
      categories[cat].grossRevenue += row.grossRevenue;
      categories[cat].netRevenue += row.netRevenue;
      categories[cat].products += 1;
    }
    const result = Object.values(categories)
      .map((c) => ({
        ...c,
        grossRevenue: Math.round(c.grossRevenue * 100) / 100,
        netRevenue: Math.round(c.netRevenue * 100) / 100,
      }))
      .sort((a, b) => b.grossRevenue - a.grossRevenue);
    return res.json(result);
  }

  res.json(rows);
}));

router.post('/sync', requireScreenEdit('finance'), (req: Request, res: Response) => {
  if (isSyncing()) {
    return res.status(409).json({ error: 'Sync already in progress' });
  }

  const { startDate, endDate } = req.body;

  // "Yesterday" in Amsterdam wall-clock time. The host runs in UTC, where
  // between 00:00 and ~02:00 local the UTC date is already a day behind —
  // toISOString() here would default the sync to the day before yesterday.
  const amsNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Amsterdam' }));
  const defaultDate = formatIso(addDays(amsNow, -1));

  const start = startDate || defaultDate;
  const end = endDate || start;

  const result = runTebiSync({ start, end, source: 'manual' });
  if (!result.ok) {
    // Propagate the refusal reason. The shared helper rejects up front for
    // missing credentials or an in-flight sync; treat the latter as a 409,
    // everything else as 500 so the user can tell them apart.
    const status = result.error === 'Sync already in progress' ? 409 : 500;
    return res.status(status).json({ error: result.error });
  }

  res.json({ status: 'syncing', startDate: start, endDate: end });
});

router.post('/sync-cancel', requireScreenEdit('finance'), (_req: Request, res: Response) => {
  const cancelled = cancelSync('Sync cancelled by user');
  res.json({ status: cancelled ? 'cancelled' : 'not-running' });
});

router.get('/sync-status', asyncHandler(async (_req: Request, res: Response) => {
  res.json(await getStatus());
}));

export default router;
