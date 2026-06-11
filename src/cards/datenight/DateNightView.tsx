/**
 * FAIRPLAY · DateNightView
 * Date-night planner for the Marriage & romance card (kind 'datenight').
 * Stage = full-month calendar with task entry chips.
 * Side = IDEA POOL (tasks with no due date) + scheduling interaction.
 */
import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  parseISO,
  differenceInCalendarDays,
  addMonths,
  subMonths,
  isToday,
} from 'date-fns';
import type { CardDef, FpTask } from '../../lib/types';
import {
  useCardTasks,
  useCloseTask,
  useUpdateTask,
  useCreateTask,
  useConnection,
} from '../../lib/todoist/hooks';
import { LoadState } from '../../shell/atoms';
import { QuickAdd } from '../../shell/QuickAdd';
import { CharterPanel } from '../../shell/CharterPanel';
import './datenight.css';

interface Props {
  card: CardDef;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

const DOW_LABELS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Days until the next scheduled date (task with due date >= today, min remaining). */
function nextDateInfo(scheduled: FpTask[]): { days: number; isTonight: boolean } | null {
  const today = new Date();
  const todayKey = toDateKey(today);

  let min: number | null = null;
  for (const t of scheduled) {
    if (!t.due) continue;
    const diff = differenceInCalendarDays(parseISO(t.due.date), today);
    if (diff >= 0 && (min === null || diff < min)) min = diff;
    // also treat today's date-only due as 0
    if (t.due.date === todayKey) min = 0;
  }

  if (min === null) return null;
  return { days: min, isTonight: min === 0 };
}

// ─── Popover component ───────────────────────────────────────────────────────

interface PopoverProps {
  task: FpTask;
  anchorRect: DOMRect;
  onClose: () => void;
  onDone: () => void;
  onBackToPool: () => void;
}

function EntryPopover({ task, anchorRect, onClose, onDone, onBackToPool }: PopoverProps) {
  const popRef = useRef<HTMLDivElement>(null);

  // Position below the chip, clamped to viewport
  const style: React.CSSProperties = {
    top: anchorRect.bottom + 6,
    left: anchorRect.left,
  };

  // Escape closes
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const dueStr = task.due
    ? format(parseISO(task.due.date), 'EEE, MMM d')
    : '';

  return (
    <>
      <div className="dn-popover-backdrop" onClick={onClose} />
      <div className="dn-popover" style={style} ref={popRef}>
        <div className="dn-pop-name">{task.content}</div>
        {dueStr && (
          <div className="dn-pop-due mono up-s">{dueStr}</div>
        )}
        <div className="dn-pop-actions">
          <button className="dn-pop-done" onClick={onDone}>
            DONE
          </button>
          <button onClick={onBackToPool}>
            BACK TO POOL
          </button>
        </div>
      </div>
    </>
  );
}

// ─── DateNightView ───────────────────────────────────────────────────────────

export default function DateNightView({ card }: Props) {
  const connection = useConnection();
  const tasksQuery = useCardTasks(card.id);
  const { data: tasks, isLoading, isError, error, refetch } = tasksQuery;
  const closeTask = useCloseTask();
  const updateTask = useUpdateTask();
  const createTask = useCreateTask();

  // Calendar month navigation
  const [month, setMonth] = useState<Date>(() => startOfMonth(new Date()));

  // Armed idea: id of the idea being scheduled
  const [armedId, setArmedId] = useState<string | null>(null);

  // Popover state
  const [popTask, setPopTask] = useState<FpTask | null>(null);
  const [popRect, setPopRect] = useState<DOMRect | null>(null);

  // Inline idea add
  const [addText, setAddText] = useState('');
  const addInputRef = useRef<HTMLInputElement>(null);

  // QuickAdd modal
  const [quickAddOpen, setQuickAddOpen] = useState(false);

  // Escape disarms
  useEffect(() => {
    if (!armedId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setArmedId(null);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [armedId]);

  // ── derived data ──────────────────────────────────────────────────────────

  const scheduled = (tasks ?? []).filter((t) => !!t.due);
  const ideas = (tasks ?? []).filter((t) => !t.due);

  const nextInfo = nextDateInfo(scheduled);

  // Build a map: date-key -> tasks
  const byDay = new Map<string, FpTask[]>();
  for (const t of scheduled) {
    if (!t.due) continue;
    const key = t.due.date;
    const arr = byDay.get(key) ?? [];
    arr.push(t);
    byDay.set(key, arr);
  }

  // Calendar cells
  const monthStart = startOfMonth(month);
  const monthEnd = endOfMonth(month);

  // Leading blanks (Sun=0)
  const leadingBlanks = getDay(monthStart);

  // All days in month
  const daysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });

  // ── handlers ─────────────────────────────────────────────────────────────

  const handleDayClick = useCallback(
    (day: Date) => {
      if (!armedId) return;
      const dateStr = toDateKey(day);
      updateTask.mutate({ id: armedId, patch: { due: dateStr } });
      setArmedId(null);
    },
    [armedId, updateTask]
  );

  const handleChipClick = useCallback(
    (e: React.MouseEvent, task: FpTask) => {
      e.stopPropagation();
      setPopTask(task);
      setPopRect((e.currentTarget as HTMLElement).getBoundingClientRect());
    },
    []
  );

  const handleDone = useCallback(() => {
    if (!popTask) return;
    closeTask.mutate(popTask.id);
    setPopTask(null);
  }, [popTask, closeTask]);

  const handleBackToPool = useCallback(() => {
    if (!popTask) return;
    updateTask.mutate({ id: popTask.id, patch: { due: null } });
    setPopTask(null);
  }, [popTask, updateTask]);

  const handleIdeaClick = useCallback(
    (task: FpTask) => {
      if (armedId === task.id) {
        setArmedId(null);
      } else {
        setArmedId(task.id);
      }
    },
    [armedId]
  );

  const handleAddIdea = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      const name = addText.trim();
      if (!name) return;
      createTask.mutate({ content: name, cardId: card.id });
      setAddText('');
    },
    [addText, card.id, createTask]
  );

  // ── status rendering ──────────────────────────────────────────────────────

  if (connection.status === 'no-token') {
    return (
      <div className="view">
        <ViewHead card={card} nextInfo={null} ideaCount={0} />
        <CharterPanel card={card} />
        <div className="view-body" style={{ display: 'flex' }}>
          <LoadState status="no-token" />
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="view">
        <ViewHead card={card} nextInfo={null} ideaCount={0} />
        <CharterPanel card={card} />
        <div className="view-body" style={{ display: 'flex' }}>
          <LoadState status="loading" />
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="view">
        <ViewHead card={card} nextInfo={null} ideaCount={0} />
        <CharterPanel card={card} />
        <div className="view-body" style={{ display: 'flex' }}>
          <LoadState
            status="error"
            message={error instanceof Error ? error.message : String(error)}
            retry={() => void refetch()}
          />
        </div>
      </div>
    );
  }

  const monthLabel = format(month, 'MMM yyyy').toUpperCase();
  const todayKey = toDateKey(new Date());

  return (
    <>
      <div className="view">
        <ViewHead card={card} nextInfo={nextInfo} ideaCount={ideas.length} />
        <CharterPanel card={card} />

        <div className="bespoke">
          {/* ── STAGE: calendar ── */}
          <div className="stage dn-stage">
            {/* corner ticks */}
            <div className="tick-c tl" />
            <div className="tick-c tr" />
            <div className="tick-c bl" />
            <div className="tick-c br" />

            <div className="stage-head dn-stage-head-inner">
              <span className="lbl">CALENDAR · {monthLabel}</span>
              <div className="dn-month-nav">
                <button
                  aria-label="Previous month"
                  onClick={() => setMonth((m) => subMonths(m, 1))}
                >
                  ‹
                </button>
                <span className="dn-month-label">{monthLabel}</span>
                <button
                  aria-label="Next month"
                  onClick={() => setMonth((m) => addMonths(m, 1))}
                >
                  ›
                </button>
              </div>
            </div>

            <div className="dn-cal-scroll">
              <div className="dn-cal">
                {/* Day-of-week headers */}
                <div className="dn-cal-header">
                  {DOW_LABELS.map((d) => (
                    <div key={d} className="dn-cal-dow mono up-s">{d}</div>
                  ))}
                </div>

                {/* Calendar body */}
                <div className="dn-cal-body">
                  {/* Leading blanks */}
                  {Array.from({ length: leadingBlanks }, (_, i) => (
                    <div key={`blank-${i}`} className="dn-cal-cell dn-other-month" />
                  ))}

                  {/* Day cells */}
                  {daysInMonth.map((day) => {
                    const key = toDateKey(day);
                    const isCurrentDay = isToday(day);
                    const dayTasks = byDay.get(key) ?? [];
                    const isArmedDay = armedId !== null;

                    let cellClass = 'dn-cal-cell';
                    if (isCurrentDay) cellClass += ' dn-today';
                    if (isArmedDay) cellClass += ' dn-armed';

                    return (
                      <div
                        key={key}
                        className={cellClass}
                        onClick={() => handleDayClick(day)}
                        title={isArmedDay ? 'Schedule idea on this date' : undefined}
                      >
                        <div className="dn-day-num mono">{pad2(day.getDate())}</div>
                        {dayTasks.map((t) => {
                          const isOver = differenceInCalendarDays(parseISO(t.due!.date), new Date()) < 0;
                          let chipClass = 'dn-entry-chip';
                          if (isOver) chipClass += ' dn-chip-over';
                          return (
                            <div
                              key={t.id}
                              className={chipClass}
                              onClick={(e) => handleChipClick(e, t)}
                              title={t.content}
                            >
                              <span className="dn-chip-name">{t.content}</span>
                              {t.due?.isRecurring && (
                                <span className="dn-chip-recur">⟳</span>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="stage-foot">
              <span>FAIRPLAY · {card.num}</span>
              <span>DATES · {scheduled.length} SCHEDULED</span>
            </div>
          </div>

          {/* ── SIDE: idea pool ── */}
          <div className="bespoke-side">
            <div className="bs-head dn-side-head">
              <div className="dn-side-title mono up">IDEA POOL</div>

              {armedId && (
                <div
                  className="dn-sched-chip"
                  onClick={() => setArmedId(null)}
                  title="Click to disarm"
                >
                  <span>SCHEDULING · PICK A NIGHT</span>
                  <span className="x">×</span>
                </div>
              )}
            </div>

            <div className="bs-list dn-pool-list">
              {ideas.length === 0 ? (
                <div className="dn-pool-empty">
                  THE POOL IS DRY<br />
                  ADD AN IDEA BELOW
                </div>
              ) : (
                ideas.map((task) => {
                  const isArmed = armedId === task.id;
                  return (
                    <div
                      key={task.id}
                      className={`dn-idea-row${isArmed ? ' dn-armed-row' : ''}`}
                      onClick={() => handleIdeaClick(task)}
                      title={isArmed ? 'Click a calendar night to schedule, or click here to disarm' : 'Click to schedule'}
                    >
                      <div className="dn-idea-dot" />
                      <div className="dn-idea-body">
                        <div className="dn-idea-name">{task.content}</div>
                        {task.description && (
                          <div className="dn-idea-note">{task.description}</div>
                        )}
                      </div>
                    </div>
                  );
                })
              )}

              {/* Inline idea add */}
              <form
                className={`dn-add-idea${addText ? ' dn-add-active' : ''}`}
                onSubmit={handleAddIdea}
                style={{ marginTop: 12 }}
              >
                <input
                  ref={addInputRef}
                  value={addText}
                  onChange={(e) => setAddText(e.target.value)}
                  placeholder="+ IDEA"
                  autoComplete="off"
                  aria-label="Add idea to pool"
                />
                {addText && (
                  <button type="submit" disabled={createTask.isPending}>
                    {createTask.isPending ? '...' : 'ADD'}
                  </button>
                )}
              </form>
            </div>

            <div className="dn-side-actions">
              <button
                className="btn ghost"
                style={{ fontSize: 10 }}
                onClick={() => setQuickAddOpen(true)}
              >
                + TASK
              </button>
            </div>
          </div>
        </div>
      </div>


      {/* Entry popover */}
      {popTask && popRect && (
        <EntryPopover
          task={popTask}
          anchorRect={popRect}
          onClose={() => setPopTask(null)}
          onDone={handleDone}
          onBackToPool={handleBackToPool}
        />
      )}

      {/* QuickAdd modal */}
      <QuickAdd
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        presetCardId={card.id}
      />
    </>
  );
}

// ─── ViewHead ────────────────────────────────────────────────────────────────

interface ViewHeadProps {
  card: CardDef;
  nextInfo: { days: number; isTonight: boolean } | null;
  ideaCount: number;
}

function ViewHead({ card, nextInfo, ideaCount }: ViewHeadProps) {
  const isTonight = nextInfo?.isTonight ?? false;

  let nextLabel: string;
  let nextSub: string;
  let nextCoral = false;

  if (!nextInfo) {
    nextLabel = '—';
    nextSub = 'NEXT DATE';
  } else if (isTonight) {
    nextLabel = 'TONIGHT';
    nextSub = 'NEXT DATE';
    nextCoral = true;
  } else {
    nextLabel = `IN ${nextInfo.days} DAY${nextInfo.days === 1 ? '' : 'S'}`;
    nextSub = 'NEXT DATE';
  }

  return (
    <div className="view-head">
      <div>
        <div className="kicker">
          <span className="tick" />
          <span className="mono up-s">
            {card.num} · CARD · {card.category} · CUSTOM VIEW ◆
          </span>
        </div>
        <div className="view-title">{card.name}</div>
      </div>

      <div className="head-meta">
        <div className={`big mono${nextCoral ? ' coral' : ''}`}>
          {nextLabel}
        </div>
        <div className="mono">{nextSub}</div>
        <div className="mono" style={{ marginTop: 8 }}>
          {ideaCount} {ideaCount === 1 ? 'IDEA' : 'IDEAS'} IN POOL
        </div>
      </div>
    </div>
  );
}
