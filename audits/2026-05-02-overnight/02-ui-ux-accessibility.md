# UI/UX & Accessibility

## Scope of review

- Markup shell: [public/index.html](public/index.html).
- Styles: every CSS file in [public/css/](public/css/) — `base.css`, `dashboard.css`, `guests.css`, `planner.css`, `orders.css`, `recipes.css`, `recipe-editor.css`, `finance.css`, `feedback.css`, `tutorial.css`, `mobile.css`.
- Frontend renderers (focus on patterns, not exhaustive read of every screen):
  - [public/js/init.ts](public/js/init.ts), [public/js/auth.ts](public/js/auth.ts), [public/js/modal.ts](public/js/modal.ts), [public/js/feedback.ts](public/js/feedback.ts), [public/js/utils.ts](public/js/utils.ts), [public/js/state.ts](public/js/state.ts).
  - Spot reads of [public/js/dashboard.ts](public/js/dashboard.ts), [public/js/dishes.ts](public/js/dishes.ts), [public/js/caterings.ts](public/js/caterings.ts), [public/js/planner.ts](public/js/planner.ts).
- Cross-cutting greps for: ARIA attributes (zero matches in `public/js`), `tabindex` (zero), `alt=""` (one — the avatar img), `<button>` with explicit `type=` (4 of 242 button tags).

I did **not** boot the dev server and run axe-core, NVDA, or a real-device check; everything below is from reading the markup/CSS. UI bugs that only surface at runtime would need a manual pass — flagged in [99-followups.md](99-followups.md).

## Findings

### U1 — Zero ARIA attributes anywhere in the frontend
**PARTIALLY RESOLVED on 2026-05-03 (branch `claude/u1-u3-u4-aria-acfca7`)**: applied the three quick wins from the audit's suggested-fix list. `aria-live="polite" role="status"` on `#toast` (index.html) and `#save-indicator` (init.ts) so screen readers announce save state and toast text. Modal got `role="dialog" aria-modal="true" tabindex="-1"` and a focus shift on open (modal.ts) so it's announced as a dialog and the underlying screen is treated as inert. Verified live in preview. Deferred: `aria-label` on icon-only buttons (top-bar theme toggle, feedback FAB, tutorial FAB) — separate PR.
- **Severity**: High (for accessibility), Medium (for current users)
- **Location**: All of [public/js/](public/js/) and [public/index.html](public/index.html). Confirmed by `grep -rn "aria-\|role=" public/` returning nothing.
- **What**: Every screen is a stack of `<div>`s and `<button>`s with text labels. The bottom nav, top nav, dish grid, planner grid, modal dialogs, and toasts all rely entirely on visual signal (color, position) for state. The toast region is not announced. The modal isn't a `dialog` element and has no `role="dialog"` / `aria-modal`. The save indicator (`<div class="save-dot saved" id="save-dot"></div>` + `<span id="save-text">Saved</span>`) has no `aria-live` so screen readers don't know when "Saving…" → "Save failed" occurs.
- **Why it matters**: One Daan-typed phrase from `DESIGN.md`: "easy to learn, easy to hand over — volunteers and new staff can pick it up quickly." The current shape excludes anyone using a screen reader from doing meaningful work. Even sighted keyboard-only users (e.g. someone with a hand injury) cannot tell the modal is open vs. underlying screen interactive — both are reachable by Tab.
- **Suggested fix**: Three high-leverage additions, in order:
  1. `aria-live="polite"` on `#save-text` and `#toast`. Two attribute changes; instant win.
  2. Convert `showModal()` to use `<dialog>` element with `.showModal()`, or at minimum add `role="dialog"`, `aria-modal="true"`, and a `tabindex="-1"` focus trap. This also fixes finding U6 (focus on modal open).
  3. Add `aria-label` to icon-only buttons. The bottom-nav `<button>`s have a `<span>` label — that's good — but the top-bar theme toggle, feedback FAB, and tutorial FAB are icon-glyph-only.
- **Confidence**: High.

### U2 — `<button>` elements omit `type="button"` (242 occurrences, only 4 set it)
- **Severity**: Medium
- **Location**: Throughout [public/js/](public/js/) — every screen renders buttons inside string templates without `type="button"`. Found 4 with explicit type (mostly `data-testid` button in feedback).
- **What**: When a `<button>` lives inside a `<form>`, the default type is `submit`. The app currently uses very few `<form>` elements (most inputs are bare), so most buttons are safe today. But the `feedback` modal, `cateringDishPicker`, and a handful of other modals use bare `<input>` plus bare `<button>` clusters with no enclosing `<form>` — a future refactor that wraps them in a form for better keyboard handling would silently turn every button into a submit, reloading the page.
- **Why it matters**: This is the kind of latent bug that bites nine months later. Cheap to prevent.
- **Suggested fix**: One sweep: add `type="button"` to every `<button` template literal that doesn't already have it. ESLint can enforce going forward (`react/button-has-type` rule has no React equivalent for vanilla; could be a pre-commit grep).
- **Confidence**: High.

### U3 — Modal pattern doesn't trap focus or restore it
**PARTIALLY RESOLVED on 2026-05-03 (branch `claude/u1-u3-u4-aria-acfca7`)**: modal now gets focus on open (the wrapper has `tabindex="-1"` and `requestAnimationFrame` calls `.focus()` after insertion). `role="dialog"` + `aria-modal="true"` are also set. Deferred: full focus-trap (Tab/Shift+Tab cycle within modal) and focus-restore-on-close to the opener element — those need a heavier refactor of the modal lifecycle and belong in a separate PR.
- **Severity**: High (a11y), Medium (UX)
- **Location**: [public/js/modal.ts:11-24](public/js/modal.ts), [public/js/init.ts:88-96](public/js/init.ts).
- **What**: `showModal()` injects HTML into `#modal-root`. There is no focus trap. Pressing Tab inside an open modal eventually moves focus into the underlying screen (which is still keyboard-active because the modal is just an overlay div, not `inert`). When the modal closes, focus is not restored to the element that opened it — it lands on `<body>`, so the next Tab walks from the start of the page. The only Esc handler is on the `keydown` listener in `init.ts`, which calls `closeModal()` — fine, but doesn't restore focus either.
- **Why it matters**: Keyboard users get lost. Power users who type a stocktake and Tab past the Save button end up scrolling the dish list behind them.
- **Suggested fix**: When showing a modal, capture `document.activeElement` and re-focus it on `closeModal()`. Add a Tab-trap (focus the first focusable element on open, on `keydown` with Tab/Shift+Tab cycle within the modal). Or — single-line fix — convert to native `<dialog>` element, which gets all of this for free in modern browsers.
- **Confidence**: High.

### U4 — `maximum-scale=1.0` in viewport meta blocks pinch-zoom
**RESOLVED on 2026-05-03 (branch `claude/u1-u3-u4-aria-acfca7`)**: dropped `maximum-scale=1.0` from `public/index.html`. Pinch-zoom is no longer blocked. The original justification (preventing iOS auto-zoom on input focus) is best handled at the input-css level (`font-size: 16px` on inputs) — separate PR if/when needed.
- **Severity**: Medium (a11y violation)
- **Location**: [public/index.html:5](public/index.html).
- **What**: `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">`. This blocks the user from pinch-zooming on mobile.
- **Why it matters**: WCAG 1.4.4 (Resize text) — users with low vision rely on zoom to read small text. The mobile layout has 9–11px font in several spots (`.day-hdr` 10px, `.type-lbl` 8px, `.chip-sub` 9px, `.copy-slot-btn` 8px from [planner.css](public/css/planner.css)). Without zoom, those are unreadable for older volunteers.
- **Suggested fix**: Drop `maximum-scale=1.0` (and `user-scalable=no` if it ever appears). This was likely added to prevent iOS auto-zoom on input focus — that can be solved by setting `font-size: 16px` on inputs instead.
- **Confidence**: High.

### U5 — Browser `confirm()` and `alert()` are still used in 8+ places
- **Severity**: Low (UX), Medium (a11y on some platforms)
- **Location**: [public/js/auth.ts:52](public/js/auth.ts), [public/js/caterings.ts:84](public/js/caterings.ts), [public/js/dishes.ts:929,999](public/js/dishes.ts), [public/js/feedback.ts:73](public/js/feedback.ts), [public/js/ingredient-db.ts:613,1416](public/js/ingredient-db.ts), [public/js/menu-fixer.ts:700](public/js/menu-fixer.ts), [public/js/recipes.ts:301,303,307,347,363](public/js/recipes.ts).
- **What**: Native `alert()`/`confirm()` blocks the JS event loop, can't be styled, and on iOS Safari renders without the page's user identity (looks like a "this page says…" warning some users learn to dismiss reflexively). CLAUDE.md explicitly states: "Destructive actions use `pushUndo`, not `confirm()` browser dialog." So the convention exists but isn't enforced for non-destructive validation messages.
- **Why it matters**: Inconsistent. The `pushUndo` toast is a much better pattern — the `alert("Please write something before submitting")` could be replaced with a red `toastError()` (which already exists in `utils.ts`).
- **Suggested fix**: Replace each `alert()` with `toastError()`. Replace each `confirm()` with the existing `pushUndo` 5-second-undo pattern. The two `confirm()` calls in `ingredient-db.ts` (delete ingredient, remove storage area) are the closest fit.
- **Confidence**: High.

### U6 — Focus management on screen change is silent
- **Severity**: Low
- **Location**: [public/js/navigate.ts:53-72](public/js/navigate.ts), [public/js/dashboard.ts](public/js/dashboard.ts).
- **What**: `showScreen()` toggles `.active` classes, calls the renderer, optionally pushes history state. It doesn't focus any element on the newly visible screen and doesn't move screen-reader focus.
- **Why it matters**: A screen reader user doesn't get an announcement when the page changes — they hear silence and have to manually navigate to the new content.
- **Suggested fix**: After the renderer runs, focus the screen's heading (or the screen container with `tabindex="-1"`) so the next "next-heading" gesture lands in the right place. This is also useful for sighted keyboard users — Tab from the bottom-nav button currently lands on the next button, not on the page's first interactive element.
- **Confidence**: High.

### U7 — Toast messages disappear on a fixed timer with no manual dismiss
- **Severity**: Medium (a11y), Low (UX)
- **Location**: [public/js/utils.ts:404-418](public/js/utils.ts), [public/css/base.css:142-147](public/css/base.css).
- **What**: `toast(msg)` shows for 2200ms; `toastError(msg)` for 4000ms. No close button (except on undo toast). No `aria-live`. A user reading slowly, or a screen-reader user navigating to it, can miss the message entirely.
- **Why it matters**: Save errors are surfaced via `toastError`. If the user is mid-typing when the toast fades, they may not know the save failed. The save dot does also turn red, but only for that message — toast goes away.
- **Suggested fix**: Add an `[x]` close button to error toasts; keep them visible until dismissed (or 8s, doubled). Add `role="status"` to success toasts and `role="alert"` to error toasts.
- **Confidence**: Medium — calibrated to UX, not a critical bug.

### U8 — No skeletons or perceived-loading indicators on most screens
- **Severity**: Low
- **Location**: e.g. [public/js/orders.ts](public/js/orders.ts), [public/js/planner.ts](public/js/planner.ts) — most screen renderers run synchronously off `S.*`.
- **What**: Dashboard shows a "Loading dashboard…" placeholder ([public/js/dashboard.ts:386-388](public/js/dashboard.ts:386-388)) — explicitly added per user feedback #429 ("u need loading animation when the dashboard …"). Other screens render directly. When `loadData` is still in flight (e.g. on slow Railway cold start, ~2-3s), the active screen renders with empty `S.batches=[]` and looks identical to "no data."
- **Why it matters**: A user who clicks Planner during initial load sees an empty week and might assume their week was deleted. The data error banner ([public/js/utils.ts:244-256](public/js/utils.ts:244-256)) only shows after the request *fails*. There's no signal during a slow but successful load.
- **Suggested fix**: Add the same skeleton pattern Daan used on dashboard to the other big screens. Or: in `loadData()`, set a global `S.loading = true`, and have screen renderers check it. The `setSaveState('saved')` already runs on every successful load — could pivot it to also expose a "first-load" signal.
- **Confidence**: Medium.

### U9 — Form validation messages are inconsistent (some inline, some alert, some silent)
- **Severity**: Medium
- **Location**: [public/js/recipes.ts:301-365](public/js/recipes.ts) (alert), [public/js/caterings.ts:84](public/js/caterings.ts) (alert), [public/js/dishes.ts:929](public/js/dishes.ts) (alert), [public/js/recipe-editor.ts](public/js/recipe-editor.ts) (mix).
- **What**: New-recipe form: invalid URL → alert. New-catering form: missing name → alert. Backend validation errors → toast with raw server message ("invalid recipe: invalid name") — useful for devs, baffling for the kitchen team. Recipe editor: silent if you forget the volume field — the cost just shows blank.
- **Why it matters**: The user has to guess what was wrong. CLAUDE.md says "Form validation: does it tell users what's wrong, in plain language?" — by the audit prompt's own bar, this is below it.
- **Suggested fix**: Standardise on inline-below-the-field validation with plain-language messages ("Please add a name for this catering"). Two-line component pattern that screen-by-screen renderers can adopt incrementally.
- **Confidence**: High.

### U10 — Color contrast: low-contrast `var(--text3)` and `#888` are widespread
- **Severity**: Medium (a11y)
- **Location**: `--text3: #a0a09a` ([public/css/base.css:9](public/css/base.css)) used for chip subtext, "showing first 100 of N", filter pill labels, etc. Hard-coded `#888` in [public/js/finance.ts:413,433](public/js/finance.ts).
- **What**: `#a0a09a` on `#ffffff` background = contrast ratio ~2.4:1. WCAG AA requires 4.5:1 for normal text. `#888` on white = ~3.5:1 — also fails. Dark mode is `--text3:#6b6b66` on `#1c1c1a` = ~3.0:1, also fails.
- **Why it matters**: Affects every "secondary metadata" text (date labels, screen names in feedback, "X of Y" counters). Older volunteers, anyone with mild vision issues, anyone using a low-quality phone screen in sunlight.
- **Suggested fix**: Bump `--text3` to `#7a7a72` (light) and `#909088` (dark) — both clear 4.5:1. Replace the hardcoded `#888` in `finance.ts` with `var(--text3)`.
- **Confidence**: High — contrast ratios are math.

### U11 — Mobile font sizes drop below readable thresholds
- **Severity**: Medium (a11y)
- **Location**: [public/css/mobile.css](public/css/mobile.css) — `.type-lbl` 8px, `.copy-slot-btn` 8px, `.chip-sub` 9px, `.day-hdr` 10px, `.add-slot-btn` 9px, `.copy-day-btn` 8px in `planner.css`. Mobile sets `.dish-chip` 10px.
- **What**: Apple HIG and Google Material both recommend 11–13px minimum for body, 9–10px for caption with high contrast. 8px text is unreadable on a phone for most adults.
- **Why it matters**: The week planner is the primary mobile surface — if it's unusable on a phone the kitchen team won't use the app there. CLAUDE.md acknowledges the mobile overhaul; this is a regression risk to keep an eye on.
- **Suggested fix**: Lift everything below 10px to at least 10px, and add a soft-target of 11px for text the user *reads* (vs labels they recognise visually). The week-grid is dense; trade off horizontal scroll vs. truncation. If you keep 8px copy-slot labels, they should at least have a `title=` attribute for hover.
- **Confidence**: High.

### U12 — Dashboard "Loading dashboard…" placeholder is the only example of the right pattern
- **Severity**: Low (positive comment with caveat)
- **Location**: [public/js/dashboard.ts:381-388](public/js/dashboard.ts).
- **What**: One inline comment notes "(user feedback #429 — u need loading animation when the dashboard …)". The dashboard correctly shows a placeholder until `loadPrepChecklist` resolves.
- **Why it matters**: This is the right pattern; see U8. Worth noting that the team already has a worked example to copy.
- **Suggested fix**: Promote it to a shared helper (`showLoadingPlaceholder(screenId, message)`) and add it to planner / orders / finance.
- **Confidence**: High.

### U13 — `inputmode` and `autocomplete` are missing on numeric inputs
- **Severity**: Low (mobile UX)
- **Location**: All numeric `<input type="number">` in stocktake, guest counts, batch stock fields. Verified on `.gt-input` ([public/css/guests.css](public/css/guests.css)) and `.inv-stock-input` ([public/css/planner.css](public/css/planner.css)).
- **What**: `<input type="number">` without `inputmode="decimal"` makes mobile keyboards show the QWERTY layout with a number row in some Android setups, instead of the dedicated decimal keypad. Some inputs carry `step="0.5"` — they need `inputmode="decimal"` to surface the decimal point on iOS.
- **Why it matters**: Stocktake on a phone is friction-heavy already; one extra tap per number adds up across 80 ingredients.
- **Suggested fix**: Add `inputmode="decimal"` to every `<input type="number" step="0.x">`. Add `inputmode="numeric"` to integer counts (guests, batches). Five minutes of grep+replace.
- **Confidence**: High.

### U14 — Hard-coded inline colors bypass dark mode
- **Severity**: Low
- **Location**: [public/js/dishes.ts:99-102](public/js/dishes.ts) (legend dots: `#BA7517`, `#0F6E56`, `#97C459`, `#EF9F27`), [public/js/finance.ts:413,433](public/js/finance.ts) (`#888`), [public/css/planner.css:74-75](public/css/planner.css) (`.dish-row.frozen-row` background `#E8F4FD`, but the dark variant is on the next line — fine), [public/css/planner.css:77-80](public/css/planner.css) (logistics row borders).
- **What**: The legend dots in `dishes.ts` use the *light-mode* hex codes literally. In dark mode, the dots stay vivid orange/green but the rest of the row uses CSS-variable colors that have shifted — so the legend doesn't match the actual chip colors.
- **Why it matters**: Visual disconnect, mostly cosmetic. Worse for the new colourblind volunteer who picks up the legend in dark mode.
- **Suggested fix**: Replace the inline `background:#BA7517` with `background:var(--amber)` etc. The CSS variables exist for exactly this; the strings just need to use them.
- **Confidence**: High.

### U15 — Wheel-blur on number inputs is good, but it's silent
- **Severity**: Low (Nit)
- **Location**: [public/js/init.ts:99-104](public/js/init.ts).
- **What**: A global `wheel` listener blurs any focused number input. This prevents accidental scroll-to-change-value, which is a real footgun for stocktake.
- **Why it matters**: This is good defensive UX. But it's silent — the user wouldn't know "wait, my number didn't change because I scrolled" was a concern.
- **Suggested fix**: No action needed; mention in dev docs as an example of the kind of subtle UX work to keep doing.
- **Confidence**: High.

### U16 — Login screen shows full Google branding, but error messaging is bare
- **Severity**: Low
- **Location**: [public/index.html:24-32](public/index.html), [public/js/auth.ts:18-39](public/js/auth.ts).
- **What**: On login failure (`!res.ok`), the error element gets `data.message || data.error || 'Login failed'`. The backend returns Dutch on the `not_allowed` path ("Je account heeft geen toegang. Vraag je teamleider om je e-mail toe te voegen."), but English on bad-token ("Invalid token"). Inconsistency.
- **Why it matters**: Mixed-language app. Most kitchen-team UI text in `dishes.ts`/`planner.ts`/`feedback.ts` is English. The 401 message is the only Dutch surface I noticed.
- **Suggested fix**: Pick one. Probably English to match the rest of the UI, or all-Dutch with a defaults fallback. CLAUDE.md is silent on language; worth a project-level decision.
- **Confidence**: High.

### U17 — `<dialog>`-level keyboard support: Esc closes modal, but only one place
- **Severity**: Low
- **Location**: [public/js/init.ts:88-96](public/js/init.ts).
- **What**: One global Esc listener handles both "cancel assign mode" and "close modal." Order: cancel-assign first, modal close second. If both are open simultaneously (assign mode + a child modal), Esc cancels the assign mode but doesn't close the modal — needs a second Esc.
- **Why it matters**: Mostly fine. Worth noting in dev docs.
- **Suggested fix**: No action.
- **Confidence**: Medium.

## Patterns & themes

- **The visual design is genuinely good for what it is** — color-coded by location, tight typography, distinct dark mode, sensible 8px spacing scale. CSS variables are well-curated. The week-planner color system (per-type chips + per-location row borders + transit overlays) communicates a lot of state without text.
- **Accessibility was clearly not a project goal**. Zero ARIA, no focus management, no labelled regions. This is a defensible trade-off for a small-team internal tool, but worth being explicit about. If the app moves toward "open everything" per `DESIGN.md`'s vision, this becomes a hard-stop for public release.
- **Mobile-first feels real**. The mobile.css file is comprehensive (202 LOC), with thoughtful tweaks like "stocktake save bar above bottom nav" and "feedback FAB 68px above the bottom nav." The patterns suggest the team uses mobile in production.
- **Inline `style="…"` is everywhere**. Adds bytes; makes selector overrides hard; means dark-mode colors that aren't in CSS files (per U14) won't follow theme. Also weakens CSP options if you ever add one (style-src 'self' breaks; you'd need 'unsafe-inline').
- **Form patterns are bespoke per modal**. `caterings.ts` and `feedback.ts` and `recipes.ts` each have their own validation rituals. A shared "form module" with `requireField('id', 'message')` would harmonise the alert/toast/inline split called out in U9.

## What looked good

- **CSS variable system is clean** — light/dark, semantic naming (`--green` not `--success` is a fair call for a food app), consistent spacing.
- **Save indicator is the right idea** — single dot + label, color-coded, persistent. The pulse animation while saving is a small touch that communicates well.
- **Bottom nav respects `env(safe-area-inset-bottom)`** ([public/css/mobile.css:129](public/css/mobile.css)). That's iPhone notch-aware UX that most internal apps skip.
- **The undo toast pattern is genuinely good** — it's almost the platonic form of "destructive action without confirmation friction." Worth referencing in any product-design talk.
- **Dashboard "Loading…" placeholder** (U12) shows the team responds to user feedback in idiom-correct ways — not an alert, not a full-page spinner, an in-context skeleton.
- **Wheel-blur on number inputs** (U15). Specific, defensive, signals care about the actual workflow.
- **Tutorial overlay system exists** (`public/js/tutorial.ts`, `public/css/tutorial.css`) — guided onboarding is rare in internal tools.
- **Sub-tab scroll-hint gradient** (`mobile.css:184-191`) — a single decorative gradient as a UX affordance that overflow exists. Tasteful.
- **Two-tap flows for destructive actions are protected by `pushUndo`** — see CLAUDE.md "Destructive actions use pushUndo, not confirm() browser dialog." Where it's followed, the UX is clearly better than the alternative.

---

## Round 2 — deeper findings (added after end-to-end reads of the seven > 1000 LOC frontend modules)

### U18 — `prompt('Version notes:')` is the third native dialog beyond `alert`/`confirm`
- **Severity**: Low (UX)
- **Location**: [public/js/recipe-editor.ts:988](public/js/recipe-editor.ts).
- **What**: The "Save version" button on the recipe detail modal calls `const notes = prompt('Version notes (optional):') ?? '';`. Same anti-pattern category as U5 — native browser dialog, blocks the page, can't be themed, on iOS gets dismissed reflexively as "this page is asking…"
- **Why it matters**: One more place a custom in-page input would be more accessible. Same fix template as U5.
- **Suggested fix**: Replace with a small modal containing a labelled `<textarea>` and Save/Cancel.
- **Confidence**: High.

### U19 — "No recipes in index yet. Add some in the Recipes tab" — but they're already there
- **Severity**: Medium (misleading error)
- **Location**: [public/js/dishes.ts:955](public/js/dishes.ts).
- **What**: Empty-state of the new-batch modal's recipe search reads "No recipes in index yet. Add some in the Recipes tab." This is shown whenever `S.recipeIndex.length === 0`, which is *always* (per A5/A17). A user who has 50 v2 recipes sees this message and is told to add some — they'd reasonably try the Recipes tab, see all their recipes there, and conclude the app is buggy.
- **Why it matters**: Confidence-eroding. The "+ New batch" button is the most discoverable action; its first prompt lies to the user.
- **Suggested fix**: Fix A17 and the message becomes correct ("No recipes match your search"). Or, if A17 takes longer, change the empty-state to be neutral: "No recipes available — create one from the Recipes tab."
- **Confidence**: High.

### U20 — Recipe editor has no unsaved-changes warning on Cancel/close
- **Severity**: Medium
- **Location**: [public/js/recipe-editor.ts:524-525](public/js/recipe-editor.ts), [public/js/init.ts:124-131](public/js/init.ts).
- **What**: The recipe editor maintains its own internal `ed` state (45 fields including all ingredients and prep steps). Closing the modal — via Cancel button, Esc key, or backdrop click — discards the entire draft with no confirmation. The global `beforeunload` guard ([public/js/init.ts:127](public/js/init.ts)) only fires on real page unload, not on modal close. The recipe editor also doesn't call `setSaveState('unsaved')` on edits, so the save-indicator dot stays green during a long editing session.
- **Why it matters**: The recipe editor is one of the longest-form workflows (multi-step, dozens of fields). Accidental close = silent loss of 5-15 minutes of work.
- **Suggested fix**: Track a `dirty` flag; on close, if dirty and no save, show a "Discard changes?" confirmation. Or: persist draft to localStorage every change so an accidental close can be recovered.
- **Confidence**: High.

### U21 — `updateIngredientSearch` re-renders the entire Orders screen on every keystroke
- **Severity**: Medium (perf-felt-as-UX)
- **Location**: [public/js/ingredient-db.ts:42-51](public/js/ingredient-db.ts).
- **What**: The search input handler calls `renderOrders()` on every input event. `renderOrders` rebuilds the entire screen including the tab bar, then `renderIngredientDbTab` rebuilds the entire ingredient table (paginated to 50 rows but still substantial HTML). Then a `requestAnimationFrame` re-finds the input by id and restores `selectionStart`. This is the pattern CLAUDE.md explicitly warns against: "Search/Filter Input Rule — never replace the input's own DOM element."
- **Why it matters**: With ~2100 ingredients in DB, the filter pass + sort + HTML construction happens on every keystroke. On mobile, typing "tomato" triggers 6 full re-renders. Visible lag.
- **Suggested fix**: Apply the split-container pattern from CLAUDE.md: render the search input once at parent scope; only update `#ingredient-db-results` content. Same shape as `recipes.ts` `renderRecipeIndex` + `updateRecipeResults`.
- **Confidence**: High.

### U22 — Stocktake save bar uses two equally-prominent green/orange buttons
- **Severity**: Low (UX)
- **Location**: [public/js/orders.ts:1852-1855](public/js/orders.ts).
- **What**: `<button style="background:var(--green);">Save & next area →</button> <button style="background:var(--orange);">Save & stop stocktake</button>` — both buttons full-width, both equally vibrant. A tired cook might tap "Save & stop" thinking it's the next area button. There's no visual hierarchy.
- **Why it matters**: Stocktake is repetitive. Misclicking exits the flow and the user has to re-navigate back, find their place, etc.
- **Suggested fix**: Make "Save & next" the primary (full color), "Save & stop" secondary (outline/text). Or put "Stop" in a less prominent position (header X button, separate row).
- **Confidence**: Medium.

### U23 — Drag start highlights ALL slots site-wide, including past/served slots
- **Severity**: Low (UX)
- **Location**: [public/js/planner.ts:284-292](public/js/planner.ts).
- **What**: `batchDragStart` does `document.querySelectorAll('.slot').forEach(s => s.classList.add('slot-assign-target'))`. Past slots and served slots also get the highlight, even though dropping there does nothing useful (the batch services array gets a service for a past date, which `isServicePast` immediately marks as already-served). Mostly harmless but adds visual noise during drag.
- **Why it matters**: Cosmetic; can confuse users into thinking they can plan into the past.
- **Suggested fix**: Filter the querySelectorAll to non-past slots: `:not(.past-slot)`.
- **Confidence**: High.

### U24 — Batch toggle row in Orders tab reads from `localStorage` but writes to server-only via `persistBatchOrderFor`
- **Severity**: Low
- **Location**: [public/js/orders.ts:594-616](public/js/orders.ts).
- **What**: `ensureBatchTogglesInitialized` initializes `batchIngredientToggles` from each batch's `orderFor` field (server state). `toggleBatchIngredient` calls `persistBatchOrderFor` which PATCHes the batch. So the toggle is server-backed (good). But the `batchIngredientTogglesInitialized` boolean is module-level — when a SSE patch arrives and changes `batch.orderFor` for one batch, the entire toggle map is reset (`resetBatchToggles()` is called from `setOnBatchesChanged` in main.ts). Re-init reads ALL batch.orderFor values fresh, which is correct, but the UI doesn't visually flash through this.
- **Why it matters**: Edge case. Fine today.
- **Suggested fix**: None.
- **Confidence**: Medium.
