// ─────────────────────────────────────────────────────────────────────────────
// SHARED TYPES — used by both backend and frontend
// ─────────────────────────────────────────────────────────────────────────────

// ── String literal unions ──

export type Location = 'west' | 'centraal';
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

// ── API shapes ──

export interface DataResponse {
  batches: Batch[];
  guests: GuestsData;
  recipes: RecipeFull[];
  caterings: Catering[];
  transportItems: TransportItem[];
  supplies: Supply[];
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
