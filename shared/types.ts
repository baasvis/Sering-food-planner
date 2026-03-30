// ─────────────────────────────────────────────────────────────────────────────
// SHARED TYPES — used by both backend and frontend
// ─────────────────────────────────────────────────────────────────────────────

export interface Service {
  loc: 'west' | 'centraal';
  date: string;        // "YYYY-MM-DD"
  meal: 'lunch' | 'dinner';
}

export interface Batch {
  id: string;
  name: string;
  type: 'Soup' | 'Main course' | 'Dessert';
  stock: number;
  serving: number;
  storage: 'Gastro' | 'Frozen' | 'Vac-packed';
  location: 'west' | 'centraal';
  inTransit: boolean;
  allergens: string[];
  extraAllergens: string[];
  orderFor: boolean;
  cookDate: string | null;
  recipeSheetId: string | null;
  recipeVolume: number | null;
  recipeIngredients: unknown;
  parentId: string | null;
  note: string;
  services: Service[];
  createdAt: string;
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
  dishes: unknown[];
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
  recipeIngredients: unknown;
  createdAt: string;
  avgSkill: number;
  avgSpeed: number;
  avgBanger: number;
  timesServed: number;
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
  storageLocations: Record<string, unknown>;
  stock: Record<string, unknown>;
  targetStock: Record<string, unknown>;
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

// API shapes

export interface DataResponse {
  batches: Batch[];
  guests: GuestsData;
  recipeIndex: RecipeEntry[];
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
