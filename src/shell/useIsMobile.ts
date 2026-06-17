/**
 * FAIRPLAY · useIsMobile
 * ──────────────────────────────────────────────────────────────────────────
 * Single breakpoint switch for the desktop ⇆ mobile presentation. The app shares
 * one data/logic/token layer; only the React shell + a few presentational
 * components diverge below this width (see App.tsx).
 *
 * A device counts as "mobile" when EITHER:
 *   • the viewport is narrow (≤480px), OR
 *   • it's a touch device on a not-large screen (coarse pointer, ≤1024px).
 *
 * The second clause matters because a phone whose browser is in "Request desktop
 * site" mode reports an inflated ~980px layout viewport (so the width-only check
 * fails) while still keeping a coarse/touch pointer — so we still pick mobile.
 * Real desktops report a fine pointer and stay on the desktop shell.
 */
import { useState, useEffect } from 'react';

/** Phones render the mobile shell at or below this CSS width. */
export const MOBILE_MAX_WIDTH = 480;

const QUERIES = [
  `(max-width: ${MOBILE_MAX_WIDTH}px)`,
  '(pointer: coarse) and (max-width: 1024px)',
];

function matchesMobile(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return QUERIES.some((q) => window.matchMedia(q).matches);
}

/** Reactive: re-renders when the viewport crosses the phone breakpoint. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(matchesMobile);

  useEffect(() => {
    const mqls = QUERIES.map((q) => window.matchMedia(q));
    const update = () => setIsMobile(mqls.some((m) => m.matches));
    // Sync immediately in case the viewport changed before the effect ran.
    update();
    mqls.forEach((m) => m.addEventListener('change', update));
    return () => mqls.forEach((m) => m.removeEventListener('change', update));
  }, []);

  return isMobile;
}
