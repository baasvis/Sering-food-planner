# UI/UX & Accessibility

## Scope of review

This pass covered the user-facing surfaces of the newer screens (Dashboard Today panel, Competencies grid, Supplies tables, the recipe-AI chat) plus the persistent Search/Filter and live-tick rendering patterns, with particular attention to keyboard access, mobile layout, focus preservation, and screen-reader announcement. Findings are sorted by adjusted severity.

## Findings

### UIUX-2 — Ticking a manual Today-panel step flashes the entire dashboard through its 'Loading dashboard…' placeholder

- **Severity**: Medium
- **Location**: public/js/today-panel.ts:163-166 (toggleRitualStep -> rerenderCurrentView), public/js/navigate.ts:47-49, public/js/dashboard.ts:399-422 (renderDashboard)
- **What**: toggleRitualStep() calls rerenderCurrentView(), which dispatches to the registered 'dashboard' renderer renderDashboard() — the variant that first paints the 'Loading dashboard…' placeholder and then async-refetches the prep checklist before painting content — even though markRitualStep updates S.ritualCompletions synchronously in memory.
- **Why it matters**: Every tap of a ritual checkbox (a primary interaction in the new Today panel) makes the whole dashboard blink to a loading spinner and re-issue a prep-checklist network request, which is visually jarring and wasteful for what is a purely local state flip.
- **Suggested fix**: Have toggleRitualStep call renderDashboardContent() directly (data is already in S), or add a lightweight in-place re-render of just the Today panel, instead of routing through renderDashboard()'s loading-placeholder + async path.
- **Confidence**: High.
- **Verified**:

  // today-panel.ts:163-166
  export function toggleRitualStep(loc: string, key: string): void {
    markRitualStep(loc, key, !isRitualStepDone(loc, key));
    rerenderCurrentView();  // calls renderers['dashboard'] = renderDashboard
  }

  // navigate.ts:47-49
  export function rerenderCurrentView() {
    const fn = renderers[_currentScreen];
    if (fn) fn();
    ...
  }

  // dashboard.ts:399-421
  export function renderDashboard() {
    rebuildPlanner();
    ...
    document.getElementById('screen-dashboard')!.innerHTML = `
      <div id="dash-content">
        <div style="padding:40px 20px;text-align:center;...animation:pulse 1.2s...">
          Loading dashboard…
        </div>
      </div>
    `;
    void refreshAccessBanner();
    loadDayTodos();
    loadPrepChecklist(loc).then(() => { renderDashboardContent(); });
  }
- **Reviewer notes**: The claim is fully confirmed. toggleRitualStep -> rerenderCurrentView() -> renderDashboard() -> immediate innerHTML replace with 'Loading dashboard…' placeholder -> async loadPrepChecklist network call -> renderDashboardContent(). Every ritual checkbox tap triggers the loading placeholder and a fresh prep-checklist network request. renderDashboardContent() is already exported (line 1022) and could be called directly from toggleRitualStep to bypass this entirely, since markRitualStep updates S synchronously and the ritual panel only reads from S. Severity Medium is correctly calibrated — it's a real, jarring UX regression on what should be a zero-cost local state flip, but not data-loss or a security issue.

### UIUX-3 — Competencies grid is entirely mouse-only — every cell, column header and row header is a click-only <td>/<th> with no keyboard path

- **Severity**: Medium
- **Location**: public/js/competencies.ts:183-194 (buildGridHtml: comp-chunkhead/comp-cell/comp-rowhead onclick), and the screen has zero tabindex/role/onkeydown (grep returned no matches)
- **What**: The competencies grid's interactive elements (column-header chunk drill-down, row-header person drill-down, and the cell tap that opens the log-teaching modal) are <th>/<td> elements carrying only onclick, with no tabindex, role=button, or keydown handler anywhere in competencies.ts, so a keyboard-only user cannot log a teaching or open any detail view.
- **Why it matters**: The training tracker is a brand-new core workflow whose single entry point (tapping a grid cell) is unreachable without a mouse/touch, excluding keyboard and assistive-tech users from the feature entirely; this is a worse instance of the prior global a11y gap because the whole feature, not just a nicety, is gated behind click-only cells.
- **Suggested fix**: Render the actionable header/cell controls as <button> (or add role="button" tabindex="0" plus an onkeydown that fires on Enter/Space, mirroring the pattern already used for .dash-arrival-block in transport-card.ts:682-684).
- **Confidence**: High.
- **Verified**:

  Lines 183-194 of public/js/competencies.ts:

    const head = visibleChunks.map(c =>
      `<th class="comp-chunkhead" ... onclick="openCompChunk(this.dataset.chunk)">${esc(c.name)}</th>`
    ).join('');
    const cells = visibleChunks.map(c => {
      return `<td class="comp-cell ${cls}" ... onclick="openCompLogModal(this.dataset.learner, this.dataset.chunk)">${label}</td>`;
    }).join('');
    return `<tr><th class="comp-rowhead" ... onclick="openCompPerson(this.dataset.person)">${esc(p.name)}</th>${cells}</tr>`;

  A grep for `tabindex|role=.button|onkeydown|keydown|aria-` across the entire competencies.ts file returned zero matches, confirming no keyboard accessibility attributes exist anywhere in the module.
- **Reviewer notes**: The finding is accurate. All three interactive element types (comp-chunkhead column headers, comp-rowhead row headers, comp-cell data cells) are plain <th>/<td> elements with onclick-only handlers. No tabindex, role="button", onkeydown, or aria-* attributes are present anywhere in the file. The severity Medium is appropriate: this is a new core workflow feature where the primary interaction (logging a teaching via cell tap) is entirely unreachable by keyboard or assistive-tech users.

### UIUX-4 — Supplies screen's 9-column tables have no horizontal-scroll wrapper or mobile styles and will overflow/squish on phones

- **Severity**: Medium
- **Location**: public/js/supplies.ts:112-135 (renderSupplyTable, table width:100% inside a plain .card) and public/css/supplies.css (no @media query, no overflow-x)
- **What**: renderSupplyTable emits a 9-column table styled width:100% wrapped only in a .card with no overflow-x, and supplies.css contains no media query or overflow handling, so on a ~360px phone the columns (Name, Unit, Mode, Stock West, Stock Centraal, Demand, Cost/guest, Method, actions) are forced to compress past readability.
- **Why it matters**: CLAUDE.md and the prior audit establish the app as mobile-first for the kitchen team; unlike the new competencies grid (which has overflow-x:auto) and team screen (which has a 560px media block), the supplies screen ships with neither, so a primary new screen is effectively unusable on the phones cooks actually use.
- **Suggested fix**: Wrap the table in a scroll container (overflow-x:auto; -webkit-overflow-scrolling:touch) like competencies.css's .comp-grid-wrap, and/or add a max-width:600px media block that collapses the table to a card/stacked layout on mobile.
- **Confidence**: Medium.
- **Verified**:

  public/js/supplies.ts:114-133 — renderSupplyTable wraps the 9-column table in a bare `<div class="card">` with no scroll container:

    return `
      <div class="card" style="margin-bottom:12px;">
        <h3 ...>${label}</h3>
        <table class="supplies-table" style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr ...>
              <th>Name</th><th>Unit</th><th>Mode</th><th>Stock West</th>
              <th>Stock Centraal</th><th>Demand (next horizon)</th>
              <th>Cost / guest</th><th>Method</th><th></th>
            </tr>
          </thead>
          ...
        </table>
      </div>

  public/css/supplies.css (44 lines) — only th/td padding, hover, empty-state, and .sup-help styles; zero @media queries and zero overflow-x declarations.

  public/css/mobile.css — no mention of supplies, screen-supplies, or supplies-table anywhere.

  public/css/mobile.css:6 sets `.screen { overflow-x:hidden }` on mobile, so the wide table is clipped rather than scrollable — exactly the failure mode described.

  For comparison, competencies.css:14 shows the correct mitigation pattern: `.comp-grid-wrap { overflow-x:auto; -webkit-overflow-scrolling:touch; }` — absent here.
- **Reviewer notes**: The finding is accurate in every detail. The supplies screen's 9-column table has no horizontal-scroll wrapper and no mobile media query. The base mobile rule `.screen { overflow-x:hidden }` will clip the table on ~360px phones rather than allow scrolling. The fix is straightforward: wrap the table in a div with overflow-x:auto (as competencies.css already does with .comp-grid-wrap).

### UIUX-6 — Ingredient-DB search still re-renders the whole Orders screen on every keystroke, replacing the input it is typing into (Search/Filter rule violation persists in the rewrite)

- **Severity**: Medium
- **Location**: public/js/ingredient-db.ts:58-67 (updateIngredientSearch -> renderOrders) and the input rendered inside the same render at ingredient-db.ts:238
- **What**: updateIngredientSearch() sets ingredientDbSearch then calls renderOrders(), which rebuilds the entire Orders screen including the #ing-db-search input, then a requestAnimationFrame re-finds the input and restores the caret — directly violating CLAUDE.md's 'never replace the input's own DOM element' rule that the rewritten ingredient-db was supposed to follow.
- **Why it matters**: With ~2000+ ingredients the filter+sort+full-HTML rebuild runs on every keystroke (multiple full re-renders to type a word), causing visible lag on mobile and caret-jump risk; the prior audit flagged this (U21) and the ingredient-db rewrite carried the anti-pattern forward instead of fixing it.
- **Suggested fix**: Adopt the split-container pattern already used by supplies (renderSupplies + updateSupplyResults) and recipes (renderRecipeIndex + updateRecipeResults): render the search input once at parent scope and have the input handler update only a #ingredient-db-results container.
- **Confidence**: High.
- **Verified**:

  // ingredient-db.ts:58-67
  export function updateIngredientSearch(el: HTMLInputElement) {
    const pos = el.selectionStart;
    ingredientDbSearch = el.value;
    ingredientDbPage = 0;
    renderOrders();                          // replaces entire #screen-orders DOM
    requestAnimationFrame(() => {
      const input = document.getElementById('ing-db-search') as HTMLInputElement | null;
      if (input) { input.focus(); input.setSelectionRange(pos, pos); }  // re-finds after replacement
    });
  }

  // orders.ts:442-443
  const screenEl = document.getElementById('screen-orders');
  screenEl.innerHTML = tabBar + content;    // whole screen replaced including #ing-db-search

  // ingredient-db.ts:237-238 (rendered inside renderIngredientDbTab → content → screenEl.innerHTML)
        id="ing-db-search" value="${esc(ingredientDbSearch)}" oninput="updateIngredientSearch(this)" />
- **Reviewer notes**: The finding is accurate. Every keystroke in the ingredient-db search input triggers updateIngredientSearch() → renderOrders() → screenEl.innerHTML = tabBar + content, which destroys and recreates the entire #screen-orders DOM including the #ing-db-search input itself. The requestAnimationFrame caret-restore workaround at lines 63-66 is the telltale sign of the anti-pattern. The split-container pattern used by renderSupplies/updateSupplyResults and renderRecipeIndex/updateRecipeResults is not applied here. Severity Medium is calibrated correctly: visible caret-jump risk and performance cost on large ingredient lists, but not a data-loss or security issue.

### UIUX-1 — Dashboard's 60s freshness tick rebuilds #dash-content, clobbering focus and uncommitted input in the Team To-Dos box and inline stocktake

- **Severity**: Low (adjusted from Medium)
- **Location**: public/js/dashboard.ts:947-956 (setInterval -> renderDashboardContent), inputs at dashboard.ts:1199 (#custom-todo-input) and dashboard.ts:834 (.dash-st-input)
- **What**: The setInterval at dashboard.ts:950 calls renderDashboardContent() every 60s whenever the dashboard is visible, which sets #dash-content.innerHTML and destroys the #custom-todo-input and .dash-st-input elements with no guard for whether the user is currently typing in them.
- **Why it matters**: A cook typing a Team To-Do loses the half-typed text at the minute boundary (it is only read on Enter/Add), and anyone entering numbers in the dashboard's inline stocktake loses focus and caret position mid-entry; this is a new regression introduced by coupling the live Today panel to a full-content re-render.
- **Suggested fix**: Before the tick re-renders, bail out if document.activeElement is inside #dash-content (e.g. an INPUT/TEXTAREA), or narrow the tick to update only the Today panel and 'X min ago' counters in place rather than rebuilding the whole #dash-content.
- **Confidence**: High.
- **Verified**:

  public/js/dashboard.ts lines 950-955: The setInterval fires every 60s with no activeElement guard, calling renderDashboardContent(). At line 1074, renderDashboardContent() unconditionally sets el.innerHTML = `...` which destroys and recreates all DOM nodes in #dash-content, including the #custom-todo-input at line 1199 (inside the template string).

  However, the claim about .dash-st-input is wrong: the stocktake inputs (line 834) are rendered inside renderStocktakeModal() which calls showModal(html) at lines 798 and 851 — a separate overlay element outside #dash-content. The 60s tick only rebuilds #dash-content, so the stocktake modal inputs are not affected.

  The real bug is limited to #custom-todo-input losing focus and in-progress text every 60s. This is a real but low-impact nuisance: the user must be actively typing in that field at the exact 60-second boundary. The severity claim of Medium is overstated given the narrow time window and single affected input; Low is more appropriate.
- **Reviewer notes**: The stocktake-input half of the claim is invalid — the stocktake runs in a modal (showModal), not inline in #dash-content. Only the Team To-Do input (#custom-todo-input) is genuinely at risk of losing uncommitted text on the 60-second tick. The bug is real but affects a narrow window (user typing at exactly the minute boundary) in a single low-stakes input, warranting Low rather than Medium severity.

### UIUX-5 — New supplies screen uses native alert()/confirm() instead of the documented toastError/pushUndo pattern

- **Severity**: Low
- **Location**: public/js/supplies.ts:334, supplies.ts:361, supplies.ts:386 (confirm before delete), supplies.ts:427
- **What**: supplies.ts validates with alert() (lines 334, 361, 427) and gates the permanent delete with confirm() (line 386), even though CLAUDE.md states destructive actions use pushUndo (not confirm()) and the codebase already provides toastError() for inline validation.
- **Why it matters**: Native dialogs block the event loop, can't be themed, and on iOS render as a generic 'this page says…' prompt users dismiss reflexively; the inconsistency is exactly the pattern the project convention exists to prevent, and it reintroduces it in new code.
- **Suggested fix**: Replace the alert() validation calls with toastError() (or inline-below-field messages) and replace the delete confirm() with the existing pushUndo 5s-undo flow used by deleteBatch/deleteCatering.
- **Confidence**: High.
- **Verified**:

  public/js/supplies.ts:334: `if (!name) { alert('Please enter a name'); return; }`
  public/js/supplies.ts:361: `if (payload.guestsPerUnit <= 0) { alert('Guests served per unit must be greater than 0'); return; }`
  public/js/supplies.ts:386: `if (!confirm(\`Delete "${s.name}"? This is permanent.\`)) return;`
  public/js/supplies.ts:427: `if (!Number.isFinite(amount) || amount <= 0) { alert('Enter a positive amount'); return; }`

  All four native dialog calls are present exactly as claimed. The delete at line 386 uses confirm() with no pushUndo/undo flow. The codebase convention (CLAUDE.md) specifies destructive actions use pushUndo (5s deferred-save) not confirm(), and toastError() for inline validation.
- **Reviewer notes**: The finding is accurate and not mitigated elsewhere. The severity is correctly calibrated as Low — it is a UI consistency issue (native dialogs vs. themed toasts/undo) rather than a functional bug. The fix is straightforward: replace the three alert() calls with toastError() and replace the confirm()+immediate-delete with pushUndo (matching the deleteBatch/deleteCatering pattern).

### UIUX-7 — Error toasts are not announced assertively — the single toast region is aria-live="polite", so save-failure messages can be missed by screen readers

- **Severity**: Low
- **Location**: public/index.html:53 (single #toast with role="status" aria-live="polite"), public/js/utils.ts:500-506 (toastError reuses that region)
- **What**: Both toast() and toastError() write to the same #toast element which is hard-coded role="status" aria-live="polite", so error toasts (e.g. 'Save failed') are queued politely rather than interrupting, and have no manual dismiss before the 4s timeout.
- **Why it matters**: Save/transport/competency failures surface only via toastError plus a transient red dot; a screen-reader user or a slow reader can miss that a write failed, which for stock/transport actions can mean silently acting on stale data — the prior audit's U7 about assertive error announcement remains only partially addressed.
- **Suggested fix**: Render error toasts with role="alert" (assertive) — e.g. set the region's role/aria-live dynamically in toastError, or use a second dedicated assertive region — and add a dismiss affordance so errors persist until acknowledged.
- **Confidence**: Medium.
- **Verified**:

  public/index.html:53: `<div class="toast" id="toast" role="status" aria-live="polite"></div>`

  public/js/utils.ts:500-506:
  ```ts
  export function toastError(msg: string): void {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = 'toast error show';
    setTimeout(() => t.className = 'toast', 4000);
  }
  ```

  No `role="alert"` or `aria-live="assertive"` exists anywhere under `public/` — confirmed by grep. `toastError` does not mutate the element's role or aria-live attributes; both `toast()` and `toastError()` write to the same statically declared polite region.
- **Reviewer notes**: The finding is accurate and unmitigated. The single #toast element is hard-coded `role="status" aria-live="polite"`, and `toastError` reuses it without changing these attributes. Error toasts (save failures, transport failures) are therefore announced with polite priority, meaning a screen reader will finish its current speech queue before announcing them. There is no dismiss affordance — the 4-second auto-hide is the only removal mechanism. Severity Low is appropriate: this is a real accessibility gap, but the app is primarily used by kitchen staff in a sighted workflow, so the practical impact is limited.

### UIUX-8 — AI recipe-chat input is a placeholder-only textarea with no associated label

- **Severity**: Nit
- **Location**: public/js/recipe-ai-chat.ts:82-85 (textarea#ai-chat-input with placeholder only)
- **What**: The AI helper composer is a <textarea> whose only accessible name is its placeholder text, with no <label>, aria-label, or aria-labelledby.
- **Why it matters**: Placeholders are not reliable accessible names (they vanish on input and are skipped by some AT), so a screen-reader user focusing the composer hears no field name; impact is small because the panel is director-only and low-traffic.
- **Suggested fix**: Add aria-label="Describe a recipe" (or a visually-hidden <label for="ai-chat-input">) to the textarea.
- **Confidence**: High.
- **Verified**:

  <textarea class="ai-chat-input" id="ai-chat-input"
          placeholder="Describe a recipe… (Ctrl/Cmd+Enter to send)"
          ${isStreaming ? 'disabled' : ''}
          onkeydown="aiRecipeKey(event)"></textarea>
- **Reviewer notes**: The claim is accurate. At public/js/recipe-ai-chat.ts lines 82-85, the textarea has id="ai-chat-input" and a placeholder but no aria-label, aria-labelledby, or associated label element anywhere in the surrounding HTML (lines 75-90 are the full panel template). No mitigation was found. Severity Nit is appropriate: the panel is director-only and low-traffic, so real-world AT impact is minimal, but the fix (add aria-label="Describe a recipe") is trivial.
