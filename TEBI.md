# Tebi integration — handoff doc

> **For future AIs / maintainers reading this cold.** The Tebi integration
> is the most fragile piece of the food-planner. This doc captures
> everything learned across the 2026-03 → 2026-05 series of breakages and
> migrations so the next person doesn't have to retrace it.
>
> **Last fully verified:** 2026-05-09.
> **Last big change:** 2026-04-10 — Centraal + TestTafel migrated to a
> second Tebi account (see **Ledger history** below).

---

## TL;DR — what to run when

| You want to… | Do this |
|---|---|
| Trigger a sync now | `/dashboard/finance` → **Sync from Tebi**. Or `npx tsx scripts/tebi-sync-worker.js 2026-04-25 2026-05-08`. |
| Diagnose "GuestHistory looks wrong" | `npx tsx scripts/diagnose-tebi-coverage.ts` then `…-telemetry.ts`. |
| Try numbers without writing to DB | Get a Bearer (DevTools recipe below) → `TEBI_BEARER_TOKEN='eyJ...' npx tsx scripts/tebi-derive-guests.ts`. |
| Eyeball recent guest counts | `npx tsx scripts/show-guest-history.ts` (terminal pivot table) or `…-export-guest-history-xlsx.ts` (Excel). |
| Backfill guest counts for a date range | `TEBI_BEARER_TOKEN=… TEBI_LEDGER_ID=… BACKFILL_START=… BACKFILL_END=… DELETE_LOCATIONS=west,centraal npx tsx scripts/backfill-tebi.ts`. |
| Backfill flow-chart distribution | Two-token form: `TEBI_BEARER_TOKEN_1=… TEBI_BEARER_TOKEN_2=… npx tsx scripts/backfill-tebi-flow.ts`. |
| Probe a specific account's history | `TEBI_BEARER_TOKEN_1=… npx tsx scripts/probe-tebi-account1-history.ts` (or `_2` for Account 2). |
| Detect PC migrations (alert if a previously-active PC went silent) | `TEBI_BEARER_TOKEN_1=… TEBI_BEARER_TOKEN_2=… npx tsx scripts/detect-pc-migrations.ts [--weeks 8]`. |
| Get a fresh Bearer token | Chrome → live.tebi.co (logged in) → F12 → Network → filter `api` → right-click row → Copy as cURL. Paste into the script. ~24h validity. |

If `npx tsx` fails on Windows, run from the Sering-food-planner directory in a fresh PowerShell — the agentic harness can't always spawn `tsx` reliably.

---

## What it is

Tebi is the POS system Sering's volunteers ring up sales on. The
food-planner pulls data from Tebi to populate three things:

1. **DailyRevenue / ProductRevenue** — the Finance screen's per-day,
   per-location, per-product totals.
2. **GuestHistory** — the Guests page's per-day, per-location, per-meal
   counts. Feeds the planner's predictions for upcoming weeks.
3. **GuestHistoryMeta.flowDistribution** — normalised arrival-time curves
   per (location, meal, day-of-week). Drives the guest-flow chart's
   shape; without it the chart falls back to a generic gaussian.

The original CSV-upload path still works (`public/js/predictions.ts` +
`routes/guests.ts`) but since 2026-05-07 the scraper auto-populates
GuestHistory, so users don't drop CSVs under normal operation.

## Why scraping (not a real API)

Tebi doesn't sell public/partner API access. Daan asked support; the
answer was no. So we hit the same `/api/...` endpoints the back-office
SPA uses, authenticated with the same short-lived JWT.

Two paths to that token:

- **Production cron**: Playwright logs in (`scripts/tebi-scraper.js`),
  intercepts the auth header from a real `/api/...` request, reuses it
  inside the same browser context.
- **Local probing / debugging / backfills**: copy a Bearer by hand from
  Chrome DevTools. Token lasts ~24h. All scripts in `scripts/` named
  `backfill-*` / `probe-*` / `tebi-derive-*` use this path.

If a future Tebi UI update breaks Playwright login, the **bypass-Playwright
probing path** is what to use — plain `fetch` with a Bearer works in any
environment, including agentic harnesses where Chromium can't spawn.

---

## Ledger history — how data moved between accounts over time

This is the section everyone forgets to write down and then bleeds days
re-deriving from telemetry. The full timeline:

```
2025 → 2026-03-06     Account 1 only.
                      One Tebi account: info@testtafel.nl (ledger 723192).
                      Three profit centers (PCs) inside that ledger:
                          • West       (UUID 00000000-0000-0000-0000-000000000000)
                          • Centraal   (UUID 27c33042-47c1-4650-8e76-37c7bfef86dd)
                          • TestTafel  (UUID a904a975-6bd2-413f-8e02-dc457b87a6e3)
                      All three locations rang up on the same ledger.
                      Daan uploaded CSVs from Tebi into the dashboard;
                      no live Tebi sync existed yet for guest counts.

2026-03-06 → 2026-04-09   Account 1 active for all locations.
                          Centraal PC has its own real data in this window.
                          The dashboard had a working CSV-based pipeline
                          and an early scraper for revenue.

2026-03-21            Last day of CSV uploads (per Daan).
                      After this date, no manual CSV uploads;
                      scraper was supposed to take over but had been
                      silently broken since ~mid-March (Tebi UI drift
                      that took 7 weeks to detect).

2026-04-10            Account 2 comes online.
                      A new Tebi account is created:
                          facturen@testtafel.nl (ledger 724466,
                          Google OAuth, alias staff-login@testtafel.nl).
                      Centraal + TestTafel migrate to this ledger.
                      New PC UUIDs (UUIDs scope per ledger, so they
                      don't carry over):
                          • TestTafel  (UUID 00000000-0000-0000-0000-000000000000)
                          • Centraal   (UUID 85194418-ab36-49a0-8161-9ae3a64576ba)
                      Account 1's Centraal + TestTafel PCs go quiet
                      from this date. Account 1 still serves West.

2026-04-09 → 2026-05-07   Silent gap.
                          The original scraper had been broken since
                          mid-March (Tebi swapped invoice line-items
                          for the `product_top` chart, Playwright login
                          markers had moved, etc.). GuestHistory wasn't
                          updating but no one noticed because the cron
                          exited 0 — `'all'` rows wrote, per-PC product
                          rows didn't.

2026-05-07            Big rewrite + first end-to-end success.
                          • Bearer-token bypass path proven
                          • product_top chart with JSON-encoded
                            profit-center filter discovered
                          • Misattribution rule for TestTafel-PC items
                            before 18:00 codified
                          • MEAL_ITEM_TYPE allowlist + 30/70 staff
                            split + reassignment-aware aggregation
                          • Strict exit-1 added: 'all' wrote but per-PC
                            ZERO ⇒ exit 1 (catches silent failure)
                          • Manual-sync timeout 5 → 15 min
                          • Pre-commit hook fixed (jest was scanning
                            stale .claude/worktrees/ copies)

2026-05-08            Backfill day.
                          Account 2 historical (TestTafel + Centraal):
                              2026-04-10 → 2026-05-08
                          Account 1 Centraal gap (using Account 1's
                          Centraal PC, which still held data
                          2026-03-06 → 2026-04-09):
                              2026-03-21 → 2026-04-09
                          Account 1 West backfill:
                              2026-03-23 → 2026-04-23
                          Flow distribution rebuilt:
                              West   from Account 1 (5,875 events)
                              Centraal from Account 2 (2,432 events)
```

### What lives where, today

```
Account 1 (info@testtafel.nl, ledger 723192):
  ├─ West PC ──────── ACTIVE — real-time sales (lunch + dinner)
  ├─ Centraal PC ──── DORMANT (last data ~2026-04-09; preserved for backfills)
  └─ TestTafel PC ─── DORMANT (last data ~2026-04-09)

Account 2 (facturen@testtafel.nl, ledger 724466):
  ├─ TestTafel PC ─── ACTIVE — TestTafel evenings + misattributed Centraal
  └─ Centraal PC ──── ACTIVE — community kitchen lunch + dinner
```

### Misattribution rule (TestTafel PC ↔ Centraal)

TestTafel + Centraal share one Tebi cash drawer at the same site, two
profit centers. **TestTafel only opens 18:00+ and only sells the
"Single TestTafel Menu" multi-course dinner**. Everything else under
TestTafel's PC is misattributed Centraal sales — staff forget to switch
the POS register before ringing up community-kitchen items.

`resolveLocationForItem` in `scripts/tebi-scraper.js` corrects this:

| Item observed at TestTafel PC | Resolved location | Why |
|---|---|---|
| `Single TestTafel Menu (5 course)` / `(3 course)` | testtafel | Legitimate evening service. |
| Any other meal item (`DSC Lunch`, `DSC Dinner`, `Lunch card guest`, …) | **centraal** | Misattributed community kitchen sale. |
| Drinks / snacks (`DSC pilsner`, `2 Caps - Blonde`, `Lunch card`) | testtafel | Left as PC sees them — could be either, no time data to disambiguate. |

The reassignment runs inside `formatProductRevenueFromTop`, which also
aggregates by `(date, location, meal, productName)` — so `DSC Lunch`
appearing at both TestTafel PC (reassigned to centraal) and Centraal PC
gets summed into one ProductRevenue row instead of one upsert overwriting
the other.

**Known caveat:** `DailyRevenue` per-PC rows come from Tebi's per-PC
revenue chart unchanged. After reassignment, `sum(ProductRevenue WHERE
location=testtafel)` won't equal `DailyRevenue WHERE location=testtafel`
on days with TestTafel-PC misattributions. Finance UI primarily reads
the `'all'` aggregate row, so this hasn't bitten anyone yet.

---

## Authentication

Tebi uses Auth0. The Bearer is a JWT issued by `auth.tebi.co` (audience
`tebi-api`), valid ~24h. Decoded sample:

```json
{
  "tebi_email": "staff-login@testtafel.nl",
  "iss": "https://auth.tebi.co/",
  "sub": "auth0|69dcfb34a4870e93ef110ae2",
  "aud": ["tebi-api", "https://tebi.eu.auth0.com/userinfo"],
  "iat": 1778248669, "exp": 1778335069,
  "scope": "openid profile email",
  "azp": "0tGlVnSFHtEZwttnrsKKFzomyq9AWlyQ"
}
```

The Auth0 `azp` is a **public SPA client** — no client_secret. Two
practical implications:

- **Programmatic refresh isn't trivial.** A back-end can't login as Daan
  without the Auth0 redirect flow + a real browser session. Playwright
  is, in practice, our refresh mechanism.
- **A leaked Bearer is bounded by 24h.** No client_secret to rotate.

### Refreshing the Bearer by hand

For local probing / backfills:

1. Chrome → `https://live.tebi.co` → log in with the matching account.
2. F12 → **Network** tab.
3. F5 to refresh, type `api` in the filter box.
4. Right-click any row whose URL contains `/api/...` → **Copy** → **Copy
   as cURL (bash)**.
5. Paste in chat or to a script. The Bearer line is `-H 'Authorization:
   Bearer eyJ...'`.

The JWT's `tebi_email` field tells you which account it's for. Keep
Account 1's and Account 2's tokens labelled — backfill scripts wire
them via `TEBI_BEARER_TOKEN_1` (Account 1, ledger 723192, West) vs
`TEBI_BEARER_TOKEN_2` (Account 2, ledger 724466, Centraal+TestTafel).

---

## Endpoint catalogue (verified 2026-05-08)

All endpoints at `https://live.tebi.co`. All require
`Authorization: Bearer <jwt>`. All return JSON; errors look like
`{"message":"Not found","label":null,"validation":[]}`.

### Insights / dashboards

| Path | What it returns |
|---|---|
| `GET /api/insights/ledgers/{id}/insights/dashboards/main` | Full chart catalogue. Includes `chartGroups[].charts[]` with `id`, `name`, `description`, `primaryMetric`, `metrics`, `groupings`, `filter`. **Walk this to discover charts.** |
| `GET /api/insights/ledgers/{id}/insights/data/charts/{chartId}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&mock=false&limit=-1` | Time-series data for the chart. `endDate` is **exclusive**. Pass `&filter=<json>` for a profit-center filter. |

### Key chart IDs

| Chart ID | Group | What we use it for |
|---|---|---|
| `revenue_overview_chart` | revenue_metrics | Daily totals → DailyRevenue 'all' row |
| `revenue_profit_center_<UUID>` | revenue_metrics | Per-location revenue → DailyRevenue per-loc rows |
| `number_of_sales_chart` | revenue_metrics | DailyRevenue.sales |
| `covers_count_chart` | revenue_metrics | DailyRevenue.covers (always 0 — Sering's POS doesn't track) |
| `product_top` | product_metrics | **Per-product breakdown — the key endpoint for guest counts.** Always grouped by ITEM. |
| `product_categories` | product_metrics | Per-category breakdown. Not currently used. |
| `discounts` | service_metrics | Per-reason discount totals. Untapped lead for staff-meal counts. |
| `tips` | service_metrics | Daily tip totals. |
| `reservation_count` | reservation_metrics | Always 0 — Sering doesn't take reservations. |

### Profit-center filter (chart endpoints only)

To scope a chart to one PC, pass `&filter=<URL-encoded JSON>`:

```
?filter=%7B%22grouping%22%3A%22PROFIT_CENTER%22%2C%22value%22%3A%2227c33042-47c1-4650-8e76-37c7bfef86dd%22%7D
```

Decoded: `{"grouping":"PROFIT_CENTER","value":"<uuid>"}`. JSON-encoded was
the breakthrough — anything else (raw string, key=value, array form) is
silently ignored or 400s.

The grouping URL parameter (`grouping=ITEM`, `groupBy=ITEM`, …) is
**silently ignored**. Charts return their built-in grouping only.

### Invoicing (degraded as of 2026-05-07)

| Path | Returns |
|---|---|
| `GET /api/invoicing/ledgers/{id}/sales/invoices?page=N&pageSize=N&startDate=...&endDate=...` | Paginated invoice **summary list**. Each item has `key, sequenceNumber, name, created, closedTime, businessDay, receiptUrl, guest, netRevenue, grossRevenue`. **No `items` / `lines` / `lineItems`.** |

Don't try to parse line items here — they're gone. `product_top` replaces
that path. The response key was renamed `content → data` around
2026-05-07; the scraper reads either to be robust against revert.

⚠️ **The `filter` param is silently ignored on `/sales/invoices`.** Only
the chart endpoints honour JSON-encoded filters. We discovered this when
a flow-distribution dry-run reported `centraal dinner = testtafel dinner
= west dinner = 3896` (exact triple-count). Workaround: fetch the full
ledger's invoices once and attribute by ledger (Account 1 → west,
Account 2 → centraal). See `scripts/backfill-tebi-flow.ts`.

### What doesn't exist (probed, all 404)

```
/api/insights/ledgers/{id}/insights/dashboards         (no list endpoint)
/api/insights/ledgers/{id}/insights/dashboards/products
/api/invoicing/ledgers/{id}/sales/by-product
/api/invoicing/ledgers/{id}/items
/api/catalog/ledgers/{id}/...
/api/inventory/ledgers/{id}/...
/api/customers/ledgers/{id}
/api/loyalty/ledgers/{id}
/api/reservations/ledgers/{id}
/api/reports/ledgers/{id}, /api/exports/ledgers/{id}
/api/users/me, /api/me, /api/account, /api/ledgers, /api/ledgers/{id}
```

Tebi's CSV exports ("ProductOrdersReport", "ProductReportByProfitCenter")
are likely generated by a different back-office endpoint we haven't
identified. Not worth pursuing — `product_top` gives equivalent data.

---

## Data pipeline (live cron)

```
Cron (server.ts, 04:30 UTC)
  └─ runTebiSync (lib/tebi-sync.ts)
       └─ spawn scripts/tebi-sync-worker.js
            └─ for each configured account (TEBI_*_ + TEBI_*_2):
                 ├─ login (Playwright) → captures Bearer
                 ├─ for each day in date range:
                 │    ├─ runForAccount (scripts/tebi-scraper.js)
                 │    │    ├─ discoverProfitCenters → {west, centraal, testtafel}
                 │    │    ├─ fetchDayData (revenue / orders / sales / covers / averages
                 │    │    │              / per-PC revenue / product_top per PC / invoices)
                 │    │    ├─ formatResults                     → summary
                 │    │    ├─ formatProductRevenueFromTop        → productRows  (with reassignment + aggregation)
                 │    │    └─ deriveGuestCountsFromProductRows   → guestCounts  (30/70 staff split)
                 │    └─ saveResults
                 │         ├─ upsert DailyRevenue ('all' + per-loc)
                 │         ├─ upsertProductRevenue
                 │         └─ upsertGuestHistory
                 └─ stats logged: allRows / perLocationRows / productRows / guestRows
       └─ exit:
            - exit 1 if zero rows written for any account/date
            - exit 1 if every account failed
            - exit 1 if 'all' rows wrote but ZERO per-loc AND ZERO product rows
              (catches the silent partial-failure mode that hid 7 weeks of breakage)
```

`lib/tebi-sync.ts` keeps state for `/api/finance/sync-status` and
persists `lastSuccessOutputTail` in telemetry so the diagnose-tebi-telemetry
script can show stdout even on success runs. Manual-sync timeout is
15 min (was 5 min, but two ledgers × 14 days was hitting the wall).

## Schema

```prisma
model DailyRevenue {
  id Int @id @default(autoincrement())
  date String, location String
  grossRevenue, netRevenue Float, sales, covers, invoiceCount Int
  syncedAt String
  @@unique([date, location])
}

model ProductRevenue {
  id Int @id @default(autoincrement())
  date, location, meal, productName, productCategory String
  quantity, grossRevenue, netRevenue Float
  syncedAt String
  @@unique([date, location, meal, productName])
}

model GuestHistory {
  id Int @id @default(autoincrement())
  location, meal, date String
  count Int @default(0)
  @@unique([location, meal, date])
}

model GuestHistoryMeta {
  id Int @id @default(autoincrement())
  key String @unique
  value String  // JSON-encoded
}
```

Meals written: `lunch` / `dinner` / `staff` for matched products,
`other` for everything else. Keeps the unique key working even though
we no longer have per-transaction service-period data.

`GuestHistoryMeta.flowDistribution` (key='flowDistribution') is a
nested JSON: `{[location]: {[meal]: {[dayOfWeek]: {[5minBucket]: fraction}}}}`.
Buckets are minute-of-day strings (`"720"` = 12:00, `"1080"` = 18:00).
Each (location, meal, dayOfWeek) triple's bucket fractions sum to 1.

---

## Meal-product allowlist

`scripts/tebi-scraper.js` `MEAL_ITEM_TYPE`:

```js
{
  // Account #1 — West (info@testtafel.nl, ledger 723192)
  'Lunch':                            'lunch',
  'Lunch card guest':                 'lunch',
  'Dinner donation':                  'dinner',
  'Stadspas Dinner':                  'dinner',
  'DSC Dinner':                       'dinner',
  'Staff & volunteer meals':          'staff',
  // Account #2 — Centraal + TestTafel (facturen@testtafel.nl, ledger 724466)
  'DSC Lunch':                        'lunch',
  'DSC Stadspas Dinner':              'dinner',
  'DSC staff & volunteer meals':      'staff',
  'Single TestTafel Menu (5 course)': 'dinner',
  'Single TestTafel Menu (3 course)': 'dinner',
}
```

**Important distinctions:**

- `"Lunch card"` (the bulk-buy CARD) is NOT in this list — those rows
  are donor purchases, not guests served. The actual guest event is
  `"Lunch card guest"`, which IS in the list.
- Multi-course components NOT in the allowlist: `Bread (bundle)`,
  `Amuse (Bundle)`, `Course 1..3`, `Dessert 1..2`. These appear at
  TestTafel PC with quantities matching `Single TestTafel Menu` × N
  because they're the sub-components of each multi-course meal.
  Counting them would double-count guests.

If Sering's POS gets new product names, update `MEAL_ITEM_TYPE` here.
The CSV path in `public/js/predictions.ts` is being phased out — don't
sync the constant there for new items unless someone's still uploading
CSVs.

The diagnostic scripts (`diagnose-tebi-coverage.ts`,
`tebi-derive-guests.ts`) print "unmatched products" so you can spot
what's escaping the allowlist. `diagnose-tebi-coverage.ts` imports
`MEAL_ITEM_TYPE` directly from `tebi-scraper.js` — single source of
truth, no hardcoded copies.

### Staff lunch/dinner split

`product_top` doesn't carry per-hour data and the
`Staff & volunteer meals` item is one bucket. We split it 30/70
lunch/dinner as a heuristic matching Sering's typical pattern (more
staff stay through dinner). Refining this with a separate hourly chart
fetch is a nice-to-have, not currently done.

---

## Use — running workflows

### "I want to sync now."

UI: `/dashboard/finance` → **Sync from Tebi** button.

CLI:

```bash
# Full worker for a custom range (writes to DB):
npx tsx scripts/tebi-sync-worker.js 2026-04-25 2026-05-08

# Or hit the API directly:
curl -X POST https://<host>/api/finance/sync \
  -H 'Cookie: <session>' \
  -H 'Content-Type: application/json' \
  -d '{"startDate":"2026-04-25","endDate":"2026-05-08"}'
```

### "I want to see GuestHistory."

```bash
# Pivot table in terminal (defaults to last 60 days):
npx tsx scripts/show-guest-history.ts

# Custom start:
FROM=2026-03-01 npx tsx scripts/show-guest-history.ts

# Excel export (xlsx in repo root):
npx tsx scripts/export-guest-history-xlsx.ts
FROM=2026-03-01 TO=2026-04-30 npx tsx scripts/export-guest-history-xlsx.ts
```

### "I want to backfill a date range."

`scripts/backfill-tebi.ts` is parameterized. It deletes existing rows
for the configured locations + range, then re-fetches and rewrites:

```bash
# Account 2 era backfill:
TEBI_BEARER_TOKEN='eyJ...' \
TEBI_LEDGER_ID=724466 \
BACKFILL_START=2026-04-10 BACKFILL_END=2026-05-08 \
DELETE_LOCATIONS=centraal,testtafel \
npx tsx scripts/backfill-tebi.ts

# Account 1 West-only backfill:
TEBI_BEARER_TOKEN='eyJ...' \
TEBI_LEDGER_ID=723192 \
BACKFILL_START=2026-03-23 BACKFILL_END=2026-04-23 \
DELETE_LOCATIONS=west \
npx tsx scripts/backfill-tebi.ts

# Account 1 Centraal gap (using Account 1's now-dormant Centraal PC):
TEBI_BEARER_TOKEN='eyJ...' \
TEBI_LEDGER_ID=723192 \
BACKFILL_START=2026-03-21 BACKFILL_END=2026-04-09 \
DELETE_LOCATIONS=centraal \
npx tsx scripts/backfill-tebi.ts
```

The `DELETE_LOCATIONS` filter prevents clobbering untouched locations:
the script discovers ALL PCs at runtime but only fetches + writes for
PCs whose name maps into `DELETE_LOCATIONS`. So a Centraal-only run
won't blank out West rows.

### "I want to backfill flow distribution (the chart curves)."

`scripts/backfill-tebi-flow.ts` populates `GuestHistoryMeta.flowDistribution`
from invoice timestamps. Two-token form combines both ledgers in one
write so the location-level merge does the right thing:

```bash
TEBI_BEARER_TOKEN_1='eyJ...' TEBI_LEDGER_ID_1=723192 \
TEBI_BEARER_TOKEN_2='eyJ...' TEBI_LEDGER_ID_2=724466 \
FLOW_START=2026-03-01 FLOW_END=2026-05-08 \
npx tsx scripts/backfill-tebi-flow.ts [--dry-run]
```

Either token can be omitted if you only have one fresh — the merge
guard preserves the other location's existing distribution. Default
window is the last 60 days.

The script attributes invoices by **ledger**, not PC, because the
invoice-list endpoint silently ignores the `filter` param. So Account 1
invoices → west, Account 2 invoices → centraal (TestTafel evenings get
folded into the centraal curve, which is acceptable for arrival-pattern
flow charts).

### "I want to test without writing to DB."

```bash
# End-to-end test against the production pipeline (no DB writes):
TEBI_BEARER_TOKEN='eyJ...' npx tsx scripts/test-new-tebi-path.ts

# Just the guest-count derivation (per-day per-loc table):
TEBI_BEARER_TOKEN='eyJ...' npx tsx scripts/tebi-derive-guests.ts

# Probe an account's history week-by-week to find when data started:
TEBI_BEARER_TOKEN_1='eyJ...' npx tsx scripts/probe-tebi-account1-history.ts
TEBI_BEARER_TOKEN_2='eyJ...' npx tsx scripts/probe-tebi-history.ts
```

### "I want to detect PC migrations / silent breakage."

```bash
# Auto-classify each (ledger, PC) over the last 8 weeks:
TEBI_BEARER_TOKEN_1='eyJ...' \
TEBI_BEARER_TOKEN_2='eyJ...' \
  npx tsx scripts/detect-pc-migrations.ts [--weeks 8]
```

The script walks every `revenue_profit_center_*` chart on every
configured account, fetches `product_top` for each of the last N weeks,
and emits a verdict per PC:

| Verdict | Meaning | Action |
|---|---|---|
| `HEALTHY` | Data in recent 2 weeks AND older weeks. | None — running fine. |
| `NEWLY_ACTIVE` | Data in recent 2 weeks but not older. | New location came online. Check `MEAL_ITEM_TYPE` covers the products. |
| `MIGRATION_CANDIDATE` | Data in older weeks but NOT in recent 2 weeks. | **PC went silent** — has the location moved to another ledger? Investigate. |
| `ALWAYS_SILENT` | No significant activity in the window. | None — empty PC, ignore. |

Exits 1 when any `MIGRATION_CANDIDATE` is detected so cron / CI can
surface the alert.

Activity floors: recent 2 weeks ≥ 10 qty, older weeks ≥ 50 qty
combined. Sub-floor noise (a single staff sale, a test transaction)
doesn't trip the alert.

This catches the failure mode that hid the original 7-week breakage:
when Centraal + TestTafel migrated from Account 1 to Account 2 around
2026-04-10, our scraper kept polling Account 1's now-dormant PCs for
weeks. Running this against both tokens periodically (or wired into
cron) would have surfaced "Account 1 Centraal/TestTafel went silent
mid-April" within ~2 weeks of the migration.

### "Something looks broken."

Run, in order:

```bash
DATABASE_URL_PROD="..." npx tsx scripts/diagnose-tebi-alltime.ts
DATABASE_URL_PROD="..." npx tsx scripts/diagnose-tebi-coverage.ts
DATABASE_URL_PROD="..." npx tsx scripts/diagnose-tebi-telemetry.ts
```

`-coverage.ts` is read-only and per-location: row counts, recent days,
unmatched products. `-telemetry.ts` prints stdoutTail/stderrTail for
recent `finance_sync_*` events — including the per-call ✓/✗ scraper
logs that pinpoint which Tebi endpoint is broken. `-alltime.ts` is the
all-time row-count summary.

---

## Build — rebuilding from scratch

If everything's blown up and you're rebuilding the integration, the
order to do it in:

1. **Get a Bearer token** (DevTools recipe). Confirm the token works
   by curling `GET /api/insights/ledgers/{id}/insights/dashboards/main`
   — should return a chart catalogue, not 401.

2. **Discover profit centers.** Walk `dashboardMain.chartGroups`, find
   charts with `id` starting `revenue_profit_center_`, extract the
   UUID suffix and the chart's `name` field. UUIDs scope per-ledger;
   don't hard-code.

3. **Per-day chart fetches.** For each PC, call
   `GET /charts/product_top?startDate=Y-M-D&endDate=Y-M-D+1&filter=<JSON>`.
   `endDate` is exclusive. The `filter` param is JSON-encoded, then
   URL-encoded.

4. **Parse `product_top` data.** Each entry has a `name` (product
   name) and a `metrics` array containing `TOTAL_PRODUCTS_SOLD`
   (qty) and `GROSS_REVENUE` (object `{quantity}`).

5. **Apply MEAL_ITEM_TYPE allowlist + reassignment rule + 30/70 staff
   split.** See `formatProductRevenueFromTop` and
   `deriveGuestCountsFromProductRows` in `scripts/tebi-scraper.js`.

6. **Write to DB.** Upsert ProductRevenue and GuestHistory by their
   compound unique keys.

7. **Wire into cron.** `lib/tebi-sync.ts` spawns `tebi-sync-worker.js`,
   which iterates accounts and dates and calls `runForAccount`. Strict
   exit-1 conditions catch silent failure modes — keep them.

8. **Add diagnostics first.** Don't ship the live sync until the three
   diagnose scripts work — they're how you'll catch the next breakage
   without spending 7 weeks unaware.

The Playwright login flow is the only piece that needs a real browser
session. Everything else is pure `fetch` + JSON parsing. If Playwright
breaks again, the bypass-Playwright path (Bearer-from-cURL) is the
fallback — and you can do all backfills + diagnostics from there.

---

## Maintain — common ops

### Adding a new ledger / Tebi account

The worker hard-codes two ledger slots:

```
TEBI_EMAIL  / TEBI_PASSWORD  / TEBI_LEDGER_ID    (default 723192 = West)
TEBI_EMAIL_2 / TEBI_PASSWORD_2 / TEBI_LEDGER_ID_2 (e.g. 724466 = Centraal+TestTafel)
```

For a third ledger, extend `scripts/tebi-sync-worker.js`'s `accounts`
array — there's no `_3` slot today. The pattern is straightforward;
the worker iterates `accounts` sequentially. Backfill scripts already
support `_1` / `_2` env-var pairing; add `_3` similarly if needed.

### Renaming a product

Update `MEAL_ITEM_TYPE` in **two** places in lockstep:

- `scripts/tebi-scraper.js`
- `public/js/predictions.ts` (the CSV-path categorizers)

If you want them to actually share, factor into `shared/`. Not worth
it unless the list grows.

### Rotating tokens

In production: tokens auto-refresh via Playwright login each cron tick.
No manual action needed unless Playwright login itself breaks.

For local probing / backfills: tokens last ~24h. When a token expires,
just paste a new cURL — the JWT's `exp` field tells you when (Unix
seconds). `iat`/`exp` are ~24h apart for fresh tokens.

### Schema changes

`prisma/schema.prisma` → create a migration with `npx prisma migrate dev`
(the project uses Prisma migration history — see `prisma/migrations/` and
the CLAUDE.md "Don't" rules; there is no `db:push` script). Bump the
unique-index columns carefully: `ProductRevenue` keys on
`(date, location, meal, productName)`, and changing this breaks
existing upserts.

### Updating allowed login markers

If Tebi reorganises the post-login UI, update `login()` body markers
in `scripts/tebi-scraper.js`:

```
Sign out / Dashboard / Select location / Refer a friend / Help & Support
```

The scraper logs the body excerpt on failure — feed it to the next
maintainer to update the list.

---

## Common failure modes

### "Cron exits 0 but wrote no useful data."

Can't happen since 2026-05-07 — the strict-exit condition makes that
combination exit 1, surfacing as `finance_sync_failed` with full
stdoutTail in telemetry. If you see this regress, treat the stdoutTail
as gold — it tells you exactly which endpoint silently 0'd out.

### "discoverProfitCenters finds zero."

Tebi has reorganised dashboardMain twice already (`groups → chartGroups`,
`chartType → id`). The walker is now tolerant of both shapes (tries
chartGroups, falls back to groups) and identifies charts by `id`
matching `revenue_profit_center_*`. If they reorganise again, the
diagnostic dumps the full dashboardMain JSON when discovery returns
zero — feed that back to update the walk.

### "Numbers look wrong."

Run `tebi-derive-guests.ts` with a fresh Bearer. Output is a per-day,
per-location table of derived lunch/dinner/staff. Eyeball against
expected. Check the "unmatched items" list at the bottom for any
product names that look like meals but aren't being counted.

If the issue is that a date is missing entirely:
- Check both ledgers (`probe-tebi-history.ts` / `…-account1-history.ts`)
- For dates before 2026-04-10, Centraal/TestTafel data lives on
  Account 1 (ledger 723192), not Account 2.
- For dates after 2026-04-10, Centraal/TestTafel data lives on
  Account 2 (ledger 724466).

### "Login fails."

Tebi reorganises the post-login UI every few months. Update markers
per "Updating allowed login markers" above. The scraper logs the
post-login body excerpt on failure.

### "Pre-commit hook hangs / fails on unrelated tests."

Likely jest scanning `.claude/worktrees/` (stale worktree code). The
guard is the `roots` setting in `package.json`'s `jest` config, which
scopes test discovery to the `test/` directory only:

```json
"jest": {
  "roots": ["<rootDir>/test"],
  "testMatch": ["**/*.test.ts"]
}
```

Don't widen `roots` back to the repo root.

### "Token expired mid-backfill."

The script will fail with 401s and an HTTP error log line per failed
day. Just refresh the Bearer (DevTools recipe) and re-run with
`BACKFILL_START` shifted to where it left off — the `DELETE_LOCATIONS`
filter and compound unique key together make re-runs idempotent.

### "Manual sync times out."

Bumped to 15 min as of 2026-05-07. If two ledgers × wide range still
hits this, raise `MANUAL_TIMEOUT_MS` in `lib/tebi-sync.ts`.

---

## File map

```
scripts/
  tebi-scraper.js              Standalone one-shot scrape. `npx tsx scripts/tebi-scraper.js [start] [end]
                               --dump-invoices --raw`. Source of truth for MEAL_ITEM_TYPE +
                               resolveLocationForItem + 30/70 staff split.
  tebi-sync-worker.js          Production cron entry point. Spawned by lib/tebi-sync.ts (manual UI sync)
                               and by server.ts (nightly cron at 04:30 UTC).
  tebi-derive-guests.ts        No-Playwright test of guest-count derivation. Takes TEBI_BEARER_TOKEN.
  test-new-tebi-path.ts        End-to-end test of the post-rewrite pipeline (no DB writes).

  diagnose-tebi-coverage.ts    Read-only DB report: per-location row coverage, Centraal verdict,
                               unmatched products. Imports MEAL_ITEM_TYPE from tebi-scraper.js.
  diagnose-tebi-alltime.ts     Quick all-time row counts.
  diagnose-tebi-telemetry.ts   Pulls recent finance_sync_* telemetry events with stdout/stderr tails.

  show-guest-history.ts        Pivot-table view of GuestHistory in terminal. FROM env var supported.
  export-guest-history-xlsx.ts Excel export (xlsx in repo root). FROM/TO env vars supported.

  backfill-tebi.ts             Parameterized backfill (any ledger/token/range/locations).
                               Deletes existing rows for DELETE_LOCATIONS within range, then
                               re-fetches and rewrites. Idempotent — re-runs are safe.
  backfill-tebi-flow.ts        Backfills GuestHistoryMeta.flowDistribution from invoice
                               timestamps. Two-token mode + location-level merge guard.

  probe-tebi-history.ts        26-week probe against Account 2 to find data boundaries.
  probe-tebi-account1-history.ts  Same for Account 1.

  detect-pc-migrations.ts      Auto-detect PC migrations: walks each (ledger, PC) for the
                               last N weeks and classifies activity (HEALTHY / NEWLY_ACTIVE /
                               MIGRATION_CANDIDATE / ALWAYS_SILENT). Read-only. Exits 1 if
                               any MIGRATION_CANDIDATE so cron/CI can react.

lib/
  tebi-sync.ts                 Spawn helper for the worker; keeps state for /api/finance/sync-status.
                               Telemetry hydration of last-known state. MANUAL_TIMEOUT_MS = 15 min.

routes/
  finance.ts                   /api/finance/* endpoints.
  guests.ts                    /api/guest-history (CSV-upload path) — separate from the auto path.

prisma/
  schema.prisma                DailyRevenue, ProductRevenue, GuestHistory, GuestHistoryMeta.
```

---

## Glossary

- **Ledger**: Tebi's term for one POS instance / Tebi account. Sering
  has two ledgers today (723192 = West, 724466 = Centraal + TestTafel).
- **Profit center (PC)**: A sub-area within a ledger (West, Centraal,
  TestTafel). Charts can be filtered to one PC via the JSON-encoded
  `filter` param. PC UUIDs scope per-ledger (don't carry across
  ledgers).
- **Cover**: Restaurant-speak for "guest served". Tebi tracks covers
  per invoice IF the cashier enters a number — Sering's volunteers
  don't, so `covers` is always 0. We derive guest counts from product
  items instead.
- **JWT azp**: The Auth0 application that issued the token. For Tebi
  it's a public SPA client (no client_secret), which is why we can't
  do password-grant exchange for automated token refresh — Playwright
  is the only refresh mechanism.
- **Misattribution**: TestTafel-PC items rung up before 18:00 are
  misattributed Centraal community-kitchen sales (staff forgot to
  switch the POS register). The `resolveLocationForItem` rule corrects
  these into Centraal in `ProductRevenue` / `GuestHistory`, but
  `DailyRevenue` per-PC rows are left as Tebi reports them.

## Future ideas (rough priority)

1. **Hourly resolution for staff meals.** Today we 30/70 split. A
   separate chart fetch per hour (with a PC filter) could give exact
   counts. ~1 hour of work; medium-low value.
2. **Use `product_categories` instead of `product_top` for the meal
   allowlist.** Category names ("Food", "Lunch") are more stable than
   product names. Risk: less granularity. Probably skip unless renames
   become a recurring problem.
3. **Bring `discounts` into the picture.** "Volunteer / staff
   discount" appears as a discount reason; might give a more reliable
   staff count than the "Staff & volunteer meals" product. Untested.
4. **Programmatic Bearer-token refresh.** Currently Playwright is the
   only refresh mechanism. If Tebi ever exposes a partner API or a
   service account, Playwright vanishes.
5. ~~**Auto-detect PC migrations.**~~ Done 2026-05-09 —
   `scripts/detect-pc-migrations.ts`. Standalone today; the natural
   follow-up is wiring it into the cron worker so a
   `MIGRATION_CANDIDATE` verdict emits a `finance_pc_migration_detected`
   telemetry event without failing the sync. That requires the worker
   to capture both Bearer tokens during sync and pass them to the
   detector after the day-loop completes, plus per-PC alert throttling
   so it doesn't fire every cron tick after first detection.

---

**Last updated:** 2026-05-08 — after the multi-stage Tebi UI/API drift
that broke the original scraper, plus the Centraal/TestTafel migration
to Account 2 (~2026-04-10), plus full historical backfill.

If you're reading this years later and nothing matches, run the
diagnostic scripts and update this doc with what you find.
