// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const DAYS=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const MEALS=['lunch','dinner'];
const STORAGE=['Gastro','Frozen','Vac-packed'];
const LOGISTICS=['Sering West','Transport to Sering Centraal','Transport to Sering West','Sering Centraal'];
const ALLERGENS=['Gluten','Soy','Nuts','Peanuts','Sesame','Celery','Mustard','Sulphites','Lupin','Onion','Garlic','Paprika'];
const ACCOMPANIMENTS=[
  { name:'Rice', gramsPerGuest:80 },
  { name:'Pasta', gramsPerGuest:80 },
];

// ═══════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════
let S = {
  currentLoc:'west',
  plannerSubTab:'west',
  filters:{loc:'all',storage:'all',logistics:'all'},
  selected:new Set(),
  orderToggles:{dishes:true,standard:false},
  caterings:[],
  transportItems:[],
  collapsedTypes:{},
  inventoryDone:{west:{lunch:null,dinner:null},centraal:{lunch:null,dinner:null}},
  guests:{
    west:{Mon:{lunch:100,dinner:110},Tue:{lunch:100,dinner:110},Wed:{lunch:100,dinner:110},Thu:{lunch:100,dinner:110},Fri:{lunch:80,dinner:90},Sat:{lunch:0,dinner:0},Sun:{lunch:0,dinner:0}},
    centraal:{Mon:{lunch:80,dinner:85},Tue:{lunch:80,dinner:85},Wed:{lunch:80,dinner:85},Thu:{lunch:80,dinner:85},Fri:{lunch:60,dinner:70},Sat:{lunch:0,dinner:0},Sun:{lunch:0,dinner:0}}
  },
  dishes:[],
  recipeIndex:[],
  ingredientDb:[],
  planner:{},
  user:null,
  dashboardLoc:'west',
  dashVegMode:'combined',
  dashVegModeTomorrow:'combined',
  prepChecklist: {}, // keyed by loc, value is Set of checked ingredient keys
  heatChecked: new Set(),   // dish IDs ticked off in Heat Up
  cookChecked: new Set(),   // dish IDs ticked off in Cook
  customTodos: [],          // [{id, text, done}] freeform team todos
  teamTodosOpen: false,     // floating panel expanded state
  guestHistory:null,
  predictions:null,
  guestsNextWeeks:{},
};

// ═══════════════════════════════════════════════════════════════════
