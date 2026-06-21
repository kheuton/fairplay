/* ============================================================
   src/shell/icons.tsx — FairPlay supply icon family
   "Vectorheart" rich pass.

   WHAT CHANGED vs the old hairline set
   ------------------------------------
   • Icons are now detailed, MULTI-COLOR vector illustrations.
     Art (raw inner-SVG strings) lives in ./icon-art.ts.
   • They are NO LONGER single `currentColor` marks. Each glyph
     carries its own fills, so status is conveyed entirely by the
     TILE (border / corner flag / hatch) — never by the glyph.
     (See icons.css — the glyph now sits on a fixed dark "well".)
   • The key set GREW. Legacy keys still resolve via ICON_ALIAS so
     persisted `inv.icon` payloads keep working with zero migration.

   PUBLIC API IS UNCHANGED: ItemIcon / ICON_LIB / ICON_ORDER.
   ============================================================ */

import * as React from 'react';
import { RICH_ICONS, RICH_ORDER } from './icon-art';

export interface IconProps { size?: number }

/* Legacy key → rich key. Old item.icon values resolve to the
   nearest new SKU so nothing in saved Todoist metadata breaks. */
const ICON_ALIAS: Record<string, string> = {
  wipes:    'childwipes',
  trashbag: 'trashbag_bath',
  tablets:  'motrin',
  capsules: 'tylenol',
  blister:  'zyrtec',
  drops:    'probiotic',
  ziplock:  'ziploc_gal',
};

type IconDef = { label: string; svg: string };

/* library: every rich key + every legacy alias → { label, svg } */
export const ICON_LIB: Record<string, IconDef> = {};
for (const k of Object.keys(RICH_ICONS)) {
  ICON_LIB[k] = { label: RICH_ICONS[k].label, svg: RICH_ICONS[k].svg };
}
for (const k of Object.keys(ICON_ALIAS)) {
  const r = RICH_ICONS[ICON_ALIAS[k]];
  if (r && !ICON_LIB[k]) ICON_LIB[k] = { label: r.label, svg: r.svg };
}

/* picker order: real SKUs only (no duplicate alias rows), generic last */
export const ICON_ORDER: string[] =
  RICH_ORDER.filter((k) => k !== 'generic').concat(RICH_ICONS.generic ? ['generic'] : []);

/* factory kept for parity with the old makeIcon(label, g) shape */
export function makeIcon(label: string, svg: string) {
  const Icon: React.FC<IconProps> & { displayName?: string } = ({ size = 24 }) => (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={label}
      style={{ display: 'block' }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
  Icon.displayName = label;
  return Icon;
}

export function ItemIcon({ name, size = 28 }: { name: string; size?: number }) {
  const def = ICON_LIB[name] ?? ICON_LIB.generic ?? { label: '', svg: '' };
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      role="img"
      aria-label={def.label}
      style={{ display: 'block' }}
      dangerouslySetInnerHTML={{ __html: def.svg }}
    />
  );
}
