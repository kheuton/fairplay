/**
 * FAIRPLAY · InboxPage
 * Triage inbox: upcoming tasks across all cards, calendar peek, stats.
 * Route: '/'
 */
import React, { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { format, startOfDay, parseISO, differenceInCalendarDays } from 'date-fns';
import {
  useDeck,
  useDeckTasks,
  useCompletedTasks,
  useCloseTask,
  useReopenTask,
  useConnection,
} from '../lib/todoist/hooks';
import type { FpTask } from '../lib/types';
import { getTriageGroup, sortByDue, type TriageGroup } from '../lib/triage';
import { dueLabel } from '../lib/format';
import {
  GroupLabel,
  TaskRow,
  MiniCalendar,
  LoadState,
  Seg,
  Stats,
} from '../shell/atoms';
import { QuickAdd } from '../shell/QuickAdd';
import './inbox/inbox.css';

// ─── Grouping helpers ─────────────────────────────────────────────────────────
// getTriageGroup / sortByDue / TriageGroup now live in ../lib/triage so the
// mobile screens share the exact same bucketing. buildPips / findNextUp below
// stay here (desktop calendar peek only).

// ─── Calendar pips builder ────────────────────────────────────────────────────

function buildPips(
  tasks: FpTask[],
  now: Date
): Record<string, 'normal' | 'urgent'> {
  const pips: Record<string, 'normal' | 'urgent'> = {};
  const ref = startOfDay(now);
  for (const task of tasks) {
    if (!task.due) continue;
    const dateStr = task.due.date; // always 'yyyy-MM-dd'
    let pip: 'normal' | 'urgent' = 'normal';
    try {
      const d = parseISO(dateStr);
      const diff = differenceInCalendarDays(d, ref);
      if (diff < 0 || task.priority === 4) pip = 'urgent';
    } catch {
      // skip
    }
    // Upgrade to urgent if already exists as normal
    if (!pips[dateStr] || pip === 'urgent') {
      pips[dateStr] = pip;
    }
  }
  return pips;
}

// ─── NEXT UP: soonest upcoming or today task ──────────────────────────────────

function findNextUp(tasks: FpTask[], now: Date): FpTask | null {
  const ref = startOfDay(now);
  // Prefer tasks due today or in the future, sorted by due
  const upcoming = tasks
    .filter((t) => {
      if (!t.due) return false;
      try {
        const d = parseISO(t.due.datetime ?? t.due.date);
        return differenceInCalendarDays(d, ref) >= 0;
      } catch {
        return false;
      }
    })
    .sort(sortByDue);
  return upcoming[0] ?? tasks.sort(sortByDue)[0] ?? null;
}

// ─── Triage group component ───────────────────────────────────────────────────

interface TriageGroupBlockProps {
  group: TriageGroup;
  tasks: FpTask[];
  onToggle: (taskId: string) => void;
  onOpen: (cardId: string) => void;
  deck: ReturnType<typeof useDeck>['data'];
}

function TriageGroupBlock({ group, tasks, onToggle, onOpen, deck }: TriageGroupBlockProps) {
  const [laterOpen, setLaterOpen] = useState(false);

  if (tasks.length === 0) return null;

  const isOverdue = group === 'OVERDUE';
  const isLater = group === 'LATER';
  const label = group;

  return (
    <div className="triage-group">
      <GroupLabel label={label} count={tasks.length} urgent={isOverdue} />
      {isLater && !laterOpen ? (
        <button
          className="later-toggle mono up-s"
          onClick={() => setLaterOpen(true)}
        >
          ▸ SHOW {tasks.length} LATER / UNDATED
        </button>
      ) : (
        <div className="tlist">
          {tasks.map((task) => {
            const card = deck?.find((c) => c.id === task.cardId) ?? undefined;
            return (
              <TaskRow
                key={task.id}
                task={task}
                card={card}
                onToggle={() => onToggle(task.id)}
                onOpen={task.cardId ? () => onOpen(task.cardId!) : undefined}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type ViewMode = 'triage' | 'all' | 'done';

export default function InboxPage() {
  const navigate = useNavigate();
  const now = new Date();

  const [mode, setMode] = useState<ViewMode>('triage');
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [calMonth, setCalMonth] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });

  const connection = useConnection();
  const deckQuery = useDeck();
  const { data: deck } = deckQuery;
  const tasksQuery = useDeckTasks();
  const completedQuery = useCompletedTasks(14);
  const completed7Query = useCompletedTasks(7);
  const closeTask = useCloseTask();
  const reopenTask = useReopenTask();

  // ─── Derived data ──────────────────────────────────────────────────────────

  const openTasks = tasksQuery.data ?? [];
  const completedTasks = completedQuery.data ?? [];
  const completed7 = completed7Query.data ?? [];

  // Group open tasks for triage
  const grouped = useMemo(() => {
    const groups: Record<TriageGroup, FpTask[]> = {
      OVERDUE: [],
      TODAY: [],
      'THIS WEEK': [],
      LATER: [],
    };
    for (const task of openTasks) {
      groups[getTriageGroup(task, now)].push(task);
    }
    // Sort each group by due
    for (const g of Object.keys(groups) as TriageGroup[]) {
      groups[g].sort(sortByDue);
    }
    return groups;
  }, [openTasks, now.toDateString()]);

  // All open tasks sorted by due
  const allSorted = useMemo(() => [...openTasks].sort(sortByDue), [openTasks]);

  // Calendar pips from open tasks
  const pips = useMemo(() => buildPips(openTasks, now), [openTasks, now.toDateString()]);

  // NEXT UP: soonest task
  const nextUp = useMemo(() => findNextUp(openTasks, now), [openTasks, now.toDateString()]);

  // Stats
  const overdueCount = grouped.OVERDUE.length;
  const totalCards = deck
    ? new Set(openTasks.map((t) => t.cardId).filter(Boolean)).size
    : 0;

  // Kicker date
  const kickerDate = format(now, 'EEE MMM d').toUpperCase();

  // ─── Handlers ─────────────────────────────────────────────────────────────

  function handleToggle(taskId: string) {
    if (mode === 'done') {
      reopenTask.mutate(taskId);
    } else {
      closeTask.mutate(taskId);
    }
  }

  function handleOpen(cardId: string) {
    navigate(`/card/${cardId}`);
  }

  // ─── Status guards ─────────────────────────────────────────────────────────

  if (connection.status === 'no-token') {
    return (
      <div className="view">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <LoadState status="no-token" />
        </div>
      </div>
    );
  }

  // Fold deck + connection states into the loading/error guards.
  // useDeckTasks is disabled (idle/isPending without isFetching) while the deck
  // is still resolving, so we must check deckQuery independently:
  //   • deck loading (or connection 'checking') → show loading state
  //   • deck error OR connection 'error'         → show error state
  const isLoading =
    connection.status === 'checking' ||
    deckQuery.isLoading ||
    tasksQuery.isLoading ||
    (mode === 'done' && completedQuery.isLoading);
  const isError =
    connection.status === 'error' ||
    deckQuery.isError ||
    tasksQuery.isError ||
    (mode === 'done' && completedQuery.isError);

  // ─── NEXT UP meta line ─────────────────────────────────────────────────────

  function nextUpMeta(task: FpTask): string {
    const card = deck?.find((c) => c.id === task.cardId);
    const cardName = card?.name.toUpperCase() ?? '—';
    const dl = dueLabel(task, now);
    const parts = [cardName, dl.main];
    if (task.due?.isRecurring && task.due.string) {
      parts.push('⟳ ' + task.due.string.toUpperCase());
    }
    return parts.join(' · ');
  }

  // ─── RENDER ────────────────────────────────────────────────────────────────

  const segOptions = [
    { key: 'triage', label: 'Triage' },
    { key: 'all', label: 'All' },
    { key: 'done', label: 'Done' },
  ];

  return (
    <div className="view">
      {/* ── View Head ───────────────────────────────────────────────────────── */}
      <div className="view-head">
        <div>
          <div className="kicker">
            <span className="tick" />
            <span className="kicker-text">TRIAGE INBOX · {kickerDate}</span>
          </div>
          <div className="view-title">What needs attention</div>
          <div className="view-sub mono" style={{ fontFamily: 'inherit', fontStyle: 'normal' }}>
            {isLoading
              ? 'Loading…'
              : `${openTasks.length} open across ${totalCards} cards · ${overdueCount} overdue`}
          </div>
        </div>
        <div className="toolrow">
          <Seg
            options={segOptions}
            value={mode}
            onChange={(k) => setMode(k as ViewMode)}
          />
          <button
            className="btn coral"
            onClick={() => setQuickAddOpen(true)}
          >
            + Task
          </button>
        </div>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="inbox-body">
        {/* ── Main scrollable area ─────────────────────────────────────────── */}
        <div className="inbox-scroll">
          {isLoading ? (
            <LoadState status="loading" />
          ) : isError ? (
            <LoadState
              status="error"
              message="Could not load tasks from Todoist"
              retry={() => {
                void tasksQuery.refetch();
                if (mode === 'done') void completedQuery.refetch();
              }}
            />
          ) : mode === 'triage' ? (
            <>
              {overdueCount === 0 &&
               grouped.TODAY.length === 0 &&
               grouped['THIS WEEK'].length === 0 &&
               grouped.LATER.length === 0 ? (
                <div className="inbox-all-clear">
                  <div className="ac-mark">◆ ALL CLEAR ◆</div>
                  <div className="ac-sub">No tasks need attention right now</div>
                </div>
              ) : (
                <>
                  <TriageGroupBlock
                    group="OVERDUE"
                    tasks={grouped.OVERDUE}
                    onToggle={handleToggle}
                    onOpen={handleOpen}
                    deck={deck}
                  />
                  <TriageGroupBlock
                    group="TODAY"
                    tasks={grouped.TODAY}
                    onToggle={handleToggle}
                    onOpen={handleOpen}
                    deck={deck}
                  />
                  <TriageGroupBlock
                    group="THIS WEEK"
                    tasks={grouped['THIS WEEK']}
                    onToggle={handleToggle}
                    onOpen={handleOpen}
                    deck={deck}
                  />
                  <TriageGroupBlock
                    group="LATER"
                    tasks={grouped.LATER}
                    onToggle={handleToggle}
                    onOpen={handleOpen}
                    deck={deck}
                  />
                </>
              )}
            </>
          ) : mode === 'all' ? (
            <>
              {allSorted.length === 0 ? (
                <LoadState status="empty" message="No open tasks" />
              ) : (
                <div className="triage-group">
                  <GroupLabel label="ALL OPEN" count={allSorted.length} />
                  <div className="tlist">
                    {allSorted.map((task) => {
                      const card = deck?.find((c) => c.id === task.cardId) ?? undefined;
                      return (
                        <TaskRow
                          key={task.id}
                          task={task}
                          card={card}
                          onToggle={() => handleToggle(task.id)}
                          onOpen={task.cardId ? () => handleOpen(task.cardId!) : undefined}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Done mode */
            <>
              {completedTasks.length === 0 ? (
                <LoadState status="empty" message="No completed tasks in last 14 days" />
              ) : (
                <div className="triage-group">
                  <GroupLabel label="DONE · LAST 14 DAYS" count={completedTasks.length} />
                  <div className="tlist">
                    {completedTasks.map((task) => {
                      const card = deck?.find((c) => c.id === task.cardId) ?? undefined;
                      return (
                        <TaskRow
                          key={task.id}
                          task={task}
                          card={card}
                          onToggle={() => reopenTask.mutate(task.id)}
                          onOpen={task.cardId ? () => handleOpen(task.cardId!) : undefined}
                        />
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* ── Peek aside ───────────────────────────────────────────────────── */}
        <aside className="peek">
          {/* Calendar header label */}
          <div className="peek-label mono up">
            <span>UPCOMING</span>
          </div>

          {/* Mini calendar */}
          <MiniCalendar
            month={calMonth}
            pips={pips}
            onPrev={() => {
              setCalMonth((m) => {
                const d = new Date(m);
                d.setMonth(d.getMonth() - 1);
                return d;
              });
            }}
            onNext={() => {
              setCalMonth((m) => {
                const d = new Date(m);
                d.setMonth(d.getMonth() + 1);
                return d;
              });
            }}
          />

          {/* NEXT UP */}
          <div className="peek-label mono up" style={{ marginTop: 4 }}>
            <span>NEXT UP</span>
          </div>
          {nextUp ? (
            <div className="nextcard">
              <div className="nm">{nextUp.content}</div>
              <div className="mt mono up-s">{nextUpMeta(nextUp)}</div>
              <button
                className="btn ghost"
                style={{ marginTop: 13, width: '100%', justifyContent: 'center' }}
                onClick={() => closeTask.mutate(nextUp.id)}
              >
                Mark done
              </button>
            </div>
          ) : (
            <div
              className="nextcard"
              style={{ color: 'var(--ink-3)', fontSize: 12, fontFamily: 'JetBrains Mono, monospace' }}
            >
              NO PENDING TASKS
            </div>
          )}

          {/* LOAD · THIS WEEK */}
          <div className="peek-label mono up" style={{ marginTop: 4 }}>
            <span>LOAD · THIS WEEK</span>
          </div>
          <Stats
            items={[
              { v: openTasks.length, k: 'open' },
              { v: overdueCount, k: 'overdue', coral: overdueCount > 0 },
              { v: completed7.length, k: 'done 7d' },
            ]}
            small
          />
        </aside>
      </div>

      {/* ── QuickAdd modal ───────────────────────────────────────────────────── */}
      <QuickAdd
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
      />
    </div>
  );
}
