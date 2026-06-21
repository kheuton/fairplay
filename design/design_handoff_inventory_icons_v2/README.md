# Handoff: FairPlay Inventory Icons — "Vectorheart" rich color pass

> **What this is.** A drop-in replacement for `src/shell/icons.tsx` that swaps the
> old hairline `currentColor` marks for **detailed, multi-color vector
> illustrations** of each supply — real material color, caps / pumps / labels, a
> highlight sheen and a shadow plane for dimension. The public component API is
> unchanged, so the rest of the app keeps working.
>
> **Last built:** 2026-06-21. Verified live in the prototype app
> (`design/app/FairPlay.html`) across the supply grid, restock rows, detail
> glyph, and icon picker.

---

## TL;DR for integration

1. Copy `src/icon-art.ts` → `src/shell/icon-art.ts`
2. Copy `src/icons.tsx` → `src/shell/icons.tsx` (replaces the old file)
3. Merge `src/icons.css` into `src/styles/theme.css` (or `inventory.css`) — **required**
4. Build. `ItemIcon` / `ICON_LIB` / `ICON_ORDER` keep their old signatures; no
   call sites change.

Open `preview/icon-gallery.html` in a browser to review all SKUs first (Stage =
Dark/Bone, Chrome = Full brand / Object only).

---

## Files

| File | Goes to | Notes |
|---|---|---|
| `src/icon-art.ts` | `src/shell/icon-art.ts` | The artwork. Plain TS — a tiny parts system (`rr`, `pa`, `ci`, `drop`, `sheen`, `leaf`, `star4`) builds each glyph's inner-SVG string. Exports `RICH_ICONS` (`key → {label, cat, svg}`) and `RICH_ORDER`. No React, no deps. |
| `src/icons.tsx` | `src/shell/icons.tsx` | The component layer. Builds `ICON_LIB` / `ICON_ORDER`, the legacy-key `ICON_ALIAS`, `ItemIcon`, and a `makeIcon(label, svg)` factory kept for parity. |
| `src/icons.css` | merge into `theme.css` | **Required.** Dark "well" behind each glyph so the color reads in every theme. |
| `preview/icon-gallery.html` (+ `icons-rich.js`) | — | Standalone review harness. Not shipped. |

---

## The three things that changed (read before merging)

### 1. Glyphs are multi-color, not `currentColor`
Each icon carries its own fills (hex). They no longer inherit one ink color.
`ItemIcon` renders the art via `dangerouslySetInnerHTML` (the strings are
authored in-repo, not user input — safe).

### 2. Status moves entirely to the tile
Because the glyph is colored, it can't also tint for ok / low / out. That's fine —
status was *already* shown by the tile (`.inv-item.low` / `.inv-item.out`:
border, corner flag, hatch fill). The glyph now stays neutral on its dark well.
The old `.ii-icon { color: … }` hover/selected rules are now no-ops and can be
removed.

### 3. The key set grew — but legacy keys still resolve
New SKUs were added (e.g. `ziploc_gal` / `ziploc_qt` / `ziploc_sand`,
`bodywash`, `handsoap`, `toothpaste`, `laundry`, `detergent`,
`dishwasher_det`, `bottlesoap`, `glasscleaner`, `allpurpose`, `dawn`,
`nontoxic`, `childwipes`, `swiffer_wet`, `swiffer_dust`, `toiletpucks`,
`bugspray`, `printerpaper`, `diaper_night`, …).

Old keys are aliased so **persisted `inv.icon` values keep working with no
migration**:

```
wipes → childwipes   tablets → motrin    capsules → tylenol
blister → zyrtec     drops → probiotic   trashbag → trashbag_bath
ziplock → ziploc_gal
```

`ICON_LIB` contains both the real keys and the aliases; `ICON_ORDER` (the
picker) lists only the real SKUs, `generic` last.

---

## API reference (unchanged surface)

```tsx
import { ItemIcon, ICON_LIB, ICON_ORDER } from './shell/icons';

<ItemIcon name="dawn" size={46} />          // render a glyph
ICON_LIB['shampoo'].label                   // "Shampoo"  (picker tooltips)
ICON_ORDER.map(k => <ItemIcon name={k} />)  // icon picker
```

`makeIcon(label, svg)` is exported for parity with the old factory if you build
one-off icons elsewhere.

---

## Render sizes to respect (the bar is 19px)

| size | where |
|---|---|
| 19px | restock alert row (`.rs-row .rg`) |
| 20px | icon-picker swatch (`.icon-pick .ip`) |
| 27 / 32 / 46px | supply-grid tiles (1×1 / mixed / 2×2) |
| 32px | detail-panel glyph (`.id-glyph`) |

The illustrations carry real detail and sing at tile size; at **19px** they read
but soften. If you want them razor-sharp that small, the cleanest path is a
`detail` variant per key that swaps in below ~24px — ask and we'll author them.

---

## Editing / adding artwork

All geometry is in `icon-art.ts` on a 24×24 grid. Lighting is conventional:
light top-left → `sheen(...)` (white) on the left, a darker sibling color as a
right-side shade plane. Palette lives in the `C` object at the top (each body
color ships with `L`/`D` siblings). To add a SKU: add an entry to `I` with
`{ label, cat, svg }`; it shows up in `ICON_ORDER`/the picker automatically.

Keys are persisted in Todoist metadata — **don't rename or remove an existing
key** (add an alias instead, like the table above).
