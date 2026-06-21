# Handoff: FairPlay Inventory Icon Redesign — "Corporate Emblem" pass

> **Purpose.** Redraw the 22 inventory **supply icons** with more graphical
> realism / weight — a **cyberpunk corporate-emblem** feel rather than the current
> thin technical line marks. Think the brand/faction iconography of **Marathon**
> (Bungie), the racing-team badges in **WipEout** (Feisar, Auricom, Qirex, Piranha),
> and the megacorp marks of **Weyland-Yutani**, **Arasaka**, and **Tyrell Corp**:
> bold, stamped, badge-like, high-contrast, iconic-not-literal.
>
> **The footprint is tiny.** Exactly **one production file** defines every rendered
> icon: `src/shell/icons.tsx`. You are rewriting SVG path data inside it. Nothing
> else in the app needs to change.
>
> **Last verified:** 2026-06-21 against `src/shell/icons.tsx`,
> `src/cards/inventory/InventoryView.tsx`, and `src/styles/theme.css`.

---

## TL;DR

- **What:** new SVG artwork for 22 supply glyphs, same keys, same component API.
- **Aesthetic:** corporate-emblem / industrial-stencil — bolder silhouettes, more
  mass, badge/stamp energy. Still part of the clean-cyberpunk / Marathon-terminal
  system, just with more graphical confidence than the current hairline marks.
- **The one hard rule that shapes everything:** the glyph renders in a **single
  inherited color** (`currentColor`). You get depth from **filled silhouettes,
  negative-space cutouts, and layered opacity** — *not* from extra colors.
- **Must read at 19px** (smallest in-app size) and still look deliberate at 46px.
- **Files to touch:** `src/shell/icons.tsx` (required). Optionally mirror into
  `design/prototype/icons.jsx` to keep the static prototype honest.
- **Iterate visually first:** open `prototype/icon-gallery.html` — it renders all
  22 icons before/after, at every real size, in all 3 themes and the status tiles.

---

## How the icons work today (read this first)

Each icon is a plain inline SVG built by a tiny factory in `src/shell/icons.tsx`:

```tsx
function makeIcon(label: string, g: React.ReactNode) {
  const Icon = ({ size = 24 }: IconProps) => (
    <svg
      viewBox="0 0 24 24" width={size} height={size}
      fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="square" strokeLinejoin="miter"
      style={{ display: 'block' }} aria-label={label}
    >
      {g}
    </svg>
  );
  Icon.displayName = label;
  return Icon;
}

export const IconDiaper = makeIcon('Diaper', <>
  <path d="M4 7 H20 V10.5 C20 16.5 16.5 20 12 20 C7.5 20 4 16.5 4 10.5 Z"/>
  <path d="M4 10.5 H20" opacity=".5"/>
  <path d="M7 7 V4.8 H10 V7 M14 7 V4.8 H17 V7" opacity=".5"/>
</>);
```

They are then collected into a key→component map and a render helper:

```tsx
export const ICON_LIB: Record<string, React.ComponentType<IconProps>> = {
  diaper: IconDiaper, wipes: IconWipes, /* …22 total… */ generic: IconGeneric,
};
export const ICON_ORDER = Object.keys(ICON_LIB);
export function ItemIcon({ name, size = 28 }) {
  const Ic = ICON_LIB[name] ?? IconGeneric;
  return <Ic size={size} />;
}
```

`ItemIcon` is the only thing the rest of the app calls (`InventoryView.tsx`,
restock rows, the detail glyph, the icon picker). So as long as the keys and this
API stay intact, redrawing the artwork is fully contained.

### Current style
24×24 grid · `fill="none"`, `stroke="currentColor"`, `stroke-width 1.4`, square
caps / miter joins · secondary detail dimmed with `opacity` .4–.7. They're tidy
but hairline-thin and a bit hard to read — hence this pass.

---

## The aesthetic target

You're moving from *hairline blueprint* toward *stamped corporate insignia*. The
reference set (Marathon factions, WipEout team brands, Weyland-Yutani / Arasaka /
Tyrell) shares a recognizable grammar — borrow from it:

- **Mass over outline.** Prefer **solid filled silhouettes** with the detail
  *cut out* of the fill (negative space) over a few thin strokes. This is the
  single biggest lever for "graphical realism" and for 19px legibility.
- **Bold, decisive geometry.** Strong primary shape, confident proportions,
  generous use of the full 24×24 field. Stencil/industrial, slightly heavy.
- **Badge / stamp energy (optional but on-theme).** A unifying containment device
  — a notched hex, a chamfered square, a registered-mark tick — can make the set
  read as one *corporate supply line*. If you add a frame motif, apply it
  **consistently** across all 22 so it reads as a system, not 22 one-offs.
- **High contrast, no fuss.** These get scanned at a glance on a grid. One clear
  read per icon. Resist literal detail that vanishes under ~24px.
- **Iconic, not illustrative.** A diaper, a pill bottle, a formula can — each
  should be instantly nameable as a *type mark*, the way a faction logo is.
- **Keep it in the family.** Still the FairPlay terminal aesthetic — square/miter
  joins, geometric, restrained. Don't drift into glossy skeuomorphism or a
  rounded consumer-app icon set.

Keep the existing **layered-opacity** trick for secondary detail (`opacity` .4–.7
on inner lines/marks) — it's how this set fakes depth within one color, and it's
fully compatible with the emblem direction.

---

## Hard constraints (do not break)

1. **The 22 keys are frozen.** Item icon choices are persisted in Todoist metadata
   by key (`FP::` payloads → `inv.icon`). Renaming/removing a key orphans real
   user data. Keep every key, spelled exactly:

   `diaper` · `wipes` · `cream` · `trashbag` · `compostbag` · `waterfilter` ·
   `tablets` · `capsules` · `blister` · `drops` · `formula` · `shampoo` ·
   `conditioner` · `cradlecap` · `sunscreen` · `tp` · `papertowel` · `ziplock` ·
   `plasticwrap` · `foil` · `parchment` · `generic`

2. **Single color — `currentColor` only.** The glyph inherits one ink color from
   its container. It is `--ink-2` (60% ink) at rest, `--ink` when the tile is
   hovered/selected, and `--accent` in the "out" restock row. **No multi-color
   fills, no hardcoded hex, no gradients.** Convey everything in one color.
   - Status (ok / restock-soon / out) is shown by the **tile** (border, corner
     flag, hatch fill) — never by the icon. Don't bake status into the glyph.
   - If you use fills, set `fill="currentColor"` on the filled element (and
     `stroke="none"` on it if you don't want the inherited 1.4 stroke). Stroke
     color + width are inherited from the wrapper, so stroked detail still works.

3. **24×24 viewBox.** Keep it. The `width`/`height` come from the `size` prop;
   don't add a fixed width/height to the inner markup.

4. **Legible at 19px → handsome at 46px.** Real render sizes in the app:

   | size | where |
   |---|---|
   | 19px | restock alert row (`.rs-row .rg`) |
   | 20px | icon picker swatches (`.icon-pick .ip`) |
   | 27px | 1×1 supply tile |
   | 28px | `ItemIcon` default |
   | 32px | larger supply tile + detail-panel glyph (`.id-glyph`) |
   | 46px | 2×2 supply tile |

   19px is the bar. If detail muds together there, simplify the shape.

5. **No new dependencies / assets.** Inline SVG primitives only
   (`path`, `rect`, `circle`, `ellipse`, `polygon`). No raster, no external icon
   lib, no `<image>`, no `<defs>`/filters (they don't tint with `currentColor`
   cleanly and add weight).

6. **Keep the component API.** Same `makeIcon(label, g)` shape, same exported
   `Icon*` names, same `ICON_LIB` keys, same `ItemIcon`/`ICON_ORDER` exports.
   `aria-label`/`displayName` stay = the human label.

---

## Files

### Tier 1 — the only file you must edit
- [ ] **`src/shell/icons.tsx`** (~219 lines) — **The file.** All 22 icon
  definitions + the `makeIcon` factory + `ICON_LIB` / `ICON_ORDER` / `ItemIcon`.
  Rewrite the SVG bodies; leave the keys, exports, and factory signature intact.
  - You *may* adjust the `makeIcon` wrapper defaults (e.g. change the default
    `strokeWidth`, or default `fill`) **if** the whole set moves to fills — but
    prefer overriding per-element so mixed stroke/fill icons keep working and the
    change stays local to the artwork.

### Tier 1b — keep in sync (recommended, not load-bearing)
- [ ] **`design/prototype/icons.jsx`** — a standalone mirror used by the static
  HTML prototype (`design/prototype/FairPlay.html`). **Not imported by the app**
  (the app uses `src/shell/icons.tsx`), but its header promises the keys match.
  Update it with the same path data so the prototype doesn't drift.

### Tier 2 — context (do not edit; explains where icons appear)
- [ ] **`prototype/icon-gallery.html`** (in this bundle) — your iteration harness.
  Renders current-vs-draft for all 22 keys, at every real size, across all three
  themes and the ok/low/out tiles. Edit the `DRAFT` object inside it to preview
  new artwork before porting to `icons.tsx`.
- [ ] **`src/cards/inventory/InventoryView.tsx`** — the consumer. Shows how
  `ItemIcon` is used and which `size` is passed in each spot (grid tiles 27/32/46,
  detail glyph 32, restock row 19, icon picker 20).
- [ ] **`src/cards/inventory/inventory.css`** + **`src/styles/theme.css`**
  (`.ii-icon`, `.inv-item`, `.id-glyph`, `.rs-row .rg` ≈ L406–492) — where the
  icon's `currentColor` is set and how status styles the tile, not the glyph.

### Safe to ignore
Everything else — data layer, other cards, build config. No rendering impact.

---

## Workflow

1. **Open the harness.** `design/design_handoff_inventory_icons/prototype/icon-gallery.html`
   in a browser. Flip themes + color states; note how the *current* icons read at 19px.
2. **Draft in the harness.** Edit the `DRAFT` object (one entry per key) with new
   inner SVG markup. Save, reload, compare against the frozen `CURRENT` column at
   every size and in the status tiles. Iterate until 19px is clean.
3. **Port to code.** Paste each finished body into the matching `makeIcon(...)`
   call in `src/shell/icons.tsx` (convert raw-SVG attrs back to JSX:
   `stroke-width`→`strokeWidth`, `stroke-dasharray`→`strokeDasharray`, etc.).
4. **Mirror** the same path data into `design/prototype/icons.jsx`.
5. **Verify in the app:** `npm run dev`, open an Inventory card. Check the grid
   tiles, the icon-picker row, a restock alert, and the detail glyph — in
   bone / eclipse / vapor.

---

## Done looks like

- [ ] All 22 keys still present and spelled identically; app builds; `ItemIcon`
      API unchanged.
- [ ] Every icon is a single-`currentColor` mark (no hex, no extra colors) and
      tints correctly in all three themes + the accent ("out") state.
- [ ] Each glyph is clearly nameable at **19px** and looks intentional at 46px.
- [ ] The set reads as one cohesive corporate supply line — emblem/stamp weight,
      consistent treatment — not 22 unrelated drawings.
- [ ] Still unmistakably FairPlay (clean-cyberpunk terminal), just bolder.
- [ ] `design/prototype/icons.jsx` mirrors the new artwork.
