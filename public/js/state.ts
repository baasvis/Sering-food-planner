// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
export const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
export const MEALS=['lunch','dinner'];
export const STORAGE=['Gastro','Frozen','Vac-packed'];
export const LOCATIONS=['west','centraal'];
export const ALLERGENS=['Gluten','Soy','Nuts','Peanuts','Sesame','Celery','Mustard','Sulphites','Lupin','Onion','Garlic','Paprika'];

// Ingredient database constants
export const INGREDIENT_TYPES=['Food','Drinks','Kitchen Equipment','Cleaning','FOH Supplies','FOH Equipment','Office'];
export const INGREDIENT_CATEGORIES: any={
  'Food':['Vegetables & Fruit','Grains & Starches','Legumes & Proteins','Dairy & Alternatives','Oils & Fats','Herbs & Spices','Sauces & Condiments','Canned & Preserved','Baking & Dessert','Snacks','Seaweed & Specialty'],
  'Drinks':['Coffee & Tea','Juices & Soft Drinks','Beer','Wine','Spirits & Liqueurs','Drink Ingredients'],
  'Non-food':['Cleaning & Hygiene','Disposables & Packaging','Tableware & FOH','Kitchen Equipment','Office & Admin','Clothing & Textiles'],
};
export const INGREDIENT_TYPE_TO_GROUP: any={'Food':'Food','Drinks':'Drinks','Kitchen Equipment':'Non-food','Cleaning':'Non-food','FOH Supplies':'Non-food','FOH Equipment':'Non-food','Office':'Non-food'};
export const ALL_CATEGORIES=[...INGREDIENT_CATEGORIES['Food'],...INGREDIENT_CATEGORIES['Drinks'],...INGREDIENT_CATEGORIES['Non-food']];
export const PRICE_LEVELS=['cheap','medium','expensive'];
// Default storage config — will be replaced by backend config when loaded
export const DEFAULT_STORAGE_CONFIG = [
  { name: 'Walk-in', color: '#4CAF50', spots: ['Shelf 1', 'Shelf 2', 'Shelf 3'] },
  { name: 'Dry storage', color: '#FF9800', spots: ['Shelf 1', 'Shelf 2', 'The cart'] },
  { name: 'Freezer', color: '#2196F3', spots: ['Shelf 1', 'Shelf 2', 'Drawer 1'] },
  { name: 'Bar', color: '#9C27B0', spots: ['Counter', 'Under bar'] },
  { name: 'FOH', color: '#F44336', spots: ['Station 1'] },
];

// Mutable — rebuilt from storageConfig when loaded
export let STORAGE_CATEGORIES: any = {};
export function rebuildStorageCategories(loc: any) {
  const arr = getStorageConfigForLoc(loc);
  const obj: any = {};
  arr.forEach((a: any) => { obj[a.name] = a.spots || []; });
  STORAGE_CATEGORIES = obj;
}
export function getStorageConfigForLoc(loc: any) {
  loc = loc || 'west';
  const cfg = S.storageConfig || {};
  return cfg[loc] || cfg.west || DEFAULT_STORAGE_CONFIG;
}
export function getStorageColor(categoryName: any, loc: any) {
  const arr = getStorageConfigForLoc(loc);
  const entry = arr.find((a: any) => a.name === categoryName);
  return entry ? entry.color : '#999';
}

export const ACCOMPANIMENTS=[
  { name:'Rice', gramsPerGuest:80 },
  { name:'Pasta', gramsPerGuest:80 },
];

// Single source of truth for navigation screens
export const NAV_SCREENS = [
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
  { id: 'finance', topLabel: 'Finance', bottomLabel: 'Finance',
    icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>' },
  { id: 'feedback-admin', topLabel: 'Feedback', bottomLabel: 'Feedback',
    icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' },
];

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
export let S: any = {
  currentLoc:'west',
  plannerSubTab:'west',
  filters:{loc:'all',storage:'all',inTransit:'all'},
  selected:new Set(),
  orderToggles:{batches:true,standard:false},
  caterings:[],
  transportItems:[],
  collapsedTypes:{},
  inventoryDone:{west:{lunch:null,dinner:null},centraal:{lunch:null,dinner:null}},
  guests:{
    west:{Mon:{lunch:100,dinner:110},Tue:{lunch:100,dinner:110},Wed:{lunch:100,dinner:110},Thu:{lunch:100,dinner:110},Fri:{lunch:80,dinner:90},Sat:{lunch:0,dinner:0},Sun:{lunch:0,dinner:0}},
    centraal:{Mon:{lunch:80,dinner:85},Tue:{lunch:80,dinner:85},Wed:{lunch:80,dinner:85},Thu:{lunch:80,dinner:85},Fri:{lunch:60,dinner:70},Sat:{lunch:0,dinner:0},Sun:{lunch:0,dinner:0}}
  },
  batches:[],
  expandedBatches: new Set(),
  assigningBatchId: null,
  draggingBatchId: null,
  showAllBatches: false,
  recipeIndex:[],
  ingredientDb:[],
  planner:{} as any,
  user:null as any,
  dashboardLoc:'west',
  dashVegMode:'combined',
  dashVegModeTomorrow:'combined',
  prepChecklist: {} as any, // keyed by loc, value is Set of checked ingredient keys
  heatChecked: new Set(),   // dish IDs ticked off in Heat Up
  cookChecked: new Set(),   // dish IDs ticked off in Cook
  customTodos: [] as any[],          // [{id, text, done}] freeform team todos
  teamTodosOpen: false,     // floating panel expanded state
  guestHistory:null as any,
  predictions:null as any,
  guestFlowDistribution:null as any,
  guestsNextWeeks:{} as any,
  storageConfig: null as any, // loaded from /api/storage-config
  financeData: [] as any[],
  financeProducts: [] as any[],
  financeSyncing: false,
  financeWeekOffset: 0,
  financeProductMeal: 'all', // 'all', 'morning', 'lunch', 'afternoon', 'dinner', 'bar'
  financeProductLoc: 'all', // 'all', 'west', 'centraal', 'testtafel'
};

// ═══════════════════════════════════════════════════════════════════
