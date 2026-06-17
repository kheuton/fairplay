/**
 * FAIRPLAY · Mobile navigation drawer.
 * Slide-out left panel: Inbox / Done / Me links + the full categorized card list
 * (the chosen drawer-nav model — there is no bottom tab bar or persistent rail).
 * Reuses useDeck + useDeckTasks; per-card due counts use the shared triage buckets.
 */
import React, { useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDeck, useDeckTasks } from '../lib/todoist/hooks';
import { CATEGORY_ORDER } from '../cards/deck-config';
import { getTriageGroup } from '../lib/triage';
import type { CardDef } from '../lib/types';
import { Ic, type IconProps } from './icons';

interface DrawerProps {
  open: boolean;
  onClose: () => void;
}

export function Drawer({ open, onClose }: DrawerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { data: deck = [] } = useDeck();
  const { data: tasks = [] } = useDeckTasks();
  const now = new Date();

  // Per-card "due now" count = OVERDUE + TODAY buckets (matches the desktop Rail).
  const dueByCard = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tasks) {
      if (!t.cardId || t.isCompleted) continue;
      const g = getTriageGroup(t, now);
      if (g === 'OVERDUE' || g === 'TODAY') m.set(t.cardId, (m.get(t.cardId) ?? 0) + 1);
    }
    return m;
    // now.toDateString() keeps OVERDUE/TODAY bucketing fresh across midnight
    // (matches the desktop Rail's getDueCount dependency pattern).
  }, [tasks, now.toDateString()]);

  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((cat) => ({ cat, items: deck.filter((c) => c.category === cat) })).filter(
        (g) => g.items.length > 0
      ),
    [deck]
  );

  // Escape closes the drawer while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const go = (to: string) => {
    navigate(to);
    onClose();
  };

  const links: Array<{ to: string; label: string; icon: (p?: IconProps) => React.ReactElement; count?: number }> = [
    { to: '/', label: 'Inbox', icon: Ic.inbox, count: tasks.length },
    { to: '/done', label: 'Done', icon: Ic.done },
    { to: '/settings', label: 'Me', icon: Ic.me },
  ];

  return (
    <>
      <div className={`m-backdrop${open ? ' show' : ''}`} onClick={onClose} />
      <nav className={`m-drawer${open ? ' show' : ''}`} aria-hidden={!open} aria-label="Card navigation">
        <div className="m-drawer-h">
          <div className="m-mark" />
          <div className="m-brandname">FAIRPLAY</div>
          <div className="m-top-spacer" />
          <button className="m-iconbtn" onClick={onClose} aria-label="Close menu">
            {Ic.x({ s: 14 })}
          </button>
        </div>
        <div className="m-drawer-scroll">
          {links.map((l) => {
            const on = l.to === '/' ? location.pathname === '/' : location.pathname === l.to;
            return (
              <button key={l.to} className={`m-drawer-link${on ? ' on' : ''}`} onClick={() => go(l.to)}>
                {l.icon({ s: 18, c: 'currentColor' })}
                <span className="nm">{l.label}</span>
                {l.count !== undefined && l.count > 0 && <span className="cnt">{l.count}</span>}
              </button>
            );
          })}

          {groups.map(({ cat, items }) => (
            <div key={cat}>
              <div className="m-drawer-cat">{cat}</div>
              {items.map((card: CardDef) => {
                const due = dueByCard.get(card.id) ?? 0;
                const on = location.pathname === `/card/${card.id}`;
                return (
                  <button
                    key={card.id}
                    className={`m-drawer-link${due > 0 ? ' has-due' : ''}${on ? ' on' : ''}`}
                    onClick={() => go(`/card/${card.id}`)}
                  >
                    <span className="num">{card.num}</span>
                    <span className="nm">{card.name}</span>
                    <span className="cnt">{due > 0 ? due : '·'}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>
    </>
  );
}
