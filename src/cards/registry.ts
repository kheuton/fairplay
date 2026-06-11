/**
 * FAIRPLAY · Card view registry.
 * Maps CardKind -> lazily-loaded default-export React component.
 * The deck itself is fetched at runtime via useDeck() in hooks.ts —
 * this file only handles the view-routing concern.
 */
import { lazy } from 'react';
import type { CardKind } from '../lib/types';

const TimelineView  = lazy(() => import('./timeline/TimelineView'));
const InventoryView = lazy(() => import('./inventory/InventoryView'));
const AutoView      = lazy(() => import('./auto/AutoView'));
const HomeView      = lazy(() => import('./home/HomeView'));
const DateNightView = lazy(() => import('./datenight/DateNightView'));

/** Return the lazily-loaded view component for the given card kind. */
export function viewForKind(kind: CardKind) {
  switch (kind) {
    case 'timeline':  return TimelineView;
    case 'inventory': return InventoryView;
    case 'auto':      return AutoView;
    case 'home':      return HomeView;
    case 'datenight': return DateNightView;
  }
}
