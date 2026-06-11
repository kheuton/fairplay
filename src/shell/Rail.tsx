/**
 * FAIRPLAY · Rail (left navigation) shell component.
 * Card nav from useDeck() grouped by category in CATEGORY_ORDER.
 * Due count per card = tasks overdue or due today.
 * Diamond suffix for non-timeline kinds.
 * Search filter (client-side name filter).
 * NavLink active state from current route.
 */
import React, { useState, useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { isToday, parseISO } from 'date-fns';
import { useDeck, useDeckTasks } from '../lib/todoist/hooks';
import { getToken } from '../state/settings';
import { CATEGORY_ORDER } from '../cards/deck-config';
import type { CardDef, FpTask } from '../lib/types';

// ─── Cross search glyph ───────────────────────────────────────────────────────

function CrossSm() {
  return (
    <svg width={11} height={11} viewBox="0 0 10 10" style={{ display: 'block', flex: '0 0 11px' }}>
      <line x1="5" y1="0" x2="5" y2="10" stroke="var(--ink-4)" strokeWidth="1" />
      <line x1="0" y1="5" x2="10" y2="5" stroke="var(--ink-4)" strokeWidth="1" />
      <circle cx="5" cy="5" r="2.2" fill="none" stroke="var(--ink-4)" strokeWidth="1" />
    </svg>
  );
}

// ─── Derive due count for a card ──────────────────────────────────────────────

function getDueCount(cardId: string, tasks: FpTask[]): number {
  const now = new Date();
  return tasks.filter((t) => {
    if (t.cardId !== cardId || t.isCompleted) return false;
    if (!t.due) return false;
    try {
      const dt = t.due.datetime ? parseISO(t.due.datetime) : parseISO(t.due.date);
      return dt < now || isToday(dt);
    } catch {
      return false;
    }
  }).length;
}

// ─── Rail item ────────────────────────────────────────────────────────────────

interface RailItemProps {
  card: CardDef;
  dueCount: number;
  hasToken: boolean;
}

function RailItem({ card, dueCount, hasToken }: RailItemProps) {
  const isCustom = card.kind !== 'timeline';
  const hasDue = dueCount > 0;

  return (
    <NavLink
      to={`/card/${card.id}`}
      className={({ isActive }) =>
        `rail-item${isActive ? ' active' : ''}${isCustom ? ' custom' : ''}${hasDue ? ' has-due' : ''}`
      }
      style={{ textDecoration: 'none' }}
    >
      <span className="num mono">{card.num}</span>
      <span className="nm">{card.name}</span>
      <span className="cnt mono">
        {hasToken && hasDue ? dueCount : '·'}
      </span>
    </NavLink>
  );
}

// ─── Skeleton rows (loading state) ────────────────────────────────────────────

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="rail-item"
          style={{ opacity: 0.3 + (i % 3) * 0.1 }}
        >
          <span className="num mono" style={{ background: 'var(--ink-4)', width: 14, height: 8, display: 'block', borderRadius: 1 }} />
          <span className="nm" style={{ background: 'var(--ink-4)', width: `${60 + (i % 5) * 15}%`, height: 10, display: 'block', borderRadius: 1 }} />
          <span className="cnt mono">·</span>
        </div>
      ))}
    </>
  );
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export function Rail() {
  const [search, setSearch] = useState('');
  const { data: deck = [], isLoading } = useDeck();
  const { data: tasks = [] } = useDeckTasks();

  const hasToken = getToken() !== null;

  const q = search.trim().toLowerCase();

  const filtered = q
    ? deck.filter((c) => c.name.toLowerCase().includes(q))
    : deck;

  const groups = useMemo(() =>
    CATEGORY_ORDER.map((cat) => ({
      cat,
      items: filtered.filter((c: CardDef) => c.category === cat),
    })).filter((g) => g.items.length > 0),
    [filtered]
  );

  return (
    <div className="rail">
      {/* Header */}
      <div className="rail-head">
        <div className="rail-title">
          <b className="up-s">My Cards</b>
          <span className="mono">{deck.length}</span>
        </div>
        <div className="search">
          <CrossSm />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search cards"
          />
        </div>
      </div>

      {/* Scrollable list */}
      <div className="rail-scroll">
        {/* Pinned home item — the triage inbox */}
        <NavLink
          to="/"
          end
          className={({ isActive }) => `rail-item${isActive ? ' active' : ''}`}
          style={{ textDecoration: 'none' }}
        >
          <span className="num mono">◆</span>
          <span className="nm">Triage Inbox</span>
          <span className="cnt mono">·</span>
        </NavLink>

        {isLoading && <SkeletonRows />}

        {!isLoading && groups.map(({ cat, items }) => (
          <div key={cat}>
            <div className="rail-cat mono up">
              <span>{cat}</span>
              <span className="ln" />
              <span>{items.length}</span>
            </div>
            {items.map((card: CardDef) => (
              <RailItem
                key={card.id}
                card={card}
                dueCount={getDueCount(card.id, tasks)}
                hasToken={hasToken}
              />
            ))}
          </div>
        ))}

        {/* No-token state: rail still renders, counts blank */}
        {!isLoading && !hasToken && deck.length === 0 && (
          <div className="rail-cat mono up-s" style={{ padding: '18px 16px', color: 'var(--ink-4)' }}>
            NO TOKEN
          </div>
        )}
      </div>
    </div>
  );
}
