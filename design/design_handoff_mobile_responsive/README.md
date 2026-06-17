# Handoff: FairPlay Mobile Responsiveness

## Overview
This package specifies a **mobile (phone) experience for FairPlay**. The core design move:
**strip the desktop's bespoke card art** (car schematic, home blueprint, inventory
supply-grid, date-night calendar) and render **every card as a single, time-grouped task
list** with a fast add flow and swipe-to-complete. The goal is to make the app genuinely
usable on a ~390–402px wide screen, which the current fixed three-column desktop frame
cannot do (see the project's `design/MOBILE-HANDOFF.md`).

This is the **mobile layout** for the existing app — not a new product. Themes, tokens,
typography, copy voice, and the clean-cyberpunk / Marathon-terminal aesthetic are all
preserved from the desktop. Only layout, navigation, and the per-card body change.

## About the Design Files
The files in `prototype/` are **design references built in HTML/React+Babel** — a runnable
prototype that demonstrates the intended look and behavior. **They are not production code
to copy.** Your task is to **recreate these designs inside the real FairPlay codebase**
(React + Vite + TypeScript, plain CSS with semantic custom-property tokens — no Tailwind, no
CSS-in-JS) using its established patterns, and against the files called out in the existing
`design/MOBILE-HANDOFF.md`.

To view the prototype: open `prototype/FairPlay Mobile.html` in a browser. It renders inside
a simulated iPhone frame. A floating **Tweaks** panel (bottom-right, toggle via the toolbar
in the original tool; in a plain browser it is hidden) was used during design to compare
options — **the chosen, final configuration is documented below; ignore the unused tweak
branches** (`nav: tabs`/`grid`, `addModel: inline`/`header`). They remain in the code only
as exploration history.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, and interactions. Recreate
pixel-accurately using the codebase's existing token system. All values are tokenized —
**never hardcode a hex; reference a CSS custom property** (or add a token if one is truly
missing), exactly as the desktop does.

---

## The chosen configuration (build this)
The prototype can express several options; **the decided design is:**

- **Navigation: Drawer.** A slide-out left drawer holds the full categorized card list plus
  Inbox / Done / Me links. There is **no bottom tab bar** and no persistent left rail.
- **Add a task: Floating Action Button (FAB) → bottom sheet.** A diamond FAB sits bottom-
  right on task screens; tapping it opens an add-task bottom sheet.
- **Complete a task: swipe only.** Swiping a task row left reveals a "DONE" action and
  completes it. **There are no checkboxes anywhere** — completion and reopen are swipe-only.
- **Owner (Amy/Kyle) toggle: scrolls with content.** It is the first element inside each
  screen's scroll area, NOT pinned — it scrolls off the top as you scroll. (Rationale: the
  default user rarely switches; the partner flips it ~once per session.)
- **Default theme: Vapor** (cool dark). Bone (light) and Eclipse (warm dark) must also work —
  layout is identical across themes; only token values differ.

---

## Global shell / chrome

### Fixed top bar (`.m-top`)
- Always visible, does NOT scroll. Sits above the scroll area.
- Top padding **56px** to clear the status bar / notch (device safe-area).
- Single row, height **30px**, horizontal padding **18px**:
  - **Hamburger** button (left) — opens the drawer. 34×34px, 1px `--line` border,
    `--ink-2` glyph. (Icon: 3 stacked lines, last shorter.)
  - **Brand**: 15×15px accent diamond (`clip-path: polygon(50% 0,100% 50%,50% 100%,0 50%)`,
    fill `--accent`) + "FAIRPLAY" 13px/700, letter-spacing .05em.
  - Spacer (flex:1).
  - **Bell** button (right) — opens the Done screen. 34×34px, same styling as hamburger.

### Owner toggle (`.m-owner`, wrapped in `.m-ownerbar`)
- Rendered as the **first child of the scroll area on every screen** (so it scrolls away).
- Wrapper padding: `14px 18px 4px`.
- Two equal segments (Amy | Kyle), 1px `--line` border around the pair, 1px divider between.
- Each segment: height **40px**, centered, gap 9px → `[avatar] [name] [count]`.
  - Avatar: 20px circle, JetBrains Mono 10px/600 initial. Inactive `--surface-2`/`--ink-2`;
    active `--accent`/`--accent-ink`.
  - Name: 13px/500.
  - Count: JetBrains Mono 10px, `--ink-4` (the person's open-task count).
  - **Active segment**: background `--ink`, text `--bg`.
- Switching owner re-filters every list to that person's tasks (see State).

### Scroll area (`.m-scroll`)
- `flex:1; overflow-y:auto`. Hide scrollbars. Content padding `16px 18px`, with
  bottom padding **120px** (`.m-pad-b`) so the FAB and content clear the home indicator.

### Drawer (`.m-drawer`)
- Off-canvas left panel, **82% width, max 320px**, `transform: translateX(-100%)` → `0` when
  open, transition `.26s cubic-bezier(.2,.8,.25,1)`. Background `--surface`, right border
  1px `--line`.
- A full-screen backdrop (`rgba(0,0,0,.45)`, fade `.22s`) sits behind it; tap to close.
- Drawer header (padding-top 58px for safe-area): brand + a close (✕) button.
- Scrolling body:
  - Top links: **Inbox** (with the active owner's open count), **Done**, **Me** — each a
    46px row with leading icon; active row gets `--surface-2` bg + 2px `--accent` left border.
  - Then the card list grouped by category (`HOME`, `OUT`, `CAREGIVING`, `MAGIC`): a mono
    9px uppercase category label, then card rows `[## number] [name] [due-count]`. Cards with
    due>0 show the count in `--accent`; otherwise a `·` in `--ink-3`. Tapping a card opens
    its detail and closes the drawer.

### FAB (`.m-fab`)
- Shown only on task screens (Inbox and Card detail). Bottom-right, **bottom: 40px**
  (no tab bar), 56×56px, accent diamond clip-path, `--accent` fill, `--accent-ink` plus
  glyph, shadow `0 8px 24px rgba(0,0,0,.35)`. `:active` scales to .94.
- Opens the add-task sheet. On a card screen it pre-fills that card; on Inbox it opens with
  a card picker.

---

## Screens / Views

### 1. Inbox (landing / triage)
- **Purpose:** "What needs attention" across all of the active person's cards.
- **Header** (`.m-head`, padding `16px 18px 6px`):
  - Kicker: mono 9.5px `--ink-3`, a 14×2px `--accent` tick + `TRIAGE · TUE JUN 9`.
  - Title: **26px/700**, letter-spacing −.02em, "Needs attention".
  - Sub: 12.5px `--ink-2`, e.g. `13 open for Amy · ` + **`1 overdue`** (the overdue count in
    `--accent`/600).
- **Body:** tasks for the active owner whose bucket ∈ {overdue, today, week}, grouped by
  bucket in that order. Each group: a divider then its `TaskRow`s. A trailing **DONE** group
  lists tasks completed this session (struck through, swipe to reopen).

### 2. Card list ("My Cards") — reached from the drawer
- **Purpose:** browse/search all 30 cards. (In the drawer-nav design the drawer is the
  primary card list; this full screen is the "see all / search" view.)
- Header kicker `30 CARDS`, title "My Cards".
- A search field (`.m-search`, 42px, `--surface-2` bg, mono 12px input, placeholder
  uppercased `--ink-3`).
- Cards grouped by category. Each row (`.m-cardrow`, min-height 52px):
  `[## mono number, --ink-4] [name 15px/500] [due-count] [chevron]`. due>0 → count in
  `--accent`/600, else `·`. Tap → card detail.

### 3. Card detail
- **Purpose:** one card's tasks as a time-grouped list. **No bespoke art** — Auto, Home,
  Inventory, Date Night, etc. all use this same list.
- Header: a mono "‹ CARDS" back affordance (11px, `--ink-3`), kicker `CARD · <CATEGORY>`,
  title = card name (26px/700), sub `N open for <Person>`.
- Body: that card's tasks for the active owner, grouped **Overdue / Today / This week /
  Later**, plus a trailing **DONE** group for session-completed items.
- FAB pre-fills this card.

### 4. Done
- **Purpose:** recently completed work for the active person.
- Header kicker `COMPLETED`, title "Done", sub `N closed by <Person> recently`.
- Rows grouped by `JUST NOW` (session) / `TODAY` / `THIS WEEK`. Each row shows the task name
  **struck through + dimmed** (`--ink-3`, line-through in `--ink-4`), a card tag, and a
  timestamp on the right. No checkbox.

### 5. Me (settings)
- **Profile:** 52px accent circle with initial + name (18px/700) + `SHARED DECK · 2 MEMBERS`.
- **Viewing as:** Amy/Kyle segmented control (mirrors the owner toggle).
- **Appearance:** Theme (Bone/Eclipse/Vapor segmented), Density (compact/comfy), Background
  grid (toggle).
- **Notifications:** Overdue reminders, Daily digest, Partner hand-offs — labeled rows with
  iOS-style switches (`.m-toggle-sw`, 46×27px, `--accent` when on).

---

## The Task Row (the most important component)
File reference: `prototype/mobile-parts.jsx` → `TaskRow`; styles `.m-task*` in
`prototype/mobile-theme.css`.

**Structure** (no checkbox):
```
.m-task-wrap   (position:relative; overflow:hidden; border-bottom:1px solid --line-2)
 ├─ .m-task-behind   (the swipe-reveal action, sits underneath)
 └─ .m-task          (the foreground row, translateX on drag)
     ├─ .m-tbody     (flex:1)
     │   ├─ .m-tname (15px/500, line-height 1.25)
     │   └─ .m-tmeta (row, gap 10px, margin-top 6px, wraps)
     │        ├─ .m-tag    (optional card tag: 7px color swatch + mono 9.5px uppercase name)
     │        └─ .m-recur  (mono 9.5px --accent-2, e.g. "⟳ WEEKLY")
     └─ .m-trail     (right-aligned due: mono 11px --ink-2; .over → --accent)
```
- Row vertical padding: **14px** default, **11px** at `data-density="compact"` (mobile
  default), **18px** at `comfy`.
- The card tag (`.m-tag`) appears in the **Inbox** (and Done) where cards are mixed; it is
  **hidden in Card detail** (redundant there).
- Overdue/urgent rows: the due text turns `--accent`. (No left checkbox to color anymore.)

**Swipe-to-complete behavior:**
- Pointer events on `.m-task`. On `pointerdown` record start X/Y and row width.
- Decide axis after 6px of movement: if |dx| > |dy| it's a horizontal swipe (capture the
  pointer); otherwise let the page scroll vertically (`touch-action: pan-y`).
- During a horizontal swipe, translate the row by dx. Wrong-direction (rightward) drag is
  rubber-banded to 25% of dx. Clamp left at −rowWidth.
- The `.m-task-behind` layer is revealed underneath: a full-bleed bar, background `--ok`
  (a per-theme success color = each theme's `--accent-2`), text `--bg`, right-aligned,
  reading **"DONE"** (or **"REOPEN"** if the row is already done) + a check glyph.
- On release: if the row was dragged past the **threshold of 96px**, animate it fully out
  (`.settle` transition `transform .22s cubic-bezier(.2,.7,.3,1)`), then call `onToggle`
  (flip done state) and reset transform. Otherwise spring back to 0.
- Completed tasks leave their time group and appear in the **DONE** group (struck through);
  swiping a done row reopens it.

> Implementation note for production: on real touch devices prefer Pointer Events with
> `touch-action: pan-y` (as here) and `setPointerCapture`. Keep the 96px threshold and the
> rubber-band feel. Ensure the gesture doesn't fight the drawer's edge-swipe — the drawer is
> opened by the hamburger, not an edge swipe, so there's no conflict.

---

## Add-task bottom sheet (`.m-sheet`)
File reference: `prototype/mobile-parts.jsx` → `AddSheet`.
- Slides up from the bottom (`transform: translateY(100%)` → `0`, `.26s
  cubic-bezier(.2,.8,.25,1)`), max-height 86%, background `--surface`, top border `--line`,
  bottom padding 34px (safe-area). Same dimmed backdrop as the drawer; tap to dismiss.
- Grab handle (38×4px `--ink-4`), header `New task` (18px/700) + a mono `CLOSE`.
- Fields:
  - **Task name** — 48px text input (`.m-input`, `--surface-2` bg, 16px text — 16px avoids
    iOS zoom-on-focus). Enter submits.
  - **Card** — chip row (only when not pre-filled by a card screen). Each chip shows the
    card's color swatch; selected chip uses an `--accent`-tinted style.
  - **Owner** — Amy / Kyle chips (defaults to the active owner).
  - **When** — Today / This week / Later chips → sets the task's bucket.
  - **Repeat** — Once / Daily / Weekly / Monthly chips (selected uses `--accent-2` tint).
  - **Add task** button — full-width 52px, `--accent` bg, disabled until a name is entered.

---

## Interactions & Behavior
- **Drawer open/close:** hamburger opens; backdrop tap or ✕ closes. `.26s` slide.
- **Navigation:** drawer links set the route (inbox/done/me) or open a card; selecting always
  closes the drawer. Card detail "‹ CARDS" returns to Inbox (drawer-nav home).
- **Owner switch:** instantly re-filters every list and recomputes counts.
- **Swipe-to-complete:** as specified above (threshold 96px).
- **Add task:** FAB → sheet → fills the chosen card/owner/bucket; the new task appears
  immediately in the relevant list.
- **Responsive:** the prototype targets ~390–402px. In the real app, introduce a phone
  breakpoint (the existing handoff suggests `max-width: 480px` phone / `max-width: 768px`
  tablet) and gate all of the above behind it; desktop keeps its current three-column frame.
- **Reduced motion:** honor `prefers-reduced-motion` — disable the slide/spring transitions,
  keep instant state changes.
- **Touch targets:** every interactive element ≥ 44px (FAB 56, toggle segments 40 — bump to
  44 in production, drawer rows 46, sheet input 48, sheet button 52).

## State Management
State needed (the prototype holds these in React; map to the app's real store/hooks):
- `owner: "amy" | "kyle"` — active person; filters all task queries.
- `done: Set<taskId>` — session completions (production: persist to the real task store /
  Todoist sync layer described in `src/lib/todoist/*`).
- `route: { kind: "inbox"|"cards"|"card"|"done"|"me", card?: string }`.
- `drawerOpen: boolean`.
- `sheet: { open: boolean, card: string|null }`.
- Newly added tasks (prototype keeps an `extra[]` array merged into the dataset; production:
  create through the real task API).
- **Task model** used throughout: `{ id, card, name, owner, bucket, due, recur }` where
  `bucket ∈ {overdue, today, week, later}`. Inbox shows buckets {overdue, today, week};
  card detail shows all four. See `prototype/mobile-data.jsx` for the full sample dataset,
  the category order, and the query helpers (`tasksForCard`, `inboxTasks`, `cardDue`).

## Design Tokens
Identical to the desktop token system (`src/styles/theme.css`); set per theme on the root
via `[data-theme]`. **Accent is overridable** at runtime via an inline `--accent` /
`--accent-d` CSS var (the prototype's gold accent example is `#E0A23A`).

**Vapor (default, cool dark):** `--bg:#0F0F17` `--surface:#171723` `--surface-2:#1E1E2D`
`--surface-3:#262638` `--ink:#E9E7F4` `--ink-2:rgba(233,231,244,.60)`
`--ink-3:rgba(233,231,244,.38)` `--ink-4:rgba(233,231,244,.20)`
`--line:rgba(233,231,244,.14)` `--line-2:rgba(233,231,244,.07)` `--accent:#FF3D8B`
`--accent-d:#FF6BA6` `--accent-ink:#140810` `--accent-2:#2FD8D8` `--grid:rgba(233,231,244,.05)`.

**Bone (light):** `--bg:#E7E2D6` `--surface:#EFEBE1` `--surface-2:#DDD7C8`
`--surface-3:#D1CAB8` `--ink:#1A1812` `--ink-2:rgba(26,24,18,.60)`
`--ink-3:rgba(26,24,18,.36)` `--ink-4:rgba(26,24,18,.20)` `--line:rgba(26,24,18,.16)`
`--line-2:rgba(26,24,18,.09)` `--accent:#EE3D17` `--accent-d:#C32E0E` `--accent-ink:#FCF7EE`
`--accent-2:#0C857C` `--grid:rgba(26,24,18,.05)`.

**Eclipse (warm dark):** `--bg:#131210` `--surface:#1C1A16` `--surface-2:#24211B`
`--surface-3:#2D2920` `--ink:#ECE6D8` `--ink-2:rgba(236,230,216,.60)`
`--ink-3:rgba(236,230,216,.38)` `--ink-4:rgba(236,230,216,.20)` `--line:rgba(236,230,216,.14)`
`--line-2:rgba(236,230,216,.07)` `--accent:#FF5A33` `--accent-d:#FF7A5A` `--accent-ink:#140C08`
`--accent-2:#29C2B3` `--grid:rgba(236,230,216,.045)`.

`--ok` (swipe-complete bar) = each theme's `--accent-2`.

**Typography:** Space Grotesk (UI text, weights 400/500/600/700) + JetBrains Mono
(micro-labels, numbers, mono accents). Already bundled in the app.
Key sizes: screen title 26/700; task name 15/500; section/group label mono 9.5px uppercase
(.14em tracking); micro-labels mono 9–10px; sub text 12.5px.

**Background grid:** a faint two-axis line grid (`--grid`) at **30px** tile size on the app
background; toggleable (off → no `background-image`).

**Spacing/layout constants:** screen content padding 16/18px; top-bar top-pad 56px (safe-
area); scroll bottom-pad 120px; drawer 82%/max 320px; FAB 56px @ bottom 40px; swipe
threshold 96px; primary slide transitions `.26s cubic-bezier(.2,.8,.25,1)`; row settle
`.22s cubic-bezier(.2,.7,.3,1)`.

## Assets
No image assets. All glyphs are inline SVGs (hamburger, bell, search, chevrons, plus, check,
person, etc.) — see the `Ic` object in `prototype/mobile-parts.jsx`. The brand mark and FAB
are CSS `clip-path` diamonds, not images. Fonts are already in the codebase.

## Files
In this bundle (`prototype/`):
- `FairPlay Mobile.html` — entry; mounts the app, owns top-level state, the Tweaks panel, and
  the chosen-config wiring. The `/*EDITMODE-BEGIN*/…/*EDITMODE-END*/` block holds the chosen
  defaults (`nav:"drawer"`, `addModel:"fab"`, `theme:"Vapor"`, etc.).
- `mobile-theme.css` — all tokens + every mobile layout primitive (the `.m-*` classes).
- `mobile-data.jsx` — sample cards, the task model, owners/buckets, and query helpers.
- `mobile-parts.jsx` — shared atoms: icons, owner toggle, **swipeable TaskRow**, drawer,
  FAB, add-task sheet, group divider.
- `mobile-screens.jsx` — the five screens (Inbox, Card list, Card detail, Done, Settings).
- `ios-frame.jsx`, `tweaks-panel.jsx` — prototyping scaffolds only; **do not port** (the
  device frame and the design-time tweak panel are not part of the app).

### Target-codebase files to change (from the existing `design/MOBILE-HANDOFF.md`)
- `src/styles/theme.css` — add the phone breakpoint; replace the `position:fixed` three-
  column shell with a scrollable, sticky-top-bar layout.
- `src/App.tsx` — mobile shell structure: sticky top bar, drawer, FAB, sheet, routing.
- `src/shell/Rail.tsx` — becomes the **drawer** card list on mobile.
- `src/shell/TopBar.tsx` — collapse to the mobile top bar; move the Amy/Kyle toggle into the
  scroll area (not pinned).
- `src/shell/atoms.tsx` — `TaskRow`: remove the checkbox, add **swipe-to-complete**; this is
  the highest-payoff change (renders on nearly every screen).
- `src/shell/QuickAdd.tsx` — reshape into the **bottom sheet** triggered by the FAB.
- The per-card `src/cards/*/View.tsx` + their CSS — on the phone breakpoint, **bypass the
  bespoke art** and render the shared time-grouped task list instead. (Inventory's drag grid
  in particular should not attempt to render on mobile — show the list.)
