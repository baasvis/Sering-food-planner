// ─────────────────────────────────────────────────────────────────────────────
// SHARED TYPES — used by both backend and frontend
// ─────────────────────────────────────────────────────────────────────────────

// ── String literal unions ──

export type PermanentLocation = 'west' | 'centraal';
/** Location keys: the two permanent restaurants plus runtime event-location
 *  slugs ("ev-…", temporary festival/catering sites). The `(string & {})`
 *  keeps IDE autocomplete for the two literals while accepting registry
 *  slugs; runtime validity is enforced against the registry — backend via
 *  lib/locations.ts, frontend via S.eventLocations. */
export type Location = PermanentLocation | (string & {});
export type Meal = 'lunch' | 'dinner';
export type DishType = 'Soup' | 'Main course' | 'Dessert';
export type StorageType = 'Gastro' | 'Frozen' | 'Vac-packed';
export type SaveState = 'saved' | 'unsaved' | 'saving' | 'error';

// ── Recipe ingredients (from Google Sheets import) ──

export interface RecipeIngredient {
  name: string;
  amount: number;
  rawAmount?: number;
  cookedAmount?: number | null;
  unit: string;
  source?: string;
  cost?: number;
}

// ── Catering dish reference ──

export interface CateringDish {
  dishId: string;
  name: string;
  type: DishType;
}

// ── Catering topping reference (links to a Supply row by id) ──

export interface CateringTopping {
  supplyId: string;
  amount: number;
}

// ── Storage config (per-location) ──

export interface StorageArea {
  name: string;
  color: string;
  spots: string[];
  order?: number;
}

export interface StorageConfig {
  [location: string]: StorageArea[];
}

// ── Core data types ──

export interface Service {
  loc: Location;
  date: string;        // "YYYY-MM-DD"
  meal: Meal;
  /** Pinned by a cook via the 📌 on the planner chip: Fix My Menu must not
   *  remove this assignment (stripFutureServices keeps it; the batch's other
   *  services stay redistributable). Absent = not pinned. Lives inside the
   *  batches.services JSON column — no schema migration. */
  pinned?: boolean;
}

// Bumped on every breaking Batch shape change. Frontend SSE handler will
// force a reload when the server's BATCH_SCHEMA_VERSION doesn't match the
// value embedded in the bundle (consumed in Checkpoint 2).
export const BATCH_SCHEMA_VERSION = 2;

// Settled stock physically present at a location, available to serve.
// Multiple entries per (loc, storage) are allowed — e.g. two cookDates of
// the same Gastro stock at West sit as two entries until consolidated.
export interface InventoryEntry {
  loc: Location;
  storage: StorageType;
  qty: number;          // liters
  cookDate: string;     // DD/MM/YYYY — freshness origin (resets on freeze)
}

// In-flight stock between locations. Not yet at the destination's inventory.
export interface Shipment {
  id: string;
  fromLoc: Location;
  toLoc: Location;
  storage: StorageType; // storage type during transit; default destination storage
  qty: number;
  sentAt: string;       // ISO timestamp
  arrived: boolean;
  arrivedAt?: string;   // ISO timestamp, present iff arrived
  cookDate: string;     // carried from source InventoryEntry on /ship (DD/MM/YYYY)
}

export interface Batch {
  id: string;
  name: string;
  type: DishType;
  recipeId: string | null;
  serving: number;
  cookDate: string | null;            // primary cook date (= initial inventory entry cookDate)
  inventory: InventoryEntry[];        // settled stock, available to serve
  shipments: Shipment[];              // in-flight stock (NOT yet at destination)
  services: Service[];
  allergens: string[];
  extraAllergens: string[];
  note: string;
  cookNotes: string;
  actualIngredients: ActualIngredient[] | null;
  orderFor: boolean;
  // Fix My Menu: true only for placeholders the algorithm created and that are
  // safe to clean up automatically on the next run. Optional so existing
  // (pre-migration) deserialized rows are still valid Batch values.
  generated?: boolean;
  stockDeducted: boolean;
  createdAt: string;
}

export interface KitchenEquipment {
  pots: number[];           // sizes in liters, e.g. [140, 140, 100, 100, ...]
  gasBurners: number;       // burners that can handle pots > bigBurnerThreshold
  inductionBurners: number; // burners that handle pots ≤ bigBurnerThreshold
  bigBurnerThreshold: number; // typically 80 — pot size that requires a gas burner
}

// ── Cook rhythm config (editable Fix My Menu rules) ──
// One entry per weekday name ('Mon'..'Sun'). Drives how many placeholder cook
// events Fix My Menu generates per day per type, and the per-day cook capacity
// used by the workload-overload heuristic. A "closed" day is soup=0 & main=0.
export interface CookRhythmDay {
  soup: number;   // target soup cook events that day
  main: number;   // target main-course cook events that day
  chefs: number;  // cook capacity weight: a day's tolerated cook volume = its chefs
                  // ÷ the week's total chefs × the week's guest demand. More chefs =
                  // bigger share before Fix My Menu warns about overloading the day.
}

export interface CookRhythmConfig {
  days: Record<string, CookRhythmDay>; // keyed by 'Mon'..'Sun'
}

// ── Cost-per-guest targets ──
// Director-set targets the West-tab cost bar steers against. All values are
// euros per guest except foodCostPct (a percentage). The total €/guest target
// is derived (soup + main + topping). revenuePerGuestOverride lets a director
// pin the food-cost-% denominator instead of the rolling Tebi auto value
// (null = use auto). One set applies to both meals + both locations for now.
export interface CostTargets {
  soup: number;                       // € per guest
  main: number;                       // € per guest
  topping: number;                    // € per guest (toppings & bread)
  foodCostPct: number;                // target food cost as % of revenue (e.g. 25)
  revenuePerGuestOverride: number | null; // € per guest, or null = auto from Tebi
  reservePercent: number;             // production reserve: cooking/coverage/order demand is silently padded by this % (0 = off). Cook-editable on the West planner via the open /cost-reserve endpoint; the padding is folded into demand with no separate line item.
}

// ── Closed services config ──
// Marks a service (location + meal) as closed — no seating, but any guest/staff
// demand registered to it rolls onto the previous open service at the same
// location (see core.ts getEffectiveGuests / previousOpenService). Default
// (empty recurring) closes nothing, so behaviour is unchanged until configured.
export interface ClosedServiceOverride {
  loc: Location;
  closed?: Meal[]; // meals forced closed on this specific date
  open?: Meal[];   // meals forced open on this date (overrides a recurring closure)
}
export interface ClosedServicesConfig {
  // recurring[location][weekday 'Mon'..'Sun'] = meals closed every week.
  recurring: Record<string, Partial<Record<string, Meal[]>>>;
  // dates[ISO 'YYYY-MM-DD'] = one-off overrides, checked BEFORE recurring.
  dates?: Record<string, ClosedServiceOverride[]>;
}

export interface GuestDay {
  lunch: number;
  dinner: number;
}

export interface GuestsData {
  [location: string]: {
    [day: string]: GuestDay;
  };
}

export interface Catering {
  id: string;
  name: string;
  date: string | null;
  guestCount: number;
  deliveryMode: string;
  dishes: CateringDish[];
  toppings?: CateringTopping[];
  logisticsNotes: string;
  createdAt?: string;
}

export interface TransportItem {
  id: string;
  text: string;
}

// RecipeEntry (legacy v1 row shape) and the corresponding `recipeIndex` field
// on DataResponse / AppState were removed in S12 — all recipes are now Recipe
// v2 (RecipeFull) and the legacy `recipe_index` table is dropped.

// ── Recipe system v2 ──

export interface PrepStep {
  step: number;
  text: string;
  note?: string;
}

export interface RecipeVersionSnapshot {
  version: number;
  date: string;
  changedBy: string;
  ingredients: RecipeIngredientFull[];
  notes: string;
}

export interface RecipeIngredientFull {
  id: string;
  ingredientId: string | null;
  sortOrder: number;
  rawAmount: number;
  cookedAmount: number | null;
  unit: string;
  isFlexible: boolean;
  flexCategory: string | null;
  flexLabel: string | null;
  suggestedNames: string[];
  // Denormalized from Ingredient for display
  ingredientName?: string;
  ingredientAllergens?: string;
  costPer100?: number;
}

export interface NutritionInfo {
  energyKcal: number;
  energyKj: number;
  fat: number;
  saturatedFat: number;
  carbs: number;
  sugar: number;
  fiber: number;
  protein: number;
  salt: number;
  completeness: number; // fraction of ingredients with nutrition data (0-1)
}

export type RecipeYieldType = 'volume' | 'count';

export interface RecipeFull {
  id: string;
  name: string;
  type: DishType | string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  recipeVolume: number | null;
  /** Yield mode. 'volume' (default) scales by liters/servingSize; 'count'
   *  scales by outputCount of outputUnit ("makes 10 loaves"). Undefined on
   *  pre-yield-mode rows — treat as 'volume'. */
  yieldType?: RecipeYieldType;
  outputCount?: number | null;
  outputUnit?: string | null;
  autoAllergens: string[];
  extraAllergens: string[];
  costPerServing: number | null;
  avgSkill: number;
  avgSpeed: number;
  avgBanger: number;
  timesServed: number;
  prepSteps: PrepStep[];
  coolingMethod: string;
  storageMethod: string;
  photoUrl: string | null;
  isComplete: boolean;
  versions: RecipeVersionSnapshot[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  legacySheetId: string | null;
  ingredients: RecipeIngredientFull[];
  nutrition?: NutritionInfo;
}

export interface ActualIngredient {
  ingredientId: string;
  name: string;
  amount: number;
  unit: string;
}

// ── Ingredient stock: location → amount (number) ──

export interface LocationStockEntry {
  amount: number;
  date: string;
}

export interface DetailedStock {
  [location: string]: LocationStockEntry;
}

export interface LocationStock {
  [location: string]: number;
}

// ── Ingredient storage locations: location → storage assignment ──

export interface StorageLocationMap {
  // The structured object (a storage category + a specific spot) is the
  // current shape; a bare string is the legacy pre-categorization form,
  // still possible on un-migrated rows.
  [location: string]: string | { category?: string; location?: string };
}

export interface Ingredient {
  id: string;
  name: string;
  supplierName: string;
  types: string[];
  category: string;
  measureMode: string;
  unit: string;
  supplier: string;
  orderCode: string;
  orderUnit: string;
  orderPrice: number | null;
  orderUnitSize: number;
  priceLevel: string;
  pricePer100: number;
  priceAlert: boolean;
  storageLocations: StorageLocationMap;
  stock: DetailedStock;
  targetStock: LocationStock;
  allergens: string;
  notes: string;
  active: boolean;
  nutrition?: Record<string, number>;
  priceHistory?: Array<{ month: string; price: number }>;
}

// ── Supplies (toppings, breads, ferments, pickles, sauces) ──

export type SupplyKind = 'standard' | 'oneoff';
export type SupplyPrepMode = 'centralized' | 'per-location';

export interface SupplyLocationStock {
  amount: number;
  lastMakeDate: string | null; // ISO 'YYYY-MM-DD'
}

export interface SupplyStock {
  [location: string]: SupplyLocationStock;
}

export interface Supply {
  id: string;
  name: string;
  kind: SupplyKind;
  unit: string;
  recipeId: string | null;
  // standard-only fields (null for oneoff)
  /** How many guests one unit serves, e.g. 10 = "1 box per 10 guests".
   *  Units needed for a service = guestCount / guestsPerUnit. */
  guestsPerUnit: number | null;
  prepHorizonDays: number | null;
  prepMode: SupplyPrepMode | null;
  // oneoff-only fields (null for standard)
  oneoffLocation: Location | null;
  unitsPerService: number | null;
  oneoffStartDate: string | null;
  // shared
  stock: SupplyStock;
  /** € per unit (box/loaf/bottle). Manually entered, optionally auto-suggested
   *  from a linked recipe. price-per-guest = costPerUnit / guestsPerUnit. */
  costPerUnit: number | null;
  preservationMethod: string | null;
  archived: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface AppUser {
  email: string;
  name: string;
  picture: string | null;
  /** True when the user's email is in DIRECTOR_EMAILS. Drives visibility of
   *  director-only features like the private AI recipe assistant. Computed
   *  at session-issue / session-restore time and sent down with /auth/me. */
  isDirector?: boolean;
  /** True when the user is a manager (director ∪ MANAGER_EMAILS) — drives the
   *  drinks-module money/supplier/publish affordances. Computed alongside
   *  isDirector at session-issue / restore time. */
  isManager?: boolean;
  /** Per-screen page permissions resolved from the user's role, sent down with
   *  login / GET /auth/me. An empty/absent map = no role = full edit (legacy).
   *  Directors ignore this (always full edit). Frontend-only guardrail. */
  permissions?: Record<string, PagePermission>;
}

/** Per-page access level for the role-based guardrails. */
export type PagePermission = 'hidden' | 'view' | 'edit';

/** Screens whose access a role can gate. 'team' is director-only and is
 *  deliberately excluded (managing roles/access is a director power). Keep in
 *  sync with NAV_SCREENS ids in public/js/state.ts. */
export const GATEABLE_SCREENS = [
  'dashboard', 'guests', 'planner', 'recipe-index', 'orders',
  'competencies', 'supplies', 'finance', 'feedback-admin',
] as const;
export type GateableScreen = typeof GATEABLE_SCREENS[number];

/** A role as returned by GET /api/access/roles. */
export interface RoleDTO {
  id: string;
  name: string;
  permissions: Record<string, PagePermission>;
  isDefault: boolean;
}

/** An account-access request / grant, as returned by GET /api/access/requests.
 *  Mirrors the AccessRequest Prisma model with dates serialised to ISO strings. */
export interface AccessRequestDTO {
  id: string;
  email: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  picture: string | null;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  /** Linked Training (competencies) person id, set on approval. */
  personId: string | null;
  /** Assigned role id (null = no role = full edit). */
  roleId: string | null;
}

// ── Ratings (for served dialog) ──

export interface BatchRatings {
  skill: number;
  speed: number;
  banger: number;
}

// ── Event locations (temporary festival/catering sites) ──
// Registry row for a temporary location. The slug is the location KEY —
// referenced as a plain string from batch inventory/shipments/services,
// guest rows, supply stock, standard inventory, prep checklists — so it is
// IMMUTABLE and never reused, even after archive (renames change `name`
// only). Archived rows stay in the registry so historical data keeps
// validating and rendering; they're just hidden from pickers/tabs.
export interface EventLocationDTO {
  slug: string;                     // "ev-<slugified-name>"
  name: string;
  startDate: string;                // ISO YYYY-MM-DD
  endDate: string;                  // ISO YYYY-MM-DD
  hanosAccount: PermanentLocation;  // whose Hanos credentials on-site orders use
  archived: boolean;
  createdAt: string;                // ISO timestamp
  archivedAt: string | null;
}

// ── API shapes ──

export interface DataResponse {
  batches: Batch[];
  guests: GuestsData;
  recipes: RecipeFull[];
  caterings: Catering[];
  transportItems: TransportItem[];
  supplies: Supply[];
  eventLocations: EventLocationDTO[];
}

export interface PatchRequest {
  batches?: Batch[];
  deletedBatches?: string[];
  guests?: GuestsData | null;
  caterings?: Catering[];
  deletedCaterings?: string[];
  transportItems?: TransportItem[];
  deletedTransportItems?: string[];
}

// ── Snapshot (for patch diffing) ──

export interface SaveSnapshot {
  batches: Map<string, string>;
  guests: string;
  caterings: Map<string, string>;
  transportItems: Map<string, string>;
}

// ── Telemetry & AI Insights ──

export type TelemetrySource = 'frontend' | 'backend';
export type TelemetryType = 'error' | 'screen_view' | 'feature_use' | 'api_call';
export type InsightCategory = 'bug' | 'ux' | 'data_quality' | 'performance' | 'suggestion';
export type InsightSeverity = 'critical' | 'warning' | 'info';
export type InsightStatus = 'new' | 'reviewed' | 'resolved' | 'dismissed';

export interface TelemetryPayload {
  source: TelemetrySource;
  type: TelemetryType;
  name: string;
  data?: Record<string, unknown>;
  userId?: string;
  sessionId?: string;
  timestamp?: string;
}

export interface AiInsightRecord {
  id: number;
  timestamp: string;
  category: InsightCategory;
  severity: InsightSeverity;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  status: InsightStatus;
  resolvedAt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRINKS MODULE — see DRINKS_DOMAIN.md for the domain spec.
// Interface names intentionally mirror the Prisma model names (like Batch /
// Supply / Ingredient do); backend code uses the lowercase prisma.<model>
// client accessors and never imports the Prisma model *types* by name, so there
// is no collision.
// ─────────────────────────────────────────────────────────────────────────────

export type DrinkMode = 'catalogue' | 'recipe';
export type DrinkStatus = 'draft' | 'published';
export type DrinkRefKind = 'ingredient' | 'drink';
export type DrinkOrderStatus = 'draft' | 'ordered' | 'received' | 'cancelled';
export type DrinkProductionStatus = 'fresh' | 'expired' | 'discarded';
export type WriteOffReason = 'breakage' | 'spillage' | 'expired' | 'staff-drink' | 'comp' | 'other';

/** Bumped on a breaking Drink shape change (mirrors BATCH_SCHEMA_VERSION). */
export const DRINK_SCHEMA_VERSION = 1;

/** A sellable serving format, e.g. tap glass 250ml or bottle 750ml. `price`
 *  is per-location and incl-BTW; null = price not set yet. */
export interface DrinkServingFormat {
  name: string;
  volumeMl: number;
  glass?: string;
  price: Record<string, number | null>;
}

/** Per-location catalogue data for a drink. Pool stock is NOT here — it lives
 *  per storage area in DrinkStock and is summed (see stockByLocation). */
export interface DrinkLocationInfo {
  par: number | null;
  active: boolean;
  /** Home storage area at this location (e.g. "Keg Storage") — drives the
   *  by-area stocktake grouping. Optional; unset = "Unassigned". */
  area?: string;
}

/** Info fields, mostly for wine. All optional. */
export interface DrinkInfo {
  producer?: string;
  region?: string;
  country?: string;
  vintage?: string;
  soil?: string;
  grapes?: string;
  natural?: boolean;
  bio?: boolean;
  profile?: string;
  notes?: string;
  extra?: string;
}

/** Batch/premix definition for recipe-mode drinks. */
export interface DrinkBatchDef {
  volumeMl: number;
  bottleSizeMl: number | null;
  note?: string;
}

/** Prep time inputs that drive labour cost amortisation. */
export interface DrinkPrepTime {
  prebatchMin: number;
  prebatchYieldServings?: number | null;
  perServeMin: number;
}

/** One ingredient row of a recipe-mode drink — references either a shared
 *  Ingredient (kind 'ingredient') or another Drink building block (kind
 *  'drink'). `refName`/`refCostPerUnit` are denormalized for display + costing. */
export interface DrinkIngredientRow {
  id: string;
  drinkId: string;
  sortOrder: number;
  refKind: DrinkRefKind;
  ingredientId: string | null;
  refDrinkId: string | null;
  amount: number | null;
  unit: string;
  note: string;
  refName?: string;
  refCostPerUnit?: number | null; // € per ml/g/piece (computed)
}

export interface Drink {
  id: string;
  name: string;
  mode: DrinkMode;
  category: string;
  subtype: string;
  abv: number;
  btwRate: number | null;
  status: DrinkStatus;
  archived: boolean;
  sellable: boolean;
  supplier: string;
  orderUnit: string;
  orderUnitMl: number | null;
  packNote: string;
  itemId: string | null;
  deposit: number;
  costPrice: number | null;
  costNote: string;
  formats: DrinkServingFormat[];
  locations: Record<string, DrinkLocationInfo>;
  info: DrinkInfo;
  tebiProductNames: string[];
  serveVolumeMl: number | null;
  glass: string;
  glassVolumeMl: number | null;
  servingTemp: string;
  characteristics: string[];
  garnish: string[];
  seasonality: string;
  serviceInstructions: string;
  prepSteps: string[];
  batch: DrinkBatchDef;
  prepTime: DrinkPrepTime;
  shelfLifeDays: number | null;
  costPerServe: number | null;
  suggestedPrice: number | null;
  photoUrl: string | null;
  createdAt: string;
  updatedAt: string;
  ingredientRows: DrinkIngredientRow[];
  /** Computed pool stock per location (sum of DrinkStock area rows). */
  stockByLocation?: Record<string, number>;
}

export interface DrinkSupplierContact {
  name?: string;
  email?: string;
  phone?: string;
  url?: string;
  [k: string]: string | undefined;
}

export interface DrinkSupplier {
  id: string;
  name: string;
  products: string;
  orderDays: string[];
  orderDaysNote: string;
  orderCutoff: string;
  deliveryWindow: string;
  contact: DrinkSupplierContact;
  minimumOrder: string;
  notes: string;
  priceListRef: string;
}

/** One per-area stock count for a drink at a location. Pool = Σ qty over areas. */
export interface DrinkStockEntry {
  id: string;
  drinkId: string;
  location: string;
  area: string;
  qty: number;
  countedBy: string;
  countedAt: string | null;
}

export interface DrinkOrderLine {
  id: string;
  orderId: string;
  drinkId: string | null;
  ingredientId: string | null;
  name: string;
  orderedQty: number;
  orderUnit: string;
  receivedQty: number | null;
  substitutedBy: string | null;
  deposit: number;
  sortOrder: number;
}

export interface DrinkOrder {
  id: string;
  location: string;
  supplier: string;
  status: DrinkOrderStatus;
  orderedBy: string | null;
  orderedAt: string | null;
  expectedDelivery: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
  note: string;
  createdAt: string;
  updatedAt: string;
  lines: DrinkOrderLine[];
}

export interface DrinkProductionLog {
  id: string;
  drinkId: string;
  location: string;
  batchesMade: number;
  volumeMl: number;
  bottlesYielded: number;
  madeBy: string;
  madeOn: string;
  expiresOn: string | null;
  status: DrinkProductionStatus;
  note: string;
  createdAt: string;
}

export interface DrinkWriteOff {
  id: string;
  refKind: DrinkRefKind;
  drinkId: string | null;
  ingredientId: string | null;
  name: string;
  location: string;
  qty: number;
  unit: string;
  reason: WriteOffReason;
  note: string;
  who: string;
  createdAt: string;
}

/** An assortment entry references a drink and optionally which serving formats
 *  are offered (empty/absent = all of the drink's formats). */
export interface AssortmentEntry {
  drinkId: string;
  formats?: string[];
}

export interface Assortment {
  id: string;
  name: string;
  location: string;
  serviceContext: string; // '' | 'testtafel'
  description: string;
  entries: AssortmentEntry[];
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DrinkMenuSection {
  title: string;
  drinkIds: string[];
}

export interface DrinkMenuLayout {
  columns: 1 | 2;
  sectionStyle: string;
  typeScale: string;
  /** Page size for print: 'A4' (default) or 'A5'. */
  pageSize?: string;
  /** Visual template: 'classic' (serif, default) or 'mono' (Inconsolata bar style). */
  template?: string;
  /** Optional footer line (e.g. social handles) printed at the bottom. */
  footer?: string;
}

export interface DrinkMenu {
  id: string;
  name: string;
  assortmentId: string;
  location: string;
  sections: DrinkMenuSection[];
  layout: DrinkMenuLayout;
  published: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DrinkBtwRule {
  alcoholicAbvThreshold: number;
  alcoholic: number;
  nonAlcoholic: number;
}

/** Per-category markup targets. `defaultMultiple` is the fallback where a
 *  category target is null (cost unknown at seed time). */
export interface DrinkMarkupTargets {
  defaultMultiple: number;
  [category: string]: number | null;
}

/** Drinks module config singleton (parsed from DrinkConfig.config JSON). */
export interface DrinkConfig {
  labourRatePerMin: number;
  priceRounding: number;
  btwRule: DrinkBtwRule;
  markupTargets: DrinkMarkupTargets;
  demandNudgeThresholdPct: number;
  defaultShelfLifeDays: number;
  /** Editable drink storage areas per location (Stocktake "Edit areas").
   *  Falls back to DEFAULT_DRINK_STORAGE_AREAS when unset/empty. */
  storageAreas: Record<string, string[]>;
}

/** Built-in drink storage areas — the defaults a fresh config starts from.
 *  Shared by the backend config merge and the frontend fallback. */
export const DEFAULT_DRINK_STORAGE_AREAS: Record<string, string[]> = {
  west: ['Keg Storage', 'Drinks Storage', 'Tea & Liquor Shelf', 'Shelf Under Bar', 'Walk-In FoH', 'Freezer', 'Kitchen Back Storage', 'Wine Lowboy'],
  centraal: ['Bar fridge', 'Cellar', 'Dry storage', 'Wine storage'],
};
