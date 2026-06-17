/**
 * FAIRPLAY · useIsMobile
 * ──────────────────────────────────────────────────────────────────────────
 * Single breakpoint switch for the desktop ⇆ mobile presentation. The app shares
 * one data/logic/token layer; only the React shell + a few presentational
 * components diverge below this width (see App.tsx).
 */
import { useState, useEffect } from 'react';

/** Phones render the mobile shell at or below this CSS width. */
export const MOBILE_MAX_WIDTH = 480;

const QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

function matches(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(QUERY).matches
    : false;
}

/** Reactive: re-renders when the viewport crosses the phone breakpoint. */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(matches);

  useEffect(() => {
    const mql = window.matchMedia(QUERY);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // Sync immediately in case the viewport changed before the effect ran.
    setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return isMobile;
}
