import { S } from './state';
import { setPlannerSubTab } from './planner';
import { switchOrdersTab, getOrdersTab } from './orders';
import { drinksSetTab } from './drinks';

// ── TUTORIAL SYSTEM ─────────────────────────────────────────────────────────
// The "?" button (bottom-right, "How does this page work?") runs a step-by-step
// walkthrough of the current screen. Each step spotlights one element and shows
// a plain-language tooltip — written for a brand new cook.
//
// Two mechanics worth knowing:
//   • Selectors are resolved *inside the active screen* (`.screen.active`). Every
//     screen lives in the DOM at once (hidden ones are just display:none), so a
//     bare class like `.ing-table` would otherwise match a hidden screen. Keep
//     selectors relative to the screen — don't target the top bar or FABs.
//   • A step may carry a `before()` hook that switches a sub-tab (or otherwise
//     reveals its element) so the tour can walk through tabbed content — see the
//     Week Plan and Orders tours. `before()` must be idempotent (it also runs
//     when stepping back). The original sub-tab is restored when the tour ends.
//
// ⚠️  MAINTENANCE RULE (see DESIGN.md §6):
//     Any time a feature is added or changed, update that screen's steps below to
//     match. Keys must equal the screen id (the part after `screen-`):
//     dashboard, guests, planner, recipe-index, orders, drinks, competencies,
//     supplies, finance, feedback-admin, team.
// ─────────────────────────────────────────────────────────────────────────────

export interface TutStep {
  /** CSS selector, resolved within the active screen. */
  selector: string;
  title: string;
  body: string;
  /** Optional: reveal this step's element first (e.g. switch to its sub-tab).
   *  Runs on both Next and Back, so it must be idempotent. */
  before?: () => void;
}

// Switch a sub-tab only when not already there, so stepping through several
// steps on the same tab doesn't re-render (and flash) the screen each time.
function goPlannerTab(tab: string) { if (S.plannerSubTab !== tab) setPlannerSubTab(tab); }
function goOrdersTab(tab: string)  { if (getOrdersTab() !== tab) switchOrdersTab(tab); }
function goDrinksTab(tab: string)  { if (S.drinksSubTab !== tab) drinksSetTab(tab); }

export const TUTORIALS: Record<string, TutStep[]> = {

  // ── DASHBOARD ──────────────────────────────────────────────────────────────
  dashboard: [
    {
      selector: '.dash-meal-toggle',
      title: 'Lunch or Dinner',
      body: "Everything on this screen follows this switch — the menu, the guest count, what to cook and what to chop. It flips to dinner automatically later in the day, but you can tap to change it any time.",
    },
    {
      selector: '#dash-menu-card',
      title: "Today's menu",
      body: "Every batch on the menu for the meal you picked, grouped by type. Allergens are listed on each one so front-of-house always knows what's inside.",
    },
    {
      selector: '.dash-starch-meal-summary',
      title: 'Rice or pasta',
      body: "Open any main on the menu and tap Rice or Pasta — the total kilos to cook add up right here, so there's no mental maths.",
    },
    {
      selector: '.dash-guest-big',
      title: 'Guests expected',
      body: "How many people are expected for this meal — you set these in the Guests tab, and they scale every recipe. The graph below shows when they arrive, with a 'Now' line and the busiest moment marked so you can time your plating.",
    },
    {
      selector: '.ritual-panel',
      title: 'Your day, step by step',
      body: "This is your guide for the day at this location. It shows what to do and when. The step for right now is highlighted, and steps turn red if they are late. Tap a step to see why we do it. Some steps tick themselves; tap the box on the others.",
    },
    {
      selector: '#dash-stock-card',
      title: "What's in stock",
      body: "All cooked food on hand at this location, grouped by type with frozen split out. The chips show when each kitchen last counted its stock; the buttons open the cooked-food inventory and start an ingredient stocktake.",
    },
    {
      selector: '#dash-supplies-card',
      title: 'Toppings & bread',
      body: "Stock versus demand for your toppings, sides and bread — a red number means you're short — plus the cost they add per guest. 'Manage' opens the full Toppings & bread screen.",
    },
    {
      selector: '.tcard',
      title: 'Pack for Centraal',
      body: "When food needs to travel to Centraal, this card lists what to send. Confirm the amounts once everything's cooked and it moves onto the Transport list.",
    },
    {
      selector: '#dash-cook-card',
      title: 'What to cook',
      body: "Batches still to cook for this meal. Tick one off to record it as cooked — you'll pick the kitchen, then confirm the recipe.",
    },
    {
      selector: '#dash-prep-list',
      title: 'What to chop',
      body: "Fresh ingredients to prep for today and tomorrow. Tap each one to tick it off — it saves automatically and resets at midnight.",
    },
    {
      selector: '#custom-todo-input',
      title: 'Team to-dos',
      body: "Jot down extra jobs for the team — like 'clean the walk-in' or 'fix the label printer'. Type and hit Add, then tick them off when done.",
    },
  ],

  // ── GUESTS ─────────────────────────────────────────────────────────────────
  guests: [
    {
      selector: '.gt-header',
      title: 'Your week',
      body: "You're looking at a rolling 7-day window. Use the arrows to move a day at a time, or tap Today to jump back to now.",
    },
    {
      selector: '.guest-table',
      title: 'Guest counts',
      body: "Each column is a day; the two rows are lunch and dinner. These numbers flow straight to the Dashboard and scale every recipe automatically.",
    },
    {
      selector: '.gt-input',
      title: 'Set a number',
      body: "Tap any cell and type the expected headcount, then tap away to save. The grey ~number underneath is the prediction from past weeks, so you can see if you're above or below normal.",
    },
    {
      selector: '[data-testid="apply-predictions-btn"]',
      title: 'Fill from history',
      body: "Once there's enough history, this fills the whole window with predicted counts in one tap — then you just tweak the days you know will be busier or quieter.",
    },
    {
      selector: '.gt-upload-card',
      title: 'Import from the till',
      body: "Drop a Tebi or Lightspeed export here to build guest history automatically — the app works out the format for you. Counts also fill in on their own from the daily Tebi sync.",
    },
    {
      selector: '.gt-total-cell',
      title: 'Totals',
      body: "The totals add up guests per day and across the whole week — handy for spotting a heavy or quiet week at a glance.",
    },
  ],

  // ── WEEK PLAN ──────────────────────────────────────────────────────────────
  planner: [
    {
      selector: '.sub-tab-bar',
      title: 'Five views',
      body: "Plan Sering West or Sering Centraal one kitchen at a time, see food set To Transport between kitchens, manage Caterings, or open Overview for every batch in one list. I'll walk you through each.",
    },
    {
      selector: '[data-testid="new-batch-btn"]',
      title: 'Make a new batch',
      body: "A batch is one container of food. Start one here, then place it on the days it's served.",
      before: () => goPlannerTab(S.currentLoc),
    },
    {
      selector: '.week-grid',
      title: 'The week',
      body: "Each column is a day, split into lunch and dinner. There's a separate calendar for soups, mains and desserts so nothing gets lost.",
      before: () => goPlannerTab(S.currentLoc),
    },
    {
      selector: '.dish-chip',
      title: 'A planned batch',
      body: "Each chip is one batch sitting in a slot. The colour shows the type — green for soup, blue for main, purple for dessert.",
    },
    {
      selector: '.add-slot-btn',
      title: 'Fill a slot',
      body: "Tap + on any meal to drop a batch into it. The same batch can serve several days in a row.",
      before: () => goPlannerTab(S.currentLoc),
    },
    {
      selector: '.batch-pool-toggle',
      title: 'Unplaced batches',
      body: "Batches that exist but aren't on the calendar yet wait in these pools, grouped by type. Open one and drag a batch up into the grid.",
    },
    {
      selector: '.btn-fix-menu',
      title: 'Fix my menu',
      body: "On the West tab, this fills the gaps for you — it generates placeholder batches for everything that still needs cooking and slots them in. The Cook rules and Equipment buttons next to it tell it how much to make at once.",
      before: () => goPlannerTab('west'),
    },
    {
      selector: '.cost-bar',
      title: 'Cost per guest',
      body: "This shows what the food West is cooking costs per guest — split into soups, mains and toppings — against your targets. Green is on track, amber is creeping up, red is over. It covers everything West cooks (including food sent to Centraal) and firms up as placeholders become real dishes. A director can tap ⚙ to set the targets.",
      before: () => goPlannerTab('west'),
    },
    {
      selector: '.catering-layout',
      title: 'Caterings',
      body: "Plan one-off catering jobs here — create the event on the left, then drag dishes onto it from the list on the right.",
      before: () => goPlannerTab('caterings'),
    },
    {
      selector: '#transport-item-input',
      title: 'Between kitchens',
      body: "Food on its way from one kitchen to another shows here as a shipment you mark 'arrived' on the other side. You can also jot free-text items to remember to bring along.",
      before: () => goPlannerTab('transport'),
    },
    {
      selector: '.filter-bar',
      title: 'Everything at once',
      body: "Overview lists every batch across both kitchens. Filter by location or storage and sort to find anything fast.",
      before: () => goPlannerTab('overview'),
    },
  ],

  // ── RECIPES ────────────────────────────────────────────────────────────────
  'recipe-index': [
    {
      selector: '#ri-search-input',
      title: 'Find a recipe',
      body: "Type here to filter the list by recipe name or allergen as you go.",
    },
    {
      selector: '.ri-filter-bar',
      title: 'Filter by type',
      body: "Narrow the list to just soups, mains or desserts. 'All types' shows everything.",
    },
    {
      selector: '[data-testid="recipe-create-btn"]',
      title: 'Build a recipe',
      body: "Opens the step-by-step editor: add ingredients from the database, the method, storage and serving size. Allergens, cost and nutrition fill in automatically.",
    },
    {
      selector: '[data-testid="recipe-ai-btn"]',
      title: 'Draft with AI',
      body: "Describe a dish and the assistant drafts a full recipe you can tweak and save. (Only the director sees this button.)",
    },
    {
      selector: '.ri-table',
      title: 'Your recipes',
      body: "Every recipe lives here — click a column heading to sort, or a recipe's name to view it. Each row has Edit, + Menu to add it to this week's plan, and ✕ to delete.",
    },
    {
      selector: '.allergen-pill',
      title: 'Allergens',
      body: "Allergen tags show on every recipe, detected automatically from its ingredients — no manual entry needed.",
    },
  ],

  // ── ORDERS ─────────────────────────────────────────────────────────────────
  orders: [
    {
      selector: '.order-tab-bar',
      title: 'Four views',
      body: "Four ways to see what to buy: a Combined order to send your supplier, your Standard stock list, this week's Batch ingredients, and the full Ingredient database. I'll show each one.",
    },
    {
      selector: '.ing-table',
      title: 'Combined order',
      body: "Everything you need merged into one list, grouped by storage area and shown in supplier units. The 'To order' column is what to actually buy: what the recipes need minus what's already in stock. Copy it and send it off.",
      before: () => goOrdersTab('combined'),
    },
    {
      selector: '[data-testid="stocktake-start-btn"]',
      title: 'Count your stock',
      body: "Walk storage area by area and count what's on the shelf. An empty box means 'not counted'; typing 0 means 'counted, none there'. Your counts feed straight into the 'To order' column.",
      before: () => goOrdersTab('combined'),
    },
    {
      selector: '.hanos-bulk-btn',
      title: 'Order from Hanos',
      body: "If Hanos is connected for this kitchen, these 🛒 buttons push items straight into your Hanos cart — one item, or a whole storage group at once.",
    },
    {
      selector: '.batch-toggle-list',
      title: 'Batch ingredients',
      body: "Switch individual batches on or off to see exactly what they need. Only batches at this kitchen with recipe data appear; the coloured dots show how much each batch contributes.",
      before: () => goOrdersTab('batches'),
    },
    {
      selector: '#si-search-input',
      title: 'Standard stock',
      body: "Your always-in-stock items — oil, salt, cleaning supplies — kept regardless of the weekly menu. Search to add one; the amount to order is worked out from your target minus what's on hand.",
      before: () => goOrdersTab('standard'),
    },
    {
      selector: '.ing-filter-bar',
      title: 'Ingredient database',
      body: "The full catalogue behind everything — prices, suppliers, order codes, storage areas and allergens. This is also where supplier price-list uploads land.",
      before: () => goOrdersTab('ingredientDb'),
    },
  ],

  // ── TRAINING (competencies) ─────────────────────────────────────────────────
  competencies: [
    {
      selector: '.comp-header',
      title: 'Training board',
      body: "This tracks who's been taught what. A 'chunk' is one skill or station task. You add people, log teachings, and see at a glance who still needs what.",
    },
    {
      selector: '[data-testid="comp-add-person"]',
      title: 'Add a name',
      body: "Put a new cook or learner on the board so you can start tracking their skills.",
    },
    {
      selector: '.comp-grid-wrap',
      title: 'Who knows what',
      body: "Rows are people, columns are skills. A green cell was taught recently; a blank cell means it hasn't been taught yet — that's your cue to teach it.",
    },
    {
      selector: '[data-testid="comp-cell"]',
      title: 'Log a teaching',
      body: "Tap any cell to record that someone was taught that skill — pick who taught it and the date. Tap a person's name or a column heading to open their full history.",
    },
    {
      selector: '.comp-ledger',
      title: 'Recent teachings',
      body: "A running list of the latest teachings across the team, newest first.",
    },
  ],

  // ── TOPPINGS & BREAD (supplies) ──────────────────────────────────────────────
  supplies: [
    {
      selector: '.screen-header',
      title: 'Toppings & bread',
      body: "Track the accompaniments — toppings, sides, sauces and bread — separately from your main batches, so you always know how much to make versus what's already in stock.",
    },
    {
      selector: '[data-testid="supplies-new"]',
      title: 'Add an item',
      body: "Create a new topping, side or bread. Standard items scale with guest numbers (like '1 bread per 10 guests'); one-off items are a fixed batch you use up over time.",
    },
    {
      selector: '#supplies-results',
      title: 'Stock vs demand',
      body: "Each item shows stock at each kitchen against the demand for the next few days — a red number means you're short — plus the cost it adds per guest. After you make a batch, hit 'Log prep' on its row to add it to stock.",
    },
    {
      selector: '#sup-search',
      title: 'Find & tidy',
      body: "Search by name to jump to an item, or tick 'Include archived' to bring back ones you've retired.",
    },
  ],

  // ── FINANCE ──────────────────────────────────────────────────────────────────
  finance: [
    {
      selector: '.fin-header',
      title: 'Week & sync',
      body: "All the numbers here come from the Tebi till. Use the arrows to pick a week, and 'Sync from Tebi' to pull in the latest takings.",
    },
    {
      selector: '.fin-month-summary',
      title: 'This month',
      body: "Totals for the whole month around the week you're viewing: gross (with VAT) and net (without), the number of sales, and covers served.",
    },
    {
      selector: '.fin-chart-section',
      title: 'Day by day',
      body: "Gross takings for each day of the selected week, with today highlighted.",
    },
    {
      selector: '.fin-table-section',
      title: 'By location',
      body: "The same week broken down per kitchen — Sering West, Centraal and TestTafel — with a weekly total on the right.",
    },
    {
      selector: '.fin-product-filters',
      title: 'Filter the breakdown',
      body: "Below this, drill into what actually sold. Filter by service (morning, lunch, dinner, bar…) and by location.",
    },
    {
      selector: '.fin-product-table-wrap',
      title: 'Top products',
      body: "Your best-selling products by revenue, with their category and share of the total.",
    },
  ],

  // ── FEEDBACK ─────────────────────────────────────────────────────────────────
  'feedback-admin': [
    {
      selector: '#feedback-admin-header',
      title: 'The feedback inbox',
      body: "Everything submitted through the floating Feedback button lands here. 'Copy for Claude' grabs all of it as text to paste into a Claude chat for help acting on it.",
    },
    {
      selector: '#feedback-filter-bar',
      title: 'Filter by type',
      body: "Jump to ideas, issues, confusing bits, nice notes or general feedback — each with a live count. By default only open items show; the 'Show processed' toggle reveals the ones already marked done.",
    },
    {
      selector: '.feedback-card',
      title: 'One piece of feedback',
      body: "Each card shows the type, which screen it came from, and who sent it when. Hit Done once you've handled it — the count at the top tracks what's left.",
    },
  ],

  // ── TEAM (access requests) ───────────────────────────────────────────────
  team: [
    {
      selector: '.team-intro',
      title: 'Letting people in',
      body: "When someone taps “Request access” on the login screen, their request lands here. Approving them grants access within seconds — no settings change or redeploy needed.",
    },
    {
      selector: '.team-section',
      title: 'Pending requests',
      body: "People waiting for approval show at the top, with the name, email and photo from their Google account. Approve to let them in, or Deny to turn them down.",
    },
    {
      selector: '.team-fold',
      title: 'Who already has access',
      body: "Approved people can be revoked here if they leave. The “always allowed” list is fixed in the server config and can’t be changed from this screen — so you can’t lock yourself out.",
    },
  ],

  // ── DRINKS ───────────────────────────────────────────────────────────────────
  drinks: [
    {
      selector: '.drinks-tabs',
      title: 'The drinks module',
      body: "Everything drinks lives here, split into tabs across the top. This tour walks through each one.",
    },
    {
      selector: '[data-testid="drinks-tab-catalogue"]',
      before: () => goDrinksTab('catalogue'),
      title: 'Catalogue',
      body: "Every drink, per location (toggle West/Centraal): needed level, stock, prices, alcohol %, and a Cost % that turns red when a drink is under-priced. Tick a drink active or not per location. “+ Add drink” covers bought AND recipe drinks, or import a whole supplier PDF with AI.",
    },
    {
      selector: '[data-testid="drinks-tab-bar"]',
      before: () => goDrinksTab('bar'),
      title: 'Bar',
      body: "The floor reference, grouped by type with the info right on the card — wine origin and tasting notes, how to serve cocktails, how to make coffees. Add a photo of the finished drink from here too.",
    },
    {
      selector: '[data-testid="drinks-tab-recipes"]',
      before: () => goDrinksTab('recipes'),
      title: 'Recipes',
      body: "Homemade drinks, cocktails and building blocks (syrups, super-juices). The editor shows live cost and a suggested price as you build, with a markup traffic-light.",
    },
    {
      selector: '[data-testid="drinks-tab-stocktake"]',
      before: () => goDrinksTab('stocktake'),
      title: 'Stocktake',
      body: "Your stock list, grouped by colour-coded storage area. Type a count and it saves on the spot; set each drink's home area right in the list. “Count by area” gives a focused walk-through of one area, or count a supplier delivery.",
    },
    {
      selector: '[data-testid="drinks-tab-orders"]',
      before: () => goDrinksTab('orders'),
      title: 'Orders',
      body: "Everything that's short shows up automatically under its supplier, with order instructions and the order cost on top. Adjust the quantities, tap Place order, then receive line-by-line when it arrives — stock updates itself.",
    },
    {
      selector: '[data-testid="drinks-tab-production"]',
      before: () => goDrinksTab('production'),
      title: 'Production',
      body: "A to-make list for homemade drinks below their needed level. Log a batch (premix stock goes up, building blocks down) or write off breakage, spillage, expired or comps.",
    },
    {
      selector: '[data-testid="drinks-tab-menus"]',
      before: () => goDrinksTab('menus'),
      title: 'Assortments & menus',
      body: "Curate which drinks each location offers, pick a subset for each menu (a lunch list, a wine list…), choose A4 or A5 and a template, and print with live prices.",
    },
  ],
};

// ── State ───────────────────────────────────────────────────────────────────
export let _tutScreen: string | null = null;
export let _tutStep = 0;
// Set when a tour switches sub-tabs, so we can put the screen back on teardown.
let _tutRestore: (() => void) | null = null;

// ── Public entry points ──────────────────────────────────────────────────────

export function startTutorial() {
  const active = document.querySelector('.screen.active');
  if (!active) return;
  const name = active.id.replace('screen-', '');
  const steps = TUTORIALS[name];
  if (!steps || !steps.length) return;
  _tutScreen = name;
  _tutStep = 0;
  // Remember where the user was, so the auto-walk puts sub-tabs back at the end.
  _tutRestore = null;
  if (name === 'planner') { const t = S.plannerSubTab; _tutRestore = () => goPlannerTab(t); }
  else if (name === 'orders') { const t = getOrdersTab(); _tutRestore = () => goOrdersTab(t); }
  else if (name === 'drinks') { const t = S.drinksSubTab; _tutRestore = () => goDrinksTab(t); }
  _tutAdvance();
}

export function tutNext() { _tutStep++; _tutAdvance(); }
export function tutPrev() { _tutStep = Math.max(0, _tutStep - 1); _tutAdvance(); }
export function tutSkip() { _tutFinish(); }

// ── Internal ──────────────────────────────────────────────────────────────────

// Resolve a step's selector inside the screen that's currently showing, so a
// class name shared with a hidden screen can't be matched by mistake.
function _tutFindEl(selector: string): Element | null {
  const root = document.querySelector('.screen.active');
  return root ? root.querySelector(selector) : null;
}

// Poll briefly for an element — used after a `before` hook that may have just
// re-rendered (sometimes asynchronously, e.g. a tab that lazy-loads its data).
function _tutWaitFor(selector: string, cb: (el: Element | null) => void, tries = 16) {
  const el = _tutFindEl(selector);
  if (el || tries <= 0) { cb(el); return; }
  setTimeout(() => _tutWaitFor(selector, cb, tries - 1), 60);
}

export function _tutAdvance() {
  _tutTeardown();
  const steps = _tutScreen ? TUTORIALS[_tutScreen] : null;
  if (!steps || _tutStep < 0 || _tutStep >= steps.length) { _tutFinish(); return; }

  const step = steps[_tutStep];
  if (step.before) { try { step.before(); } catch (e: unknown) { /* a missing tab shouldn't break the tour */ } }

  const show = (el: Element | null) => {
    // Skip steps whose element isn't on this screen — e.g. no mains → no starch
    // summary, no Hanos creds → no Hanos button, non-director → no AI button.
    if (!el) { _tutStep++; _tutAdvance(); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => _tutRender(el, step, _tutStep + 1, steps.length), 320);
  };

  // Only poll when a `before` ran (the DOM may still be settling). Otherwise the
  // element is either here now or never — skip instantly, no needless wait.
  if (step.before) _tutWaitFor(step.selector, show);
  else show(_tutFindEl(step.selector));
}

export function _tutRender(el: Element, step: TutStep, current: number, total: number) {
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

// Final teardown when the tour ends (Skip, Done, or running off the end):
// remove the overlay and restore any sub-tab the auto-walk switched away from.
function _tutFinish() {
  _tutTeardown();
  if (_tutRestore) { try { _tutRestore(); } catch (e: unknown) { /* ignore */ } _tutRestore = null; }
  _tutScreen = null;
  _tutStep = 0;
}
