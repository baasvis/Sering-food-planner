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
  unit: string;
  source?: string;
  cost?: number;
}

// ── Catering dish reference ──

export interface CateringDish {
  dishId: string;
  name: string;
  type: DishType | string;
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

export interface Batch {
  id: string;
  name: string;
  type: DishType;
  stock: number;
  serving: number;
  storage: StorageType;
  location: Location;
  inTransit: boolean;
  allergens: string[];
  extraAllergens: string[];
  orderFor: boolean;
  cookDate: string | null;
  recipeSheetId: string | null;
  recipeVolume: number | null;
  recipeIngredients: RecipeIngredient[] | null;
  parentId: string | null;
  note: string;
  services: Service[];
  createdAt: string;
  // Recipe v2 fields
  recipeId: string | null;
  actualIngredients: ActualIngredient[] | null;
  cookNotes: string;
  stockDeducted: boolean;
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
  logisticsNotes: string;
  createdAt?: string;
}

export interface TransportItem {
  id: string;
  text: string;
}

export interface RecipeEntry {
  id: string;
  name: string;
  type: string;
  recipeSheetId: string | null;
  allergens: string[];
  costPerServing: string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  recipeVolume: number | null;
  recipeIngredients: RecipeIngredient[] | null;
  createdAt: string;
  avgSkill: number;
  avgSpeed: number;
  avgBanger: number;
  timesServed: number;
}

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

export interface RecipeFull {
  id: string;
  name: string;
  type: DishType | string;
  structure: string;
  seasonality: string;
  servingTemp: string;
  servingSize: number;
  recipeVolume: number | null;
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

// ── Ingredient storage locations: location → area name ──

export interface StorageLocationMap {
  [location: string]: string;
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
  pricePer100g?: number;
  orderAmountGrams?: number;
  orderUnitStandard?: string;
}

export interface AppUser {
  email: string;
  name: string;
  picture: string | null;
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
  recipeIndex: RecipeEntry[];
  recipes: RecipeFull[];
  caterings: Catering[];
  transportItems: TransportItem[];
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
