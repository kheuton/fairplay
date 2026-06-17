# FairPlay — Mobile Responsiveness Handoff

> **Purpose.** A self-contained brief for a design pass that makes FairPlay usable on
> phones. It tells you the styling approach, the exact files to touch, the layout
> problems to solve, and the conventions you must preserve. You do **not** need the
> whole codebase — the data/API layer produces no DOM. Everything visual is below.
>
> **Last verified:** 2026-06-17 against `src/styles/theme.css` and `index.html`.
> Line refs are accurate as of that date; confirm before relying on an exact number.

---

## TL;DR

The app is **plain CSS with a semantic custom-property token system** — no Tailwind,
no styled-components, no CSS-in-JS. The viewport `<meta>` tag is correct. The blocker
is that the **entire frame is fixed-dimension, desktop-only, with ZERO `@media`
queries in any file.** Roughly 90% of the fix lives in **one file**
(`src/styles/theme.css`) plus a handful of shell components.

The smallest set that lets you do real work:

```
src/styles/theme.css      ← the master stylesheet (tokens + every layout primitive)
src/App.tsx               ← the shell frame (where the mobile structure is decided)
src/shell/TopBar.tsx      ← 52px header
src/shell/Rail.tsx        ← 256px left nav
src/shell/atoms.tsx       ← TaskRow + MiniCalendar (render on nearly every screen)
src/pages/InboxPage.tsx   ← landing page
src/pages/inbox/inbox.css ← landing-page styles
index.html                ← (context) proves the viewport meta is fine
design/prototype/FairPlay.html ← (context) the intended desktop look
```

Add the per-card `.css`/`View.tsx` files only when you tackle the bespoke card views,
and **split Inventory off as its own task** (see the last section).

---

## Styling approach (read this first)

- **Plain CSS + semantic tokens.** Colors, type, spacing, and lines are all CSS custom
  properties (`--bg`, `--surface`, `--surface-2`, `--ink`, `--ink-2..4`, `--line`,
  `--accent`, `--accent-d`, `--accent-ink`, `--grid`, …). **Never hardcode a color or
  a raw hex** — always reference a token, or add a new token if you truly need one.
- **Three themes** are just different token values on the root element:
  `.app[data-theme="bone"|"eclipse"|"vapor"]` (theme.css L9 / L30 / L51). Layout must
  look right in all three. Don't theme-fork layout — only colors differ by theme.
- **Density** is a second axis: `.app[data-density="compact"|"comfy"]` adjusts padding
  (e.g. `.trow` padding at theme.css L237–L238). A sensible mobile default is
  `compact`, but that's a settings concern — see `src/state/settings.ts`.
- **Accent** can be overridden at runtime via inline `--accent`/`--accent-d` CSS vars on
  `.app` (set in `src/App.tsx`). Don't break that — keep reading accent from the var.
- **Aesthetic to preserve:** clean-cyberpunk / Marathon-terminal — monospace labels
  (JetBrains Mono), thin 1px lines, uppercase micro-labels, a faint background grid.
  Make it *responsive*, not *generic*. Don't flatten it into a stock mobile UI kit.
- **Viewport meta:** present and correct — `index.html:5`
  (`width=device-width, initial-scale=1.0`). The CSS is the blocker, not the meta tag.

---

## The core problem: a fixed three-column desktop frame

There are **no media queries anywhere in the project.** The frame is built from a fixed
shell plus three fixed-width sidebars. On a 390px-wide phone, any single sidebar eats
66–97% of the width:

| Element | Rule | Where |
|---|---|---|
| App shell | `position: fixed; inset: 0` (locks the viewport; no document scroll) | `theme.css:79` |
| Top bar | `height: 52px; flex: 0 0 52px` | `theme.css:100` |
| Left nav (Rail) | `width: 256px; flex: 0 0 256px` | `theme.css:128` |
| Right Calendar Peek | `width: 296px; flex: 0 0 296px` | `theme.css:281` |
| Bespoke card side panel | `width: 380px; flex: 0 0 380px` | `theme.css:351` |

Plus several grids and modals that assume a wide canvas:

| Element | Rule | Where |
|---|---|---|
| Task row | `grid-template-columns: 24px 1fr auto auto auto` | `theme.css:233` |
| Timeline date col | `width: 78px; flex: 0 0 78px` | `theme.css:316` |
| Mini-calendar | `grid-template-columns: repeat(7, 1fr)` | `theme.css:284` |
| Car schematic | `width: 100%; max-width: 640px` | `theme.css:336` |
| Icon picker | `grid-template-columns: repeat(6, 1fr)` | `theme.css:480` |
| QuickAdd modal | `position: fixed; inset: 0` backdrop | `theme.css:510` |
| Recurrence weekday btns | 7 buttons, no wrap | `theme.css:593` |
| No-token banner | `position: fixed; bottom: 0; left: 0; right: 0` | `theme.css:498` |

---

## File manifest

### Tier 1 — Must include (where the fixes happen)

- [ ] **`src/styles/theme.css`** (~564 lines) — **The file.** All tokens + every shared
  layout primitive (topbar, rail, peek, task rows, calendars, modals, bespoke shell).
  Holds every fixed dimension in the table above. Most breakpoint work lands here.
- [ ] **`src/App.tsx`** — Root shell wiring TopBar + Rail + Routes + Peek into a
  three-column flex frame (`.app-inner`, ~L146). **The mobile structure decision lives
  here** — hamburger/drawer rail, peek as bottom-sheet, etc.
- [ ] **`src/shell/TopBar.tsx`** — 52px header: brand, profile pills (Amy ⇆ Kyle),
  clock, status, settings glyph — all one non-wrapping row. Overflows at 390px; needs
  collapse/hide logic.
- [ ] **`src/shell/Rail.tsx`** — Left nav (256px = ~66% of a phone). Convert to a
  drawer/hamburger or bottom-tab nav. Search input + card names assume ≥220px.
- [ ] **`src/shell/atoms.tsx`** — Shared `TaskRow` (5-col grid, `theme.css:233`) and
  `MiniCalendar` (7-col grid, `theme.css:284`). **Render on nearly every screen —
  highest-payoff fix.** Both crush on narrow widths.
- [ ] **`src/pages/InboxPage.tsx`** + **`src/pages/inbox/inbox.css`** — Default landing
  page; two-pane (scroll list + 296px peek). Peek must become a drawer/bottom-sheet on
  mobile so the list isn't squeezed to ~94px.
- [ ] **`src/shell/charter.css`** + **`src/shell/CharterPanel.tsx`** — The MSC/CPE editor
  strip under every card header; two-column flex that starves to ~160px/column. Stack
  on mobile.
- [ ] **`src/shell/QuickAdd.tsx`** + **`src/shell/RecurPicker.tsx`** — Add-task modal and
  recurrence picker. 7 weekday buttons (`theme.css:593`) with no wrap; touch targets
  below the 44px guideline.

**Per-card views** (all inherit `.bespoke-side` 380px + `.schematic` 640px from
theme.css, so theme.css unlocks most of them — include these for SVG/grid specifics):

- [ ] `src/cards/timeline/{timeline.css,TimelineView.tsx}` — **Easiest** (already uses
  flex-wrap). Mainly the 78px date column (`theme.css:316`) + side padding.
- [ ] `src/cards/auto/{auto.css,AutoView.tsx}` — Landscape 600×370 SVG with hardcoded
  hotspot positions; shrinks badly in portrait. ~10px hotspot labels.
- [ ] `src/cards/datenight/{datenight.css,DateNightView.tsx}` — 7-col calendar,
  `min-height: 80px` cells; a `position: fixed` popover that can float off-screen.
- [ ] `src/cards/home/{home.css,HomeView.tsx}` + `src/cards/home/water-filter.css` +
  `WaterFilter.tsx` — Portrait blueprint SVG (more mobile-friendly) but 5.5–8px interior
  labels become unreadable; narrow zone selectors.
- [ ] `src/cards/inventory/{inventory.css,InventoryView.tsx}` — **Hardest — own task.**
  See last section.

### Tier 2 — Include for context (don't edit much)

- [ ] **`index.html`** — Proves the viewport meta is correct (L5). The CSS is the blocker.
- [ ] **`design/prototype/FairPlay.html`** (+ `design/prototype/theme.css`,
  `design/wireframes/wire.css`) — Static desktop prototype = best single artifact for
  grasping design intent. `wire.css` even has an early `rail--mini` (60px) idea. Not
  used in production.
- [ ] **`src/main.tsx`** — Entry / CSS-import order / fonts (Space Grotesk + JetBrains
  Mono, bundled offline). No layout, but shows where global overrides slot in.
- [ ] **`src/pages/SettingsPage.tsx`** + **`src/state/settings.ts`** — Mostly
  single-column already (fine on mobile). Worth a glance: default density to `compact`
  on mobile; the accent-swatch grid (28×28px) may want larger touch targets.

### Tier 3 — Safe to omit (zero rendering impact; only adds noise)

- `src/lib/todoist/*` — Todoist API client + data hooks. Pure network/data.
- `src/lib/types.ts`, `src/lib/metadata.ts`, `src/lib/inventory-math.ts` — types + math.
- `src/cards/registry.ts` — pure card-kind routing (include only if you want the full map).
- `vite.config.ts`, `tsconfig*.json`, `package*.json` — build config. The only relevant
  fact ("plain CSS tokens, no framework") is captured above.
- `scripts/*`, tests, `.github/` CI/deploy — irrelevant to how the page looks.

---

## The hardest problems (in priority order)

1. **Kill the fixed frame + three-column layout.** Replace `position: fixed; inset: 0`
   (`theme.css:79`) and the side-by-side Rail / Peek / bespoke-side with a scrollable,
   stacked layout. Rail → hamburger/drawer or bottom-nav; Peek → drawer/bottom-sheet
   (reclaims ~256px + ~296px). This is the foundational change everything else depends on.
2. **Reflow the grids.** `TaskRow`'s 5-col grid (`theme.css:233`) and the 7-col calendars
   (`theme.css:284`; datenight cells) need to collapse to stacked / fewer columns on
   narrow screens without losing the due/tag info.
3. **Replace hover-only affordances with touch states.** ~37 `:hover` rules across the CSS
   gate things touch users can never reach (e.g. row actions revealed on hover). Add
   `:active`/`:focus`/always-visible equivalents on touch.
4. **Make SVG card art legible.** Blueprint, car schematic, and water-filter canister
   carry interior text at 5.5–10px that's unreadable when scaled to a phone. Use
   responsive text sizing, `viewBox`-based scaling, or simplified mobile renderings.

### A suggested approach (not prescriptive)
- Introduce a single mobile breakpoint set (e.g. `max-width: 768px` tablet,
  `max-width: 480px` phone) and keep all responsive rules grouped, since today there are
  none to conflict with.
- Convert the shell from `position: fixed` columns to a normal document flow with a
  sticky top bar; move Rail + Peek behind toggles.
- Bump interactive targets to ≥44px on touch; let monospace micro-labels stay small
  (they're decorative), but ensure *tappable* things are finger-sized.
- Verify in all three themes (bone/eclipse/vapor) and both densities.

### Done looks like
- No horizontal scroll at 390px on the Inbox and on at least one card of each kind.
- Rail + Peek reachable but not stealing width by default.
- Every action reachable by tap (no hover-gated controls).
- Aesthetic intact — still reads as the clean-cyberpunk terminal, not a generic mobile UI.

---

## The one card that deserves its own task: Inventory

`src/cards/inventory/{InventoryView.tsx,inventory.css}` is the outlier across the whole
app. It's built on a **hardcoded `INV_CELL = 64` grid** with **mouse-only drag-to-rearrange
using raw `clientX/clientY` offset math (no touch handling)**, plus the inherited 380px
side panel and a fixed 180px add-input. The other bespoke cards just need the side panel
to stack and their SVGs to scale; Inventory needs a **genuinely different interaction
model on touch** — smaller cells / single column, touch-drag or a non-drag reorder, and
the detail panel as a modal or bottom-sheet. **Scope it separately** rather than folding
it into the general breakpoint pass.
