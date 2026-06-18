/**
 * Deck resolution for the Skylight ICS Worker.
 *
 * MIRRORS: src/lib/todoist/deck.ts (resolveDeck, buildProjectToCard)
 * MIRRORS: src/cards/deck-config.ts (PROFILES, slug)
 *
 * Kept as a self-contained copy so the Worker has no cross-package dependency
 * on the Vite-based app src (which imports DOM types, vite/client, etc.).
 * Any changes to the app's deck-config.ts must be reflected here.
 */

import type { RawProject, CardDef } from './types.js';

// ---------------------------------------------------------------------------
// Profile config  (mirrors src/cards/deck-config.ts)
// ---------------------------------------------------------------------------

export type ProfileId = 'amy' | 'kyle';

export interface Profile {
  id: ProfileId;
  name: string;
  deckParent: string;
}

export const PROFILES: Record<ProfileId, Profile> = {
  amy:  { id: 'amy',  name: 'Amy',  deckParent: "Amy's Fair Play Cards" },
  kyle: { id: 'kyle', name: 'Kyle', deckParent: 'My Fair Play Cards'    },
};

/**
 * Derive a stable card id (slug) from a Todoist project name.
 * Mirrors the slug() function in src/cards/deck-config.ts.
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Deck resolution  (mirrors src/lib/todoist/deck.ts)
// ---------------------------------------------------------------------------

/**
 * Given the full project list from Todoist, resolve the deck for the named
 * parent project. Returns CardDef[] sorted by child_order within the parent.
 * Throws if the parent project is not found.
 */
export function resolveDeck(projects: RawProject[], parentName: string): CardDef[] {
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
    const num = String(idx + 1).padStart(2, '0');
    const card: CardDef = {
      id: slug(p.name),
      todoistId: p.id,
      num,
      name: p.name,
      kind: 'timeline',
      category: 'HOME',
    };
    return card;
  });
}

/**
 * Build a Set of Todoist project IDs that belong to the given deck(s).
 */
export function buildDeckProjectIds(decks: CardDef[][]): Set<string> {
  const ids = new Set<string>();
  for (const deck of decks) {
    for (const card of deck) {
      ids.add(card.todoistId);
    }
  }
  return ids;
}
