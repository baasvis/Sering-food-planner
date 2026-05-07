# Tebi integration — handoff doc

> **For future AIs / maintainers reading this cold.** The Tebi integration is
> the most fragile piece of the food-planner. This doc captures everything
> learned across the 2026-03 → 2026-05 series of breakages so the next person
> doesn't have to retrace it. Last fully verified: **2026-05-07**.

## What it is

Tebi is the POS (point-of-sale) system Sering's volunteers ring up sales on.
The food-planner pulls data from Tebi to populate two things:

1. **DailyRevenue / ProductRevenue** — the Finance screen's revenue dashboard
   (per-day, per-location, per-product gross/net).
2. **GuestHistory** — the Guests page (per-day, per-location, per-meal guest
   counts) which feeds the planner's predictions for upcoming weeks.

Originally the dashboard accepted CSV uploads (Tebi's "ProductOrdersReport"
or "ProductReportByProfitCenter" exports, plus Lightspeed for TestTafel).
That path still works (`public/js/predictions.ts` + `routes/guests.ts`) but
since 2026-05-07 the **scraper auto-populates GuestHistory** so users never
need to drop CSVs again under normal operation.

## Why scraping (and not a real API)

Tebi doesn't sell public/partner API access. The user (Daan) explicitly asked
support; the answer was no. So everything goes through the same `/api/...`
endpoints that the back-office UI hits, authenticated with the same
short-lived Bearer token. Two paths to that token:

- **Production cron**: Playwright logs in (`scripts/tebi-scraper.js`),
  intercepts the auth header from a real `/api/` request the SPA makes,
  reuses it for direct fetches inside the same browser context.
- **Local probing / debugging**: copy a Bearer token by hand from Chrome
  DevTools (right-click any `/api/...` row → Copy as cURL → paste). Token
  lasts ~24h. See `scripts/tebi-derive-guests.ts` and friends.

If a future Tebi update breaks the Playwright login flow again, the
**bypass-Playwright probing path** is what you should use to investigate —
plain `fetch` with a Bearer token works inside any environment, including
agentic harnesses where Chromium can't spawn.

## File map

```
scripts/
  tebi-scraper.js              # Standalone: one-shot scrape for diagnostics. Run via
                               # `npx tsx scripts/tebi-scraper.js [startDate] [endDate]
                               # --dump-invoices --raw`
  tebi-sync-worker.js          # Production cron entry point. Spawned by lib/tebi-sync.ts
                               # (manual UI sync) and by server.ts (nightly cron at 04:30 UTC).
  tebi-derive-guests.ts        # No-Playwright test of guest-count derivation. Takes
                               # TEBI_BEARER_TOKEN env var.
  test-new-tebi-path.ts        # End-to-end test of the post-rewrite pipeline (no DB writes).
  diagnose-tebi-coverage.ts    # Read-only DB report: per-location row coverage, Centraal
                               # verdict, unmatched products. Use this first when something
                               # looks off.
  diagnose-tebi-alltime.ts     # Quick all-time row counts for DailyRevenue / ProductRevenue
                               # / GuestHistory.
  diagnose-tebi-telemetry.ts   # Pulls recent finance_sync_* telemetry events with
                               # stderr/stdout tails — works even on success runs since the
                               # 2026-05-07 rewrite.

lib/
  tebi-sync.ts                 # Spawn helper for the worker; keeps state for
                               # /api/finance/sync-status. Telemetry hydration of last-known
                               # state lives here.

routes/
  finance.ts                   # /api/finance/* endpoints (revenue, products, sync,
                               # sync-cancel, sync-status). Thin wrapper over the DB.
  guests.ts                    # /api/guest-history (CSV-upload path) — separate from the
                               # auto-update path.

prisma/
  schema.prisma                # GuestHistory @@unique([location,meal,date]),
                               # DailyRevenue @@unique([date,location]),
                               # ProductRevenue @@unique([date,location,meal,productName]).
```

## Authentication

Tebi uses Auth0. The Bearer token is a JWT issued by `auth.tebi.co` (audience
`tebi-api`), valid ~24 hours. Decoded sample payload:

```json
{
  "tebi_email": "info@testtafel.nl",
  "iss": "https://auth.tebi.co/",
  "sub": "auth0|67c853ee...",
  "aud": ["tebi-api", "https://tebi.eu.auth0.com/userinfo"],
  "iat": 1778173492, "exp": 1778259892,  // ~24h apart
  "scope": "openid profile email",
  "azp": "0tGlVnSFHtEZwttnrsKKFzomyq9AWlyQ"  // public Auth0 client
}
```

The Auth0 `azp` (client) is a **public SPA client** — no client_secret. So we
can't grab a token via password-grant. Two practical implications:

- **Programmatic refresh isn't trivial.** A back-end service can't login as
  Daan without going through the Auth0 redirect flow with a real browser
  session. The Playwright login is, in practice, our refresh mechanism.
- **A leaked Bearer token is bounded by 24h.** If you accidentally paste one
  into a public place, just wait it out — there's no client_secret to rotate.

### Refreshing the token by hand

Use this when probing locally (the production cron handles its own refresh
through Playwright). Steps for a non-technical user:

1. Open Chrome → `https://live.tebi.co` → log in.
2. Press **F12**, click the **Network** tab.
3. Press **F5** to refresh, type `api` in the filter box.
4. Right-click any row whose URL contains `/api/...` → **Copy** → **Copy as
   cURL (bash)**.
5. Paste in chat or to a script. Look for the line `-H 'authorization:
   Bearer eyJ...'` and the URL on the first line.

## Endpoint catalogue (verified 2026-05-07)

All endpoints are at `https://live.tebi.co`. All require
`Authorization: Bearer <jwt>`. All return JSON (or an error JSON like
`{"message":"Not found","label":null,"validation":[]}` on 4xx).

### Insights / dashboards (the primary surface)

| Path | What it returns | Notes |
|---|---|---|
| `GET /api/insights/ledgers/{id}/insights/dashboards/main` | The full chart catalogue for the dashboard. | Includes `chartGroups[].charts[]` with `id`, `name`, `description`, `primaryMetric`, `metrics`, `groupings`, `filter`. **Walk this to discover available charts.** |
| `GET /api/insights/ledgers/{id}/insights/data/charts/{chartId}?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&mock=false&limit=-1` | Time-series data for the chart (gross/net/sales/...). | `endDate` is **exclusive**. Pass `&filter=<json>` for a profit-center filter (see below). |

**Key chart IDs** (from probing dashboardMain.chartGroups):

| Chart ID | Group | Metrics | What we use it for |
|---|---|---|---|
| `revenue_overview_chart` | revenue_metrics | GROSS_REVENUE, NET_REVENUE | Daily totals → DailyRevenue 'all' row |
| `revenue_profit_center_<UUID>` | revenue_metrics | GROSS_REVENUE, NET_REVENUE | Per-location revenue → DailyRevenue per-loc rows |
| `number_of_sales_chart` | revenue_metrics | NUMBER_OF_SALES | DailyRevenue.sales |
| `covers_count_chart` | revenue_metrics | COVERS_COUNT | DailyRevenue.covers (often 0 — Sering's POS doesn't track covers per invoice) |
| `orders_chart` | revenue_metrics | ORDER_AMOUNT, NUMBER_OF_ORDERS | Not currently used (existing scraper passes 'ORDERS' as metric name, doesn't match — orders=0) |
| `product_top` | product_metrics | GROSS_REVENUE, TOTAL_PRODUCTS_SOLD | **Per-product breakdown — the key endpoint for guest counts.** Always grouped by ITEM (default and only). |
| `product_categories` | product_metrics | GROSS_REVENUE, TOTAL_PRODUCTS_SOLD | Per-category breakdown (Food / Beer / Coffee & tea / etc.). Not currently used. |
| `total_products_sold` | product_metrics | TOTAL_PRODUCTS_SOLD | Sum of products sold. Grouped by TIME_DAY. |
| `discounts` | service_metrics | DISCOUNT_AMOUNT | Per-reason discount totals. "Volunteer / staff discount" is a category — could be an alternative source for staff-meal counts (untested). |
| `tips` | service_metrics | TIPS | Daily tip totals. |
| `reservation_count` | reservation_metrics | RESERVATION_CHECKED_IN_COUNT, WALKINS, … | Reservations data. Always 0 at Sering (we don't take reservations). |

### Profit-center filter (chart endpoints)

To scope a chart to one profit center (Sering West / Sering Centraal /
TestTafel), pass `&filter=<URL-encoded JSON>`:

```
?filter=%7B%22grouping%22%3A%22PROFIT_CENTER%22%2C%22value%22%3A%2227c33042-47c1-4650-8e76-37c7bfef86dd%22%7D
```

Decoded: `{"grouping":"PROFIT_CENTER","value":"27c33042-47c1-4650-8e76-37c7bfef86dd"}`

JSON-encoded `filter` was the breakthrough that unblocked per-PC product
data. Anything else (raw string, key=value, array form) is silently ignored
or 400s.

The grouping URL parameter (`grouping=ITEM`, `groupBy=ITEM`, etc.) is
**silently ignored**. Charts return their built-in grouping only. To get
combined groupings (e.g. per-day per-product), you have to call the chart
once per day.

### Profit-center UUIDs (Ledger 1, ledger ID 723192)

| Name | UUID | Notes |
|---|---|---|
| Sering West | `00000000-0000-0000-0000-000000000000` | Was the "all" sentinel before 2026-05-07. Now West proper. |
| Sering Centraal | `27c33042-47c1-4650-8e76-37c7bfef86dd` | Empty in this ledger (~0 rows recent days) — Centraal moved to Ledger 2 a while ago. |
| TestTafel | `a904a975-6bd2-413f-8e02-dc457b87a6e3` | Empty in this ledger. |

`scripts/tebi-scraper.js` rediscovers these every run via `discoverProfitCenters`
(which walks dashboardMain.chartGroups for charts with `id` starting
`revenue_profit_center_`). Don't hard-code UUIDs in production code; they
might change. The diagnostic scripts hardcode them only for convenience.

### Invoicing (degraded as of 2026-05-07)

| Path | Returns |
|---|---|
| `GET /api/invoicing/ledgers/{id}/sales/invoices?page=N&pageSize=N&startDate=...&endDate=...` | Invoice **summary list** — paginated. Each item has `key, sequenceNumber, name, created, closedTime, businessDay, receiptUrl, guest, netRevenue, grossRevenue`. **No `items` / `lines` / `lineItems`.** |

The scraper still calls this endpoint to populate `DailyRevenue.invoiceCount`.
Don't try to parse line items from it — they're gone. The `product_top` chart
replaces that path.

The response key was renamed `content → data` around 2026-05-07. The scraper
reads either (`Array.isArray(invoices.data) ? invoices.data : invoices.content`)
to be robust against revert.

### Things that DON'T exist (and probably never did)

The scraper authenticates against the dashboard's internal API; no
"reports" or "exports" namespace is reachable from this auth context. All of
these returned 404:

```
/api/insights/ledgers/{id}/insights/dashboards         (no list endpoint)
/api/insights/ledgers/{id}/insights/dashboards/products  (only `main` exists)
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

## Data pipeline

```
Cron (server.ts, 04:30 UTC)
  └─ runTebiSync (lib/tebi-sync.ts)
       └─ spawn scripts/tebi-sync-worker.js
            └─ for each configured ledger (TEBI_LEDGER_ID, TEBI_LEDGER_ID_2):
                 ├─ login (Playwright) → captures Bearer token
                 ├─ for each day in date range:
                 │    ├─ runForAccount (scripts/tebi-scraper.js)
                 │    │    ├─ discoverProfitCenters → west / centraal / testtafel UUIDs
                 │    │    ├─ fetchDayData
                 │    │    │    ├─ overview / orders / sales / covers / averages charts
                 │    │    │    ├─ revenue_profit_center_<uuid>  (per PC)
                 │    │    │    ├─ product_top filtered by PC      (per PC)  ← new
                 │    │    │    └─ /sales/invoices                  (for invoiceCount only)
                 │    │    ├─ formatResults → summary
                 │    │    ├─ formatProductRevenueFromTop → productRows  ← new
                 │    │    └─ deriveGuestCountsFromProductRows → guestCounts  ← new
                 │    └─ saveResults
                 │         ├─ upsert DailyRevenue ('all' + per-loc)
                 │         ├─ upsertProductRevenue
                 │         └─ upsertGuestHistory   ← new
                 └─ stats logged: allRows / perLocationRows / productRows / guestRows
       └─ exit:
            - exit 1 if zero rows written for any account/date
            - exit 1 if every account failed
            - exit 1 if 'all' rows wrote but ZERO per-location AND ZERO product rows
              (catches the silent partial-failure mode that hid the breakage for ~7 weeks)
```

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
```

The new sync writes meals as `lunch` / `dinner` / `staff` for matched products
and `other` for everything else (drinks, snacks). This keeps the unique key
working even though we no longer have per-transaction service-period data.

## The meal-product allowlist

`scripts/tebi-scraper.js` `MEAL_ITEM_TYPE`:

```js
{
  'Lunch':                   'lunch',
  'Lunch card guest':        'lunch',
  'Dinner donation':         'dinner',
  'Stadspas Dinner':         'dinner',
  'DSC Dinner':              'dinner',
  'Staff & volunteer meals': 'staff',
}
```

**Important distinction**: `"Lunch card"` (the bulk-buy CARD) is NOT in this
list — those rows are donor purchases, not guests served. The actual guest
event is `"Lunch card guest"`, which IS in the list. Mirrors
`public/js/predictions.ts` exactly.

If Sering's POS gets new product names (renames, new SKUs), update
`MEAL_ITEM_TYPE` and the same constant in `predictions.ts`. The diagnostic
scripts (`diagnose-tebi-coverage.ts`, `tebi-derive-guests.ts`) print
"unmatched products" so you can spot what's escaping the allowlist.

### Staff lunch/dinner split

`product_top` doesn't carry per-hour data and the `Staff & volunteer meals`
item is one bucket. We split it 30/70 lunch/dinner as a default heuristic
matching the typical Sering pattern (more staff stay through dinner). If
you want exact numbers, you'd need to fetch a separate hourly chart and
correlate by service period — not currently done. Refining this is a
nice-to-have.

## Common failure modes + diagnosis

### "GuestHistory isn't updating"

Run, in order:

```bash
# 1. Are recent rows even present?
DATABASE_URL_PROD="..." npx tsx scripts/diagnose-tebi-alltime.ts

# 2. What does the per-location coverage look like?
DATABASE_URL_PROD="..." npx tsx scripts/diagnose-tebi-coverage.ts

# 3. What did the last sync actually do?
DATABASE_URL_PROD="..." npx tsx scripts/diagnose-tebi-telemetry.ts
```

The telemetry script prints stdoutTail/stderrTail for each recent
finance_sync_complete + finance_sync_failed event — including the per-call
✓/✗ scraper logs that pinpoint which Tebi endpoint is broken.

### "Numbers look wrong"

Run the no-Playwright derivation against a fresh Bearer token:

```bash
# Get a token via the DevTools recipe above, then:
TEBI_BEARER_TOKEN='eyJ...' npx tsx scripts/tebi-derive-guests.ts
```

Output is a per-day, per-location table of derived lunch/dinner/staff. Check
the numbers against what you expect Sering ran that week. Eyeball the
"unmatched items" list at the end for any product names that look like
meals but aren't being counted.

### "Login fails"

Tebi reorganises the post-login UI every few months. Login detection lives
in `scripts/tebi-scraper.js` `login()` and looks for body markers:

```
Sign out / Dashboard / Select location / Refer a friend / Help & Support
```

If a future redesign breaks this, add the new markers. The scraper logs
the body excerpt on failure so you can see what page Tebi actually showed.

### "discoverProfitCenters finds zero"

Tebi has reorganised dashboardMain twice already (`groups → chartGroups`,
`chartType → id`). The walker is now tolerant of both shapes (tries
chartGroups, falls back to groups) and identifies charts by `id` matching
`revenue_profit_center_*`. If they reorganise again, the diagnostic dumps
the full dashboardMain JSON when discovery returns zero — feed that back
to the maintainer (human or AI) to update the walk.

### "Cron exits 0 but wrote no useful data"

Can't happen any more — the strict-exit condition added 2026-05-07 makes
that combination exit 1, surfacing as `finance_sync_failed` with full
stdoutTail in telemetry. If you see this, treat the stdoutTail as gold —
it tells you exactly which endpoint silently 0'd out.

## Maintenance ops

### Adding a new ledger / Tebi account

Today the worker hard-codes two ledger slots:

```
TEBI_EMAIL  / TEBI_PASSWORD  / TEBI_LEDGER_ID    (default 723192 = West)
TEBI_EMAIL_2 / TEBI_PASSWORD_2 / TEBI_LEDGER_ID_2 (e.g. 724466 = TestTafel + Centraal)
```

For a third Tebi account / ledger you'd need to extend `scripts/tebi-sync-worker.js`'s
`accounts` array — there's no `_3` slot today. The pattern is straightforward;
the worker iterates `accounts` sequentially.

### Renaming a product

Update `MEAL_ITEM_TYPE` in **two** places in lockstep:

- `scripts/tebi-scraper.js`
- `public/js/predictions.ts` (the CSV-path categorizers)

If you want them to actually share, factor into `shared/`. Not worth it
unless the list grows.

### Forcing an immediate sync

UI: `/dashboard/finance` → "Sync from Tebi" button.

CLI:

```bash
# Run the full worker for a custom range (writes to DB):
npx tsx scripts/tebi-sync-worker.js 2026-04-25 2026-05-07

# Or hit the API endpoint directly:
curl -X POST https://<your-host>/api/finance/sync \
  -H 'Cookie: <session cookie>' \
  -H 'Content-Type: application/json' \
  -d '{"startDate":"2026-04-25","endDate":"2026-05-07"}'
```

### Backfilling GuestHistory

If you want to seed historical guest counts (the user already has
`GuestHistory` rows from CSV uploads up to 2026-03-21), trigger a manual
sync over the gap window. The new pipeline will overwrite anything
overlapping. To be safer, run with a smaller window first to spot-check.

## Future ideas (in rough priority order)

1. **Hourly resolution for staff meals.** Today we 30/70 split. A separate
   chart fetch per hour (with a profit-center filter) could give exact
   counts. ~1 hour of work; medium-low value.
2. **Use `product_categories` instead of `product_top` for the meal allowlist.**
   The category names ("Food", "Lunch") are more stable than individual
   product names. Risk: less granularity. Probably skip unless product
   renames become a recurring problem.
3. **Bring `discounts` into the picture.** "Volunteer / staff discount"
   appears as a discount reason; might give us a more reliable staff count
   than the "Staff & volunteer meals" product. Untested.
4. **Programmatic Bearer-token refresh.** Currently Playwright is the only
   refresh mechanism. If Tebi ever exposes a partner API or a service
   account, the entire Playwright dependency vanishes.
5. **Hardening.** The strict-exit + tail-on-success pair already covers
   silent failure. The remaining hardening is around partial-day coverage
   (e.g. one PC's chart fails but others succeed — currently logged but
   doesn't fail the sync). Probably fine as-is.

## Glossary

- **Ledger**: Tebi's term for one POS instance. De Sering has Ledger 1
  (`723192`, West) and Ledger 2 (`724466`, "TestTafel + Centraal", per
  the worker's label — though Centraal may be empty there now too).
- **Profit center**: A sub-area within a ledger (West, Centraal,
  TestTafel). The dashboard charts can be filtered to one PC.
- **Cover**: Restaurant-speak for "guest served". Tebi tracks covers per
  invoice IF the cashier enters a number. Sering's volunteers don't, so
  `covers` is always 0 — we derive guest counts from product items
  instead.
- **JWT azp**: The Auth0 application that issued the token. For Tebi,
  it's a public SPA client (no client_secret), which is why we can't
  do password-grant exchange for an automated token refresh.

---

**Last updated:** 2026-05-07 — after the multi-stage Tebi UI/API drift
that broke the original scraper. If you're reading this years later and
nothing matches, run the diagnostic scripts and update this doc with what
you find.
