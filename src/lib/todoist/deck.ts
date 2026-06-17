/**
 * Deck resolution: finds the named parent project in Todoist,
 * enumerates its child projects in child_order, and maps them to CardDef[].
 *
 * All functions are pure and unit-testable (no network, no store access).
 */

import type { CardDef } from '../types';
import {
  CARD_OVERRIDES,
  DEFAULT_KIND,
  DEFAULT_CATEGORY,
  slug,
} from '../../cards/deck-config';
import type { RawProject } from './client';

export type { RawProject };

/**
 * Given the full project list from Todoist, resolve the deck.
 * Returns CardDef[] sorted by child_order within the parent.
 * Throws if the parent project is not found.
 */
export function resolveDeck(projects: RawProject[], parentName: string): CardDef[] {
  // Prefer a top-level project (parent_id === null) with the matching name;
  // fall back to any depth in case the user nested it.
  const parent =
    projects.find((p) => p.name === parentName && p.parent_id === null) ??
    projects.find((p) => p.name === parentName);

  if (!parent) {
    throw new Error(
      `Deck parent project "${parentName}" not found in Todoist. ` +
        `Create a project with that exact name and add card sub-projects under it.`
    );
  }

  const children = projects
    .filter((p) => p.parent_id === parent.id)
    .sort((a, b) => a.child_order - b.child_order);

  return children.map((p, idx) => {
    const override = CARD_OVERRIDES[p.name];
    const num = String(idx + 1).padStart(2, '0');
    const card: CardDef = {
      id: slug(p.name),
      todoistId: p.id,
      num,
      name: p.name,
      kind: override?.kind ?? DEFAULT_KIND,
      category: override?.category ?? DEFAULT_CATEGORY,
    };
    if (override?.color) card.color = override.color;
    return card;
  });
}

/**
 * Build a Map<todoistProjectId, cardSlug> for fast task → card lookup.
 */
export function buildProjectToCard(deck: CardDef[]): Map<string, string> {
  return new Map(deck.map((c) => [c.todoistId, c.id]));
}

/**
 * Build a Map<cardSlug, CardDef> for fast slug → CardDef lookup.
 */
export function buildSlugToCard(deck: CardDef[]): Map<string, CardDef> {
  return new Map(deck.map((c) => [c.id, c]));
}

// Keep the old export name for compatibility with any consumer that may have
// imported the scaffold's typo-ed version.
export const resolveDecK = resolveDeck;
