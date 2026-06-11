/**
 * FAIRPLAY · Deck Configuration
 * ─────────────────────────────────────────────────────────────────
 * USER-EDITABLE: This file is where you tune which Todoist project
 * maps to which card kind, category, and accent color.
 *
 * The deck itself is fetched at runtime as children of the project
 * named DECK_PARENT_NAME below.  If you rename, add, or remove card
 * projects in Todoist, the app follows automatically — you only need
 * to edit this file if you want to override the card kind / category
 * / color for a given project name.
 *
 * HOW TO USE:
 *   • Change DECK_PARENT_NAME if you rename the parent project.
 *   • Add/update an entry in CARD_OVERRIDES keyed by the EXACT
 *     Todoist project name to change kind, category, or color.
 *   • CATEGORY_ORDER controls the visual grouping order in the Rail.
 *   • DEFAULT_KIND / DEFAULT_CATEGORY apply to any project not listed
 *     in CARD_OVERRIDES.
 * ─────────────────────────────────────────────────────────────────
 */

import type { CardKind, CardCategory } from '../lib/types';

/** Exact name of the Todoist parent project that holds all card sub-projects. */
export const DECK_PARENT_NAME = 'My Fair Play Cards';

export interface CardConfig {
  kind: CardKind;
  category: CardCategory;
  color?: string;
}

/**
 * Per-project overrides keyed by EXACT Todoist project name.
 * Projects not listed here get DEFAULT_KIND + DEFAULT_CATEGORY.
 */
export const CARD_OVERRIDES: Record<string, CardConfig> = {
  'Garbage': {
    kind: 'inventory',
    category: 'HOME',
    color: '#9A7B33',
  },
  'Home goods & supplies': {
    kind: 'inventory',
    category: 'HOME',
  },
  'Home maintenance': {
    kind: 'home',
    category: 'HOME',
    color: '#0C857C',
  },
  'Home purchase/rental, mortgage & insurance': {
    kind: 'timeline',
    category: 'HOME',
  },
  'Laundry': {
    kind: 'timeline',
    category: 'HOME',
  },
  'Meals (kids\' school lunches)': {
    kind: 'timeline',
    category: 'HOME',
  },
  'Meals (weekday dinners)': {
    kind: 'timeline',
    category: 'HOME',
    color: '#5B6BB0',
  },
  'Meals (weekend)': {
    kind: 'timeline',
    category: 'HOME',
  },
  'Money manager': {
    kind: 'timeline',
    category: 'OUT',
  },
  'Auto': {
    kind: 'auto',
    category: 'HOME',
    color: '#EE5B2B',
  },
  'Cash & bills': {
    kind: 'timeline',
    category: 'OUT',
    color: '#5B6BB0',
  },
  'Electronics & IT': {
    kind: 'timeline',
    category: 'OUT',
  },
  'School breaks (non-summer)': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Bathing & grooming (kids)': {
    kind: 'inventory',
    category: 'CAREGIVING',
  },
  'Bedtime routine': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Birth control': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Dental (kids)': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Estate planning & life insurance': {
    kind: 'timeline',
    category: 'OUT',
  },
  'Health insurance': {
    kind: 'timeline',
    category: 'OUT',
  },
  'Grooming & wardrobe': {
    kind: 'timeline',
    category: 'OUT',
  },
  'Medical & healthy living (kids)': {
    kind: 'inventory',
    category: 'CAREGIVING',
  },
  'Morning routines (kids)': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Self-care': {
    kind: 'timeline',
    category: 'MAGIC',
  },
  'Teacher communication': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Adult friendships': {
    kind: 'timeline',
    category: 'MAGIC',
  },
  'Fun & playing (kids)': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Marriage & romance': {
    kind: 'datenight',
    category: 'MAGIC',
    color: '#C0497E',
  },
  'Middle-of-the-night comfort': {
    kind: 'timeline',
    category: 'CAREGIVING',
  },
  'Diapering & potty training': {
    kind: 'inventory',
    category: 'CAREGIVING',
  },
  'Unicorn Space': {
    kind: 'timeline',
    category: 'MAGIC',
  },
};

/** Visual order of category groups in the Rail. */
export const CATEGORY_ORDER: CardCategory[] = ['HOME', 'OUT', 'CAREGIVING', 'MAGIC'];

/** Fallback kind for any project not listed in CARD_OVERRIDES. */
export const DEFAULT_KIND: CardKind = 'timeline';

/** Fallback category for any project not listed in CARD_OVERRIDES. */
export const DEFAULT_CATEGORY: CardCategory = 'HOME';

/**
 * Derive a stable card id (slug) from a Todoist project name.
 * lowercase, every run of non-alphanumeric chars → single '-', trimmed.
 * e.g. 'Bathing & grooming (kids)' -> 'bathing-grooming-kids'
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
