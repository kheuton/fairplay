import { describe, it, expect } from 'vitest';
import { resolveDeck, buildProjectToCard } from './deck';
import type { RawProject } from './client';

// Minimal raw project factory
function mkProject(
  id: string,
  name: string,
  parentId: string | null,
  childOrder = 0
): RawProject {
  return {
    id,
    name,
    parent_id: parentId,
    child_order: childOrder,
    color: 'grey',
    view_style: 'list',
    is_archived: false,
    is_deleted: false,
    is_favorite: false,
    description: '',
  };
}

const PARENT_ID = 'parent-001';
const PARENT = mkProject(PARENT_ID, 'My Fair Play Cards', null, 0);

describe('resolveDeck', () => {
  it('throws when parent project is not found', () => {
    expect(() => resolveDeck([])).toThrow('My Fair Play Cards');
    expect(() =>
      resolveDeck([mkProject('x', 'Other Project', null)])
    ).toThrow('My Fair Play Cards');
  });

  it('returns an empty deck when parent has no children', () => {
    expect(resolveDeck([PARENT])).toEqual([]);
  });

  it('returns children in child_order', () => {
    const projects = [
      PARENT,
      mkProject('c1', 'Garbage', PARENT_ID, 2),
      mkProject('c2', 'Auto', PARENT_ID, 0),
      mkProject('c3', 'Laundry', PARENT_ID, 1),
    ];
    const deck = resolveDeck(projects);
    expect(deck.map((c) => c.name)).toEqual(['Auto', 'Laundry', 'Garbage']);
  });

  it('assigns zero-padded nums starting at 01', () => {
    const projects = [
      PARENT,
      mkProject('c1', 'Garbage', PARENT_ID, 0),
      mkProject('c2', 'Auto', PARENT_ID, 1),
    ];
    const deck = resolveDeck(projects);
    expect(deck[0].num).toBe('01');
    expect(deck[1].num).toBe('02');
  });

  it('applies CARD_OVERRIDES for known project names', () => {
    const projects = [
      PARENT,
      mkProject('c1', 'Garbage', PARENT_ID, 0),
    ];
    const deck = resolveDeck(projects);
    expect(deck[0].kind).toBe('inventory');
    expect(deck[0].category).toBe('HOME');
    expect(deck[0].color).toBe('#9A7B33');
  });

  it('applies override kind=auto for Auto card', () => {
    const projects = [PARENT, mkProject('c1', 'Auto', PARENT_ID, 0)];
    const deck = resolveDeck(projects);
    expect(deck[0].kind).toBe('auto');
    expect(deck[0].color).toBe('#EE5B2B');
  });

  it('applies override kind=datenight for Marriage & romance', () => {
    const projects = [PARENT, mkProject('c1', 'Marriage & romance', PARENT_ID, 0)];
    const deck = resolveDeck(projects);
    expect(deck[0].kind).toBe('datenight');
    expect(deck[0].category).toBe('MAGIC');
  });

  it('uses default kind=timeline and category=HOME for unknown projects', () => {
    const projects = [PARENT, mkProject('c1', 'Unknown New Card', PARENT_ID, 0)];
    const deck = resolveDeck(projects);
    expect(deck[0].kind).toBe('timeline');
    expect(deck[0].category).toBe('HOME');
    expect(deck[0].color).toBeUndefined();
  });

  it('computes correct slug for Home purchase/rental, mortgage & insurance', () => {
    const projects = [
      PARENT,
      mkProject('c1', 'Home purchase/rental, mortgage & insurance', PARENT_ID, 0),
    ];
    const deck = resolveDeck(projects);
    expect(deck[0].id).toBe('home-purchase-rental-mortgage-insurance');
  });

  it("computes correct slug for Meals (kids' school lunches)", () => {
    const projects = [
      PARENT,
      mkProject('c1', "Meals (kids' school lunches)", PARENT_ID, 0),
    ];
    const deck = resolveDeck(projects);
    expect(deck[0].id).toBe('meals-kids-school-lunches');
  });

  it('computes correct slug for Bathing & grooming (kids)', () => {
    const projects = [
      PARENT,
      mkProject('c1', 'Bathing & grooming (kids)', PARENT_ID, 0),
    ];
    const deck = resolveDeck(projects);
    expect(deck[0].id).toBe('bathing-grooming-kids');
  });

  it('ignores non-children of the FP parent (other top-level projects)', () => {
    const projects = [
      PARENT,
      mkProject('c1', 'Garbage', PARENT_ID, 0),
      mkProject('x1', 'Some other project', null, 0),   // top level non-FP
      mkProject('x2', 'Nested elsewhere', 'x1', 0),    // child of other
    ];
    const deck = resolveDeck(projects);
    expect(deck.length).toBe(1);
    expect(deck[0].name).toBe('Garbage');
  });

  it('falls back to nested parent if no top-level match exists', () => {
    // If parent is itself a child project (unusual but supported)
    const projects = [
      mkProject('root', 'Root', null, 0),
      mkProject(PARENT_ID, 'My Fair Play Cards', 'root', 0),
      mkProject('c1', 'Garbage', PARENT_ID, 0),
    ];
    const deck = resolveDeck(projects);
    expect(deck.length).toBe(1);
  });
});

describe('buildProjectToCard', () => {
  it('maps todoistId -> cardSlug', () => {
    const projects = [
      PARENT,
      mkProject('proj-gc', 'Garbage', PARENT_ID, 0),
      mkProject('proj-au', 'Auto', PARENT_ID, 1),
    ];
    const deck = resolveDeck(projects);
    const map = buildProjectToCard(deck);
    expect(map.get('proj-gc')).toBe('garbage');
    expect(map.get('proj-au')).toBe('auto');
    expect(map.get('nonexistent')).toBeUndefined();
  });
});
