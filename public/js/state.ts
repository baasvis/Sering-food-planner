// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
import type { Batch, Catering, TransportItem, RecipeFull, Ingredient, GuestsData, GuestDay, AppUser, Location, Meal, DishType, StorageType, StorageArea, StorageConfig, BatchRatings, KitchenEquipment, CookRhythmConfig, CookRhythmDay, ClosedServicesConfig, CostTargets, Supply, PagePermission, Drink, DrinkSupplier, DrinkConfig, DrinkOrder, Assortment, DrinkMenu, EventLocationDTO } from '@shared/types';
import { setLocationRegistry } from '@shared/location';

export const DAYS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'] as const;
export const MEALS: Meal[] = ['lunch','dinner'];
export const STORAGE: StorageType[] = ['Gastro','Frozen','Vac-packed'];
export const LOCATIONS: Location[] = ['west','centraal'];
// Not all of these are legal allergens — the list also carries house dietary
// flags staff asked to track (Onion, Garlic, Paprika, Alcohol — feedback #445).
export const ALLERGENS = ['Gluten','Soy','Nuts','Peanuts','Sesame','Celery','Mustard','Sulphites','Lupin','Onion','Garlic','Paprika','Alcohol'] as const;

// Ingredient database constants
export const INGREDIENT_TYPES = ['Food','Drinks','Kitchen Equipment','Cleaning','FOH Supplies','FOH Equipment','Office'] as const;

export const INGREDIENT_CATEGORIES: Record<string, string[]> = {
  'Food':['Vegetables & Fruit','Grains & Starches','Legumes & Proteins','Dairy & Alternatives','Oils & Fats','Herbs & Spices','Sauces & Condiments','Canned & Preserved','Baking & Dessert','Snacks','Seaweed & Specialty'],
  'Drinks':['Coffee & Tea','Juices & Soft Drinks','Beer','Wine','Spirits & Liqueurs','Drink Ingredients'],
  'Non-food':['Cleaning & Hygiene','Disposables & Packaging','Tableware & FOH','Kitchen Equipment','Office & Admin','Clothing & Textiles'],
};

export const INGREDIENT_TYPE_TO_GROUP: Record<string, string> = {
  'Food':'Food','Drinks':'Drinks','Kitchen Equipment':'Non-food','Cleaning':'Non-food','FOH Supplies':'Non-food','FOH Equipment':'Non-food','Office':'Non-food',
};

export const ALL_CATEGORIES: string[] = [...INGREDIENT_CATEGORIES['Food'],...INGREDIENT_CATEGORIES['Drinks'],...INGREDIENT_CATEGORIES['Non-food']];
export const PRICE_LEVELS = ['cheap','medium','expensive'] as const;

// Default storage config — will be replaced by backend config when loaded
export const DEFAULT_STORAGE_CONFIG: StorageArea[] = [
  { name: 'Walk-in', color: '#4CAF50', spots: ['Shelf 1', 'Shelf 2', 'Shelf 3'] },
  { name: 'Dry storage', color: '#FF9800', spots: ['Shelf 1', 'Shelf 2', 'The cart'] },
  { name: 'Freezer', color: '#2196F3', spots: ['Shelf 1', 'Shelf 2', 'Drawer 1'] },
  { name: 'Bar', color: '#9C27B0', spots: ['Counter', 'Under bar'] },
  { name: 'FOH', color: '#F44336', spots: ['Station 1'] },
];

// Default cook rhythm — the Fix My Menu "rules" baseline, editable in-app and
// persisted server-side (S.cookRhythm). Lives here (not menu-fixer.ts) so both
// menu-fixer and the loader/editor can read it without a circular import.
// chefs are relative capacity weights: a day's tolerated cook volume = its chefs
// ÷ the week's total chefs × the week's guest demand (see computeWeeklyCapacities).
// The defaults keep Sunday as the big-cook day and Mon/Tue lighter.
export const DEFAULT_COOK_RHYTHM: Record<string, CookRhythmDay> = {
  Sun: { soup: 3, main: 3, chefs: 6 }, // big cook day — many volunteers
  Mon: { soup: 0, main: 1, chefs: 1 }, // light day, lives off Sunday
  Tue: { soup: 1, main: 1, chefs: 2 },
  Wed: { soup: 1, main: 1, chefs: 2 },
  Thu: { soup: 1, main: 1, chefs: 2 },
  Fri: { soup: 1, main: 1, chefs: 2 },
  Sat: { soup: 1, main: 1, chefs: 2 },
};

// Default closed-services schedule — empty means nothing is closed (behaviour
// unchanged until the operator marks a service closed on the Guests screen).
// Persisted server-side as S.closedServices; null also means "all open".
export const DEFAULT_CLOSED_SERVICES: ClosedServicesConfig = { recurring: {} };

// Default cost-per-guest targets (Daan, 2026-06-05): €1.80 total split
// €0.80 main + €0.50 soup + €0.50 toppings; food cost 25% of revenue.
// Persisted server-side as S.costTargets; null means "use these defaults".
// revenuePerGuestOverride null = food-cost-% uses the rolling Tebi auto value.
export const DEFAULT_COST_TARGETS: CostTargets = {
  soup: 0.50, main: 0.80, topping: 0.50, foodCostPct: 25, revenuePerGuestOverride: null, reservePercent: 0,
};

// Mutable — rebuilt from storageConfig when loaded
export let STORAGE_CATEGORIES: Record<string, string[]> = {};
export function rebuildStorageCategories(loc: Location | string): void {
  const arr = getStorageConfigForLoc(loc);
  const obj: Record<string, string[]> = {};
  arr.forEach((a: StorageArea) => { obj[a.name] = a.spots || []; });
  STORAGE_CATEGORIES = obj;
}
export function getStorageConfigForLoc(loc: Location | string): StorageArea[] {
  loc = loc || 'west';
  const cfg = S.storageConfig || {};
  return cfg[loc] || cfg.west || DEFAULT_STORAGE_CONFIG;
}
export function getStorageColor(categoryName: string, loc: Location | string): string {
  const arr = getStorageConfigForLoc(loc);
  const entry = arr.find((a: StorageArea) => a.name === categoryName);
  return entry ? entry.color : '#999';
}

export const ACCOMPANIMENTS = [
  { name:'Rice', gramsPerGuest:80 },
  { name:'Pasta', gramsPerGuest:80 },
] as const;

// Single source of truth for navigation screens
export interface NavScreen {
  id: string;
  topLabel: string;
  bottomLabel: string;
  icon: string;
  /** When true, the screen is only shown to directors (S.user.isDirector).
   *  buildNav() filters these out for everyone else. */
  directorOnly?: boolean;
}

export const NAV_SCREENS: NavScreen[] = [
  { id: 'dashboard', topLabel: 'Dashboard', bottomLabel: 'Home',
    icon: '<path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>' },
  { id: 'guests', topLabel: 'Guests', bottomLabel: 'Guests',
    icon: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>' },
  { id: 'planner', topLabel: 'Week plan', bottomLabel: 'Plan',
    icon: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>' },
  { id: 'recipe-index', topLabel: 'Recipes', bottomLabel: 'Recipes',
    icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>' },
  { id: 'orders', topLabel: 'Orders', bottomLabel: 'Orders',
    icon: '<path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/>' },
  { id: 'drinks', topLabel: 'Drinks', bottomLabel: 'Drinks',
    icon: '<path d="M5 4h14l-7 8z"/><line x1="12" y1="12" x2="12" y2="20"/><line x1="8" y1="20" x2="16" y2="20"/>' },
  { id: 'competencies', topLabel: 'Training', bottomLabel: 'Training',
    icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>' },
  { id: 'supplies', topLabel: 'Toppings & bread', bottomLabel: 'Toppings',
    icon: '<path d="M5 8h14l-1.4 11.2A2 2 0 0 1 15.6 21H8.4a2 2 0 0 1-2-1.8L5 8z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>' },
  { id: 'finance', topLabel: 'Finance', bottomLabel: 'Finance',
    icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>' },
  { id: 'feedback-admin', topLabel: 'Feedback', bottomLabel: 'Feedback',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
  { id: 'team', topLabel: 'Team', bottomLabel: 'Team', directorOnly: true,
    icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>' },
];

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════

export interface InventoryDone {
  lunch: string | null;
  dinner: string | null;
}

/** Server-persisted ISO timestamps of the most recent "Finish inventory" press
 *  per location + meal window. Powers the dashboard freshness counter so any
 *  device sees the same "last inventory was X ago" value. Distinct from
 *  `inventoryDone` which is a per-device button-state hint keyed by date. */
export interface InventoryCompletions {
  lunch: string | null;
  dinner: string | null;
}

export interface CustomTodo {
  id: string;
  text: string;
  done: boolean;
}

export interface AppState {
  currentLoc: Location;
  dashMeal: Meal;
  plannerSubTab: string;
  filters: { loc: string; storage: string };
  selected: Set<string>;
  orderToggles: { batches: boolean; standard: boolean };
  caterings: Catering[];
  transportItems: TransportItem[];
  collapsedTypes: Record<string, boolean>;
  inventoryDone: Record<Location, InventoryDone>;
  inventoryCompletions: Record<Location, InventoryCompletions>;
  guests: GuestsData;
  batches: Batch[];
  expandedBatches: Set<string>;
  expandedBreakdowns: Set<string>;
  draggingBatchId: string | null;
  showAllBatches: boolean;
  recipes: RecipeFull[];
  supplies: Supply[];
  ingredientDb: Ingredient[];
  /** True once the *full* ingredient payload has been fetched. The default
   *  /api/ingredients endpoint returns a slim shape (no priceHistory /
   *  nutrition / pricePer100g) for fast page load. /api/ingredients/full
   *  fetches the rich shape and replaces S.ingredientDb. The ingredient DB
   *  editor needs the rich shape; everywhere else only needs the slim. */
  ingredientDbFullyLoaded: boolean;
  planner: Record<string, Batch[]>;
  user: AppUser | null;
  dashVegMode: string;
  dashVegModeTomorrow: string;
  prepChecklist: Record<string, Set<string>>;
  /** Per-location set of completed daily-ritual step keys for *today*, backing
   *  the dashboard "Today" guidance panel. Keyed by location ("west" /
   *  "centraal"); the value is the set of done step keys (e.g. "fmm-lunch",
   *  "service-dinner"). Only steps with no observable domain signal live here;
   *  everything else is derived from real state. Loaded for both locations at
   *  boot so a mark never overwrites the other location's row. */
  ritualCompletions: Record<string, Set<string>>;
  heatChecked: Set<string>;
  customTodos: CustomTodo[];
  teamTodosOpen: boolean;
  guestHistory: Record<string, unknown> | null;
  predictions: Record<string, unknown> | null;
  guestFlowDistribution: Record<string, unknown> | null;
  guestsNextWeeks: Record<string, Record<string, Record<string, Record<string, number>>>>;
  storageConfig: StorageConfig | null;
  kitchenEquipment: KitchenEquipment | null;
  cookRhythm: CookRhythmConfig | null;
  costTargets: CostTargets | null;
  revenuePerGuest: number | null; // rolling Tebi FOOD €/guest (West+Centraal lunch+dinner) for food-cost-%
  closedServices: ClosedServicesConfig | null;
  financeData: Record<string, unknown>[];
  financeProducts: Record<string, unknown>[];
  financeSyncing: boolean;
  financeWeekOffset: number;
  financeProductMeal: string;
  financeProductLoc: string;
  financeLiveVenue: string;        // live dashboard: selected venue
  financeLive: unknown;            // live dashboard: /api/finance/live payload (or null)
  // ── Drinks module ──
  drinks: Drink[];
  drinkSuppliers: DrinkSupplier[];
  drinkConfig: DrinkConfig | null;
  drinkOrders: DrinkOrder[];
  assortments: Assortment[];
  drinkMenus: DrinkMenu[];
  drinksSubTab: string;
  drinksFilters: { mode: string; category: string; location: string };
  drinksSearch: string;
  /** Event-location registry (temporary festival/catering sites), hydrated
   *  from GET /api/data and replaced wholesale by SSE `eventLocations`
   *  patches. Includes archived rows — use activeEventLocations() for
   *  picker/tab surfaces. */
  eventLocations: EventLocationDTO[];
  archive?: Array<Record<string, unknown>>;
  openBatchPools?: Set<string>;
  _addModalState?: { loc: string; date: string; meal: string; existing: string[]; typeFilter: string; tab: string; locFilter: string } | null;
  _replaceState?: { oldBatchId: string; searchQuery: string; tab: string } | null;
  _inventoryLoc?: string | null;
}

export let S: AppState = {
  currentLoc:'west',
  dashMeal:'lunch',
  plannerSubTab:'west',
  filters:{loc:'all',storage:'all'},
  selected:new Set(),
  orderToggles:{batches:true,standard:false},
  caterings:[],
  transportItems:[],
  collapsedTypes:{},
  inventoryDone:{west:{lunch:null,dinner:null},centraal:{lunch:null,dinner:null}},
  inventoryCompletions:{west:{lunch:null,dinner:null},centraal:{lunch:null,dinner:null}},
  guests:{
    west:{Mon:{lunch:100,dinner:110},Tue:{lunch:100,dinner:110},Wed:{lunch:100,dinner:110},Thu:{lunch:100,dinner:110},Fri:{lunch:80,dinner:90},Sat:{lunch:0,dinner:0},Sun:{lunch:0,dinner:0}},
    centraal:{Mon:{lunch:80,dinner:85},Tue:{lunch:80,dinner:85},Wed:{lunch:80,dinner:85},Thu:{lunch:80,dinner:85},Fri:{lunch:60,dinner:70},Sat:{lunch:0,dinner:0},Sun:{lunch:0,dinner:0}}
  },
  batches:[],
  expandedBatches: new Set(),
  expandedBreakdowns: new Set(),
  draggingBatchId: null,
  showAllBatches: false,
  recipes:[],
  supplies:[],
  ingredientDb:[],
  ingredientDbFullyLoaded: false,
  planner:{},
  user:null,
  dashVegMode:'combined',
  dashVegModeTomorrow:'combined',
  prepChecklist: {},
  ritualCompletions: {},
  heatChecked: new Set(),
  customTodos: [],
  teamTodosOpen: false,
  guestHistory:null,
  predictions:null,
  guestFlowDistribution:null,
  guestsNextWeeks:{},
  storageConfig: null,
  kitchenEquipment: null,
  cookRhythm: null,
  costTargets: null,
  revenuePerGuest: null,
  closedServices: null,
  financeData: [],
  financeProducts: [],
  financeSyncing: false,
  financeWeekOffset: 0,
  financeProductMeal: 'all',
  financeProductLoc: 'all',
  financeLiveVenue: 'west',
  financeLive: null,
  drinks: [],
  drinkSuppliers: [],
  drinkConfig: null,
  drinkOrders: [],
  assortments: [],
  drinkMenus: [],
  drinksSubTab: 'catalogue',
  drinksFilters: { mode: 'all', category: 'all', location: 'west' },
  drinksSearch: '',
  eventLocations: [],
};

// ── Event-location registry helpers ──────────────────────────────
// LOCATIONS above stays the PERMANENT pair (west/centraal) — sites that mean
// "every location a user can currently work at" should use allActiveLocations().

/** THE way to replace the event-location registry on the client: keeps
 *  S.eventLocations and the shared display-name registry (locName /
 *  shortLocName in shared/location.ts) in lockstep. Setting S.eventLocations
 *  directly leaves locName resolving raw slugs. */
export function setEventLocationsState(rows: EventLocationDTO[]): void {
  S.eventLocations = rows;
  setLocationRegistry(rows);
}

/** Non-archived event locations, in registry order. */
export function activeEventLocations(): EventLocationDTO[] {
  return S.eventLocations.filter((e: EventLocationDTO) => !e.archived);
}

/** Every location a user can currently select/work at:
 *  ['west', 'centraal', ...active event slugs]. */
export function allActiveLocations(): string[] {
  return [...LOCATIONS, ...activeEventLocations().map((e: EventLocationDTO) => e.slug)];
}

/** True when `loc` is an event-location slug — active OR archived. (Guards
 *  like Fix My Menu's must spare archived-event data too.) */
export function isEventLoc(loc: string): boolean {
  return S.eventLocations.some((e: EventLocationDTO) => e.slug === loc);
}

export function eventLocById(loc: string): EventLocationDTO | undefined {
  return S.eventLocations.find((e: EventLocationDTO) => e.slug === loc);
}

// ── Global location helpers ──────────────────────────────────────
const LOC_STORAGE_KEY = 'sering-location';

export function setGlobalLocation(loc: Location): void {
  S.currentLoc = loc;
  localStorage.setItem(LOC_STORAGE_KEY, loc);
}

/** Restore location from localStorage. Returns true if a saved value was found.
 *  Permanent keys are accepted immediately. An event-location slug ("ev-…")
 *  is TENTATIVELY accepted — this runs before loadData, so the registry isn't
 *  known yet; initApp re-validates after data load and falls back to west when
 *  the saved slug turns out archived/unknown. Anything else is rejected. */
export function restoreGlobalLocation(): boolean {
  const saved = localStorage.getItem(LOC_STORAGE_KEY);
  if (saved === 'west' || saved === 'centraal') {
    S.currentLoc = saved;
    return true;
  }
  if (saved && saved.startsWith('ev-')) {
    S.currentLoc = saved;
    return true;
  }
  return false;
}

// ── Page permissions (role-based guardrails) ────────────────────────────────
// Resolve the current user's access level for a screen. Directors always get
// 'edit'. A user with no role (empty/absent permissions map) gets 'edit' too —
// this preserves full access for env-listed and pre-role accounts. Within a
// role, a screen missing from the map is treated as 'hidden' (deny by default).
// The dashboard is never hidden, so a user always has a landing screen.
export function screenPermission(screenId: string): PagePermission {
  if (S.user?.isDirector) return 'edit';
  const perms = S.user?.permissions;
  if (!perms || Object.keys(perms).length === 0) return 'edit';
  const level = (perms[screenId] as PagePermission) || 'hidden';
  if (screenId === 'dashboard' && level === 'hidden') return 'view';
  return level;
}

/** True when the current user may edit (not just view) the given screen. */
export function canEditScreen(screenId: string): boolean {
  return screenPermission(screenId) === 'edit';
}

// ═══════════════════════════════════════════════════════════════════
