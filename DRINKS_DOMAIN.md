# DRINKS_DOMAIN — the drinks domain spec for the Sering Food Planner

*Everything the codebase can't tell you about how De Sering's drinks actually work. Source of truth for the drinks module. Extracted from the live Google Sheets (inventory 2026, Cocktail Batch Recipe Database, cocktail calculator, wine form 1.0, Bar training doc) in June 2026.*

---

## 1. Business context

Three service contexts, two physical sites:

| Key | Site | What it is | Drinks character |
|---|---|---|---|
| `west` | Sering West (Rhôneweg 6) | Community kitchen + café + bar, biggest volume | Full program: tap + can beer, house wines, cocktails (premixed), homemade non-alc, coffee/tea |
| `centraal` | Mediamatic (Dijksgracht 6) | Sering Centraal lunch/dinner + terrace | Shares physical stock with TestTafel; growing |
| `testtafel` | Mediamatic, same building | Fine-dining tasting menu Wed–Sat eve | **An assortment, not a stock location**: natural wines + homemade non-alc pairing program drawing on the Mediamatic stock pool |

Staff: many first-job volunteers — UIs must be obvious, mobile-friendly, and forgiving (undo pattern). Egalitarian culture: open editing, money fields manager-gated.

## 2. Data model

### Drink
The central entity. `mode: 'catalogue' | 'recipe'`.

Common fields: name, mode, category, subtype, ABV (%), BTW rate (auto from ABV, overridable), supplier (for bought), order unit + pack description (e.g. "crate (24×200ml)"), deposit amount (statiegeld, €, default 0), `tebiProductNames: string[]`, per-location: stock, par (target), active-in-location, price overrides. Status: `draft | published`. Info fields (mainly wine): producer/winery, region/country, vintage, soil, grape(s), natural/bio flags, flavour profile, tasting notes, "extra info".

Serving formats (1–n per drink): `{ name, volumeMl, priceByLocation, glassType }` — e.g. Pils: tap glass 250ml €3.70; House white: glass 120ml €5.50 + bottle 750ml €30; Vodka: shot 40ml €4 + mixed-drink dose 45ml (priced via recipe). A sale of a format fractionally depletes the stock unit (keg, bottle) — **math implemented, not wired to live sales until Phase 2**.

Recipe-mode extras: ingredient rows, prep steps (ordered list), per-serve volume + glass + serve-with (garnishes), serving temperature, batch definition `{ defaultBatchServings or volume, bottleSizeMl, yieldBottles (derived) }`, prep time minutes `{ prebatchMin, perServeMin }`, seasonality, characteristics (primary + up to 3), shelf-life days (default 7 for homemade).

### DrinkIngredientRow
`{ drinkId, sortOrder, ref: { kind: 'ingredient', ingredientId } | { kind: 'drink', drinkId }, amount, unit (ml/g/piece) }`. The `drink` kind is how building blocks nest (Super Sugar Syrup in Espresso Martini; Kombucha Base in Kombucha). Support ≥2 nesting levels; detect cycles.

### Categories (`category` × `mode`)
- catalogue: `beer` (subtypes: lager, pilsner, IPA, pale ale, white, porter, weizen, 0.0), `wine` (white, red, rosé, orange, bubbles, cider, 0.0), `spirits` (vodka, gin, rum, white rum, tequila, mezcal, bourbon, liqueur, salmari, sake, NA-aperitif), `soft` (cola, lemonade, soda, juice, water, mate), `coffee-tea-stock` (beans, oat milk, tea, chai, decaf), `consumables` (straws, filters, cups — `sellable: false`), `glassware` (`sellable: false`, no depletion)
- recipe: `cocktail`, `homemade-na` (ice tea, lemonade, kombucha, spritz), `coffee-drink` (espresso, cappuccino, oat latte, filter, chai), `building-block` (syrup, super-juice, infusion, tea-base, kombucha-base — stockable in litres/bottles, usually not sold directly)

### Supplier (drinks)
`{ name, orderDays[], orderCutoff, deliveryDays/window, contact { email, phone, url }, minimumOrder (€ or note), notes }`. **No credentials** — portal logins stay in env/secret storage, never in DB seed.

### DrinkOrder (lifecycle)
`draft → ordered → received` (+ `cancelled`). Fields: location, supplier, lines `{ drinkId|ingredientId, orderedQty, orderUnit, receivedQty?, substitutedBy? }`, orderedBy/At, expectedDelivery, receivedBy/At. Receiving applies line `receivedQty` (and substitutions) to stock.

### DrinkProductionLog
`{ drinkId (recipe), location, batches/volume made, bottlesYielded, madeBy, madeOn, expiresOn (madeOn + shelfLife), status: fresh|expired|discarded }`. Recording: ingredient rows × scale **decrement** ingredient/building-block stock; premix bottles **increment** drink stock.

### DrinkWriteOff
`{ ref (drink|ingredient), location, qty, unit, reason: breakage|spillage|expired|staff-drink|comp|other, note, who, when }`. Decrements stock. These split Phase-2 variance into explained vs unexplained.

### Assortment & DrinkMenu
Assortment: named drink list per service context (`West bar`, `Centraal`, `TestTafel`), entries reference drinks + which serving formats are offered. DrinkMenu: built from an assortment — grouped sections (category or custom), item order, layout preset `{ columns: 1|2, sectionStyle, typeScale }`, shows live per-location prices, print-ready (print CSS like Recipe v2's A4 view).

## 3. Stock semantics

- Stock is **one pool per location**, but counts are entered and **stored per storage area** (area set per location via the existing storage-config pattern), summing to the pool. Keep per-area history so tiers can split later.
- Stocktakes count in **supplier units** (kegs, crates, trays, bottles, packs, litres for homemade) — exactly like the sheet. Fractional sales depletion may make theoretical stock non-integer; that's expected (precision floor = partial pack).
- West storage areas (real, from the sheet): `Keg Storage: Shelf 1–4 / Floor`, `Drinks Storage: Left 1–3 / Center 1–2 / Right 2–5`, `Tea & Liquor Shelf`, `[Shelf Under Bar 1]`, `Walk-In FoH Top / Bottom`, `Freezer`, `Kitchen Back Storage`, `Under 'De Sering' Flag`, `Wine lowboy door 1–3`. Mediamatic areas: seed placeholders (`Bar fridge`, `Cellar`, `Dry storage`, `Wine storage`) — staff rename in-app.
- Shared kitchen ingredients (lemons, limes, mint, ginger, sugar, aquafaba, citric acid, coffee beans, oat milk…) live in the existing **Ingredient DB as one shared pool** — drinks recipes reference them there; do **not** duplicate them as Drinks. Bar par levels for such items = the Ingredient's existing per-location `targetStock`; drinks ordering may surface them on a "bar list" but ordering executes through the existing ingredient/Hanos pipeline.

## 4. Costing & pricing

- **Ingredient cost** per serve/batch: Σ rows (amount × unit cost). Ingredient rows: unit cost from Ingredient DB (`pricePer100`-derived). Drink rows (building blocks): unit cost = that drink's **computed cost per ml** (recursive; cycle-safe; memoise per recalc).
- **Labour**: `(prebatchMin / batchServings + perServeMin) × labourRate`. Default labourRate **€0.29/min (€17.30/h** — the wine-form value; the older calculator used €0.27/min). Config constant, manager-editable.
- **BTW**: ABV ≥ 0.5% → 21%; else 9%. Overridable per drink. (0.0% beer = 9%.)
- **Total cost** = ingredient cost + labour. Show ex-BTW.
- **Markup metric**: `markup = price_exBTW / totalCost`. Target markup per category (manager-set). **Suggested price** = `totalCost × targetMarkup`, converted to incl-BTW, **rounded to nearest €0.10**.
- **Starting targets**: computed at seed time per category from the seeded real prices vs computable costs (reverse-engineered status quo); where cost unknown, leave target null and fall back to category default 4.0×.
- Traffic-light: drink's actual markup vs category target (±10% amber band). Never block saving.

## 5. Workflows

### Stocktake (supplier-cycle)
Primary entry: "Count for a supplier" — pick supplier (those with an order day today/tomorrow surfaced first) → list that supplier's items for this location grouped by storage area → enter counts in supplier units (`2 crates + 7 loose` style input allowed but stored as decimal supplier-units) → bulk save (timestamped `dateChecked` per item). Secondary entry: by storage area (full count). Mobile-first: big inputs, sticky save.

### Ordering
Order screen per location: suggested lines = `par − stock` per supplier (only positives), shown in order units with deposits and minimum-order warnings; **demand nudge**: if upcoming week's guest counts (existing GuestHistory/next-weeks data) exceed the trailing average by >25%, show a banner suggesting upping par-driven quantities (no auto-change). Manager publishes order → `ordered` (records who/when + expected delivery from supplier delivery window). Receiving: line-by-line, adjustable quantities, substitution picker (any drink/pack of same category), applies to stock, logs everything.

### Production (homemade)
"To make" list: recipe drinks + building blocks where `stock < par`, expressed in litres/bottles. Record production: choose scale (servings/litres — show the 1×/10×/40× style math), confirm ingredient availability, save → ingredients ↓, premix/building-block stock ↑, log maker + made-on, expiry = made-on + shelf-life. Expired items surface on a "check freshness" list → discard action creates an `expired` write-off.

### Write-offs
One tap from any item row: qty + reason (+ optional note). Available to all users.

### Recipes & experimentation
Anyone creates drafts; live cost + suggested price visible while editing. Publish (any user) puts it on service cards/stocktake/order lists. Manager-gated: price fields, markup targets, supplier edits, menu publishing.

### Service cards (bartender mode)
Per assortment: searchable grid of published drinks → tap = full-screen card: build steps, glass, serve volume, garnish, premix dose (e.g. "120 ml premix, shake, strain"). Read-only, large type, dark-mode friendly.

### Menu designer
Build from assortment; drag order; group by category or custom sections; layout presets (1–2 columns, section styles, type scale); live prices for the menu's location; print via print-CSS (A4). Saved menus re-render with current prices.

## 6. Enums (seed as editable lists)

- **Glass types** (volumeMl): Beerglass 25 (250), Beerglass 33 (330), Waterglass (250), Cocktail glass (330), Tumbler (210), Wine glass small (120), Cappuccino glass (160), Americano glass, Pitcher (1000), Wine bottle (750), Wine bottle (1000).
- **Serve-with / garnish**: ice, straw, lemon slice, lime slice, grapefruit slice, orange slice, smoked salt, salt, foam, coffee beans, lavender seeds, Earl Grey tea, star anise, fresh herbs.
- **Characteristics**: acidic/zesty/crispy, sweet, jam/sweet, sour, light, heavy, green/mineral, earthy/herbal, tannine, salty, bubbles, bitter, smokey, citrusy, fruity, herbal.
- **Serving temps**: freezing, cold (strained no ice), cold (strained on ice), cold (pour over ice), room temperature, warm, hot, wine-cooler lower/middle/top.
- **Write-off reasons**: breakage, spillage, expired, staff-drink, comp, other.

## 7. Phase-2 readiness (do not build, do not break)

Later: Tebi `ProductRevenue` rows (per product/day/location) × `tebiProductNames` mapping × serving-format depletion + recipe depletion ⇒ theoretical stock; vs counted stock + received orders + production + write-offs ⇒ explained vs unexplained loss. Phase 1 must therefore keep: accurate receiving, production depletion, write-off reasons, format volumes, premix bottle tracking.

## 8. Defaults & known gaps (placeholder convention: `"PLACEHOLDER"` / `null` + `todo` note field)

- Keg size: Two Chefs beer kegs assumed **20L** — `todo: confirm per beer`. Wine keg (Tule Bianco) **confirmed 20L @ €130 ex BTW** (Troppo keg program, list Mar 2024).
- Troppo terms (from their list): min €500 ex VAT for free delivery inside the Amsterdam ring, else €20 ex VAT fee; volume discounts; payment 14 days; orders only to wine@troppogiovane.nl, new thread per order.
- Tap pour 250ml default (menus show 0.33L for some — per-drink format volumes in seed where known).
- Coffee builds (doses/volumes) are drafted estimates — flagged `todo` per recipe.
- Mediamatic storage areas + pars: placeholders; West pars are real (sheet, June 2026).
- Supplier order-day conflicts: 2026 sheet wins (e.g. Kweker Tue+Thu in sheet vs Wed+Sat in 2024 wine form) — both noted in seed `notes`.
- **Supplier price lists exist as PDFs** (found in email, March–April 2026): Troppo `Troppo_Horeca_March_2026.pdf`, Daxivin `HORECA MRT 2026.pdf`, Pomme d'Or `Prijslijst februari2026 Cider horeca def.pdf`, Yoigokochi `product list 2024 HORECA` (still valid; prices ex VAT, €21 flat delivery). If these PDFs are placed in `seeds/pricelists/`, parse them at seed time to fill the null `costPrice` fields; otherwise leave the `todo` flags.
- Initial stock values = the sheet's last counts (dated 21/5–1/6 2026) — they're stale by run time; first real stocktake corrects.

## 9. Touch-points with the existing app (the only allowed modifications outside new drinks files)

1. `NAV_SCREENS` + nav/tutorial/css registration for new screens.
2. Read-only use of Ingredient DB (and its suggest endpoint) for recipe rows; bar items may set `targetStock` on existing ingredients.
3. `MANAGER_EMAILS` env + `requireManager` middleware alongside the existing director mechanism.
4. Storage-config: extend per-location areas with drinks areas (reuse existing storage config storage).
5. Read-only use of guest history/next-weeks for the ordering demand nudge.
6. Optional reuse of the shipments pattern for batch transfers (additive).
7. `DESIGN.md` Section 3 paragraph + tutorial entries (mandated by repo rules).
