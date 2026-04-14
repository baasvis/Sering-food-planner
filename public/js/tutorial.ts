import { S, NAV_SCREENS } from './state';

// ── TUTORIAL SYSTEM ─────────────────────────────────────────────────────────
// Step-by-step walkthrough for each screen. Spotlights one element at a time
// with a tooltip. Language is intentionally plain — written for a brand new cook.
//
// ⚠️  MAINTENANCE RULE (see DESIGN.md §6):
//     Any time a new feature is added or an existing one changes, update the
//     relevant steps array below to match.
// ─────────────────────────────────────────────────────────────────────────────

export const TUTORIALS = {

  // ── DASHBOARD ──────────────────────────────────────────────────────────────
  dashboard: [
    {
      selector: '#app-title',
      title: 'Your kitchen',
      body: "You're looking at one location at a time. Tap the title to switch between Sering West and Sering Centraal.",
    },
    {
      selector: '.dash-meal-toggle',
      title: 'Lunch or dinner',
      body: "The dashboard shows one service at a time. Tap Lunch or Dinner to flip between them — the menu, guest count, flow chart, and cook list all update together.",
    },
    {
      selector: '#dash-menu-card',
      title: "Today's menu",
      body: "Every batch planned for the selected service. Allergens sit right on each chip so front-of-house always knows what's in the pot. Tap a chip to expand it for stock, cook date, recipe link and a starch picker for mains.",
    },
    {
      selector: '#dash-guests-card',
      title: 'Guests & flow',
      body: "The big number is how many people are expected for this service. The chart below shows the estimated arrival flow in 5-minute buckets — the dashed line marks the current time so you can plan plating around the peak.",
    },
    {
      selector: '#dash-stock-card',
      title: "What's in stock",
      body: "A snapshot of all cooked food on hand at this location, grouped by type with frozen batches at the bottom. Use the two buttons up top to start a cooked-food inventory or walk through an ingredient stocktake.",
    },
    {
      selector: '#dash-cook-card',
      title: 'What to cook',
      body: "Batches that still need cooking for the selected service. Tap each row to tick it off when it's done — it saves automatically and resets at midnight.",
    },
    {
      selector: '#dash-prep-card',
      title: 'What to chop',
      body: "Fresh ingredients that need prepping for today and tomorrow. Tap each one to tick it off — it saves automatically and resets at midnight.",
    },
    {
      selector: '#dash-team-card',
      title: "Team todo's",
      body: "Jot down extra tasks for the team — like 'clean walk-in' or 'fix label printer'. Type into the box, hit Add, and tick them off when done.",
    },
  ],

  // ── GUESTS ─────────────────────────────────────────────────────────────────
  guests: [
    {
      selector: '.gt-header',
      title: 'The week',
      body: "You're looking at one week at a time. Use the arrows to jump forward or back, or tap Today to come back to the current week.",
    },
    {
      selector: '.guest-table',
      title: 'Guest count table',
      body: "Each column is one day. Each row is lunch or dinner. Tap any number to edit it — just type the new headcount and tap away to save.",
    },
    {
      selector: '.gt-input',
      title: 'Edit a number',
      body: "Type the expected number of guests for that meal. These numbers flow directly to the Dashboard and are used to scale all recipes automatically.",
    },
    {
      selector: '.gt-total-cell',
      title: 'Weekly totals',
      body: "The total column adds up guests across the whole week. Useful for spotting heavy or light weeks at a glance.",
    },
  ],

  // ── WEEK PLAN ──────────────────────────────────────────────────────────────
  planner: [
    {
      selector: '.sub-tab-bar',
      title: 'Plan views',
      body: "Three views: the weekly menu overview, an inventory check, and transport between locations. Start with Overview.",
    },
    {
      selector: '.week-grid',
      title: 'The weekly menu',
      body: "Each column is one day, split into lunch and dinner. This is where you plan what gets served and when.",
    },
    {
      selector: '.dish-chip',
      title: 'A planned batch',
      body: "Each chip is one batch assigned to that meal. Colours show the type — green is soup, blue is main, purple is dessert.",
    },
    {
      selector: '.add-slot-btn',
      title: 'Add a batch',
      body: "Tap + to add a batch to this meal. You'll pick from your recipe library. A batch can appear on multiple days.",
    },
    {
      selector: '.type-section',
      title: 'Batches by type',
      body: "Below the grid, batches are grouped by type — soups, mains, desserts. Tap a batch to expand it, split it across locations, or adjust its cook date.",
    },
  ],

  // ── RECIPES ────────────────────────────────────────────────────────────────
  'recipe-index': [
    {
      selector: '#ri-search-input',
      title: 'Find a recipe',
      body: "Type here to search every recipe by name or allergen. The table below filters as you type.",
    },
    {
      selector: '.ri-filter-bar',
      title: 'Filter by type',
      body: "Quickly narrow the list to just soups, mains, or desserts.",
    },
    {
      selector: '.btn-row',
      title: 'Create or import',
      body: "'Create recipe' opens the guided editor where you build a recipe step by step — ingredients, method, storage. 'Import from Sheet' pulls in a recipe from the old Google Sheets format.",
    },
    {
      selector: '.ri-table',
      title: 'Recipe list',
      body: "Every recipe shows here with type, structure, cost, season, allergens and ratings. Click a name to open it, or use the sortable column headers to find cheap, seasonal, or crowd-favourite dishes fast.",
    },
    {
      selector: '.allergen-pill',
      title: 'Allergens',
      body: "Allergen tags appear on every recipe. New recipes auto-detect allergens from ingredients in the database — no manual entry needed.",
    },
  ],

  // ── ORDERS ─────────────────────────────────────────────────────────────────
  orders: [
    {
      selector: '.order-tab-bar',
      title: 'Order views',
      body: "Four ways to see what needs ordering: this week's batch ingredients, your standard stock items, a combined supplier list, and the full ingredient database.",
    },
    {
      selector: '.order-tab-btn',
      title: 'Combined order',
      body: "The combined view merges everything into one clean list — that's what you copy and send to your supplier. Hit 'Do stocktake' to walk through storage areas and count stock. Empty fields mean 'not counted', entering 0 means 'counted but nothing there'.",
    },
    {
      selector: '.batch-toggle-list',
      title: 'Batch ingredients',
      body: "Toggle batches on or off to see what ingredients they need. Only batches at the current location with recipe data appear here. The coloured dots in the breakdown column show how much each batch contributes.",
    },
    {
      selector: '.ing-table',
      title: 'Ingredient table',
      body: "Each row is one ingredient. The 'To order' column tells you exactly how much to buy, based on what the recipes need minus what you already have in stock.",
    },
    {
      selector: '#si-search-input',
      title: 'Standard stock',
      body: "Search here to add items to your regular order list — things you always keep stocked regardless of the weekly menu, like oil, salt, or cleaning supplies.",
    },
  ],
};

// ── State ─────────────────────────────────────────────────────────────────────
export let _tutScreen = null;
export let _tutStep   = 0;

// ── Public entry points ───────────────────────────────────────────────────────

export function startTutorial() {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const name = active.id.replace('screen-', '');
  if (!TUTORIALS[name] || !TUTORIALS[name].length) return;
  _tutScreen = name;
  _tutStep   = 0;
  _tutAdvance();
}

export function tutNext() { _tutStep++; _tutAdvance(); }
export function tutPrev() { _tutStep = Math.max(0, _tutStep - 1); _tutAdvance(); }
export function tutSkip() { _tutTeardown(); }

// ── Internal ──────────────────────────────────────────────────────────────────

export function _tutAdvance() {
  _tutTeardown();
  const steps = TUTORIALS[_tutScreen];
  if (!steps || _tutStep >= steps.length) { _tutTeardown(); return; }

  const step = steps[_tutStep];
  const el   = document.querySelector(step.selector);

  // Skip steps whose element isn't in the DOM (e.g. no starch picker if no mains)
  if (!el) { _tutStep++; _tutAdvance(); return; }

  // Scroll element into view, then render overlay after scroll settles
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => _tutRender(el, step, _tutStep + 1, steps.length), 320);
}

export function _tutRender(el: any, step: any, current: any, total: any) {
  const pad  = 10;
  const rect = el.getBoundingClientRect();

  const overlay = document.createElement('div');
  overlay.id = 'tut-overlay';

  // Tooltip position: prefer below, fall back to above
  const ttW  = Math.min(300, window.innerWidth - 32);
  const ttH  = 170; // rough estimate
  const gutter = 14;
  const navH   = 56; // approx height of the fixed nav

  let ttTop = rect.bottom + gutter;
  if (ttTop + ttH > window.innerHeight - 16) {
    ttTop = rect.top - ttH - gutter;
  }
  ttTop = Math.max(navH + 8, ttTop);

  let ttLeft = rect.left + rect.width / 2 - ttW / 2;
  ttLeft = Math.max(16, Math.min(window.innerWidth - ttW - 16, ttLeft));

  overlay.innerHTML = `
    <div id="tut-spotlight" style="
      left:${rect.left - pad}px;
      top:${rect.top - pad}px;
      width:${rect.width + pad * 2}px;
      height:${rect.height + pad * 2}px;
    "></div>
    <div id="tut-tooltip" style="left:${ttLeft}px;top:${ttTop}px;width:${ttW}px;">
      <div class="tut-count">${current} of ${total}</div>
      <div class="tut-title">${step.title}</div>
      <div class="tut-body">${step.body}</div>
      <div class="tut-actions">
        ${current > 1
          ? `<button class="tut-btn tut-back" onclick="tutPrev()">← Back</button>`
          : `<span></span>`}
        <button class="tut-btn tut-skip" onclick="tutSkip()">Skip</button>
        ${current < total
          ? `<button class="tut-btn tut-next" onclick="tutNext()">Next →</button>`
          : `<button class="tut-btn tut-done" onclick="tutSkip()">Done ✓</button>`}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
}

export function _tutTeardown() {
  document.getElementById('tut-overlay')?.remove();
}
