/**
 * FAIRPLAY · TimelineView
 * Default card page for kind='timeline'. Modes: Timeline / List / Done.
 *
 * Timeline mode: tasks sorted by due date, grouped under mono month labels
 * with vertical rail + node dots. Undated tasks go under 'UNSCHEDULED'.
 * Checkbox closes tasks (optimistic); recurring tasks advance on settle.
 *
 * List mode: flat TaskRow list sorted by due.
 * Done mode: completed tasks for this card (last 30 days), reopen on toggle.
 */
import React, { useState, useMemo } from 'react';
import {
  parseISO,
  isToday,
  isPast,
  format,
  getHours,
  compareAsc,
} from 'date-fns';
import type { CardDef, FpTask } from '../../lib/types';
import {
  useCardTasks,
  useCompletedTasks,
  useCloseTask,
  useReopenTask,
} from '../../lib/todoist/hooks';
import { useConnection } from '../../lib/todoist/hooks';
import { monthLabel } from '../../lib/format';
import { Seg, TaskRow, LoadState, GroupLabel } from '../../shell/atoms';
import { QuickAdd } from '../../shell/QuickAdd';
import { CharterPanel } from '../../shell/CharterPanel';
import './timeline.css';

// ─── Types ────────────────────────────────────────────────────────────────────

type Mode = 'timeline' | 'list' | 'done';

const SEG_OPTIONS = [
  { key: 'timeline', label: 'Timeline' },
  { key: 'list',     label: 'List' },
  { key: 'done',     label: 'Done' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** True if a task is overdue (has a date in the past and not completed). */
function isOverdue(task: FpTask): boolean {
  if (!task.due) return false;
  try {
    const d = parseISO(task.due.datetime ?? task.due.date);
    return isPast(d) && !isToday(d);
  } catch {
    return false;
  }
}

/** True if a task is due today and marked priority 1 or 2 (urgent). */
function isTodayUrgent(task: FpTask): boolean {
  if (!task.due) return false;
  try {
    const d = parseISO(task.due.datetime ?? task.due.date);
    return isToday(d) && (task.priority === 1 || task.priority === 2);
  } catch {
    return false;
  }
}

/**
 * Returns true if the task node dot should render as "urgent" (filled accent):
 * overdue OR today with high priority.
 */
function isUrgentDot(task: FpTask): boolean {
  return isOverdue(task) || isTodayUrgent(task);
}

/**
 * Get a displayable date string for the timeline date column.
 * Returns 'TONIGHT' for today-evening items, overdue date, or formatted date.
 */
function tlDateLabel(task: FpTask): { label: string; over: boolean; tonight: boolean } {
  if (!task.due) return { label: '—', over: false, tonight: false };
  try {
    const d = parseISO(task.due.datetime ?? task.due.date);
    const over = isOverdue(task);

    if (isToday(d)) {
      if (task.due.datetime) {
        const hr = getHours(d);
        if (hr >= 17) {
          return { label: 'TONIGHT', over: false, tonight: true };
        }
        return { label: format(d, 'h:mm aa').toUpperCase(), over: false, tonight: false };
      }
      return { label: 'TONIGHT', over: false, tonight: true };
    }

    if (over) {
      return { label: format(d, 'MMM d').toUpperCase(), over: true, tonight: false };
    }

    return { label: format(d, 'MMM d').toUpperCase(), over: false, tonight: false };
  } catch {
    return { label: task.due.string, over: false, tonight: false };
  }
}

/**
 * Sort tasks: dated first (ascending), then undated.
 * Within dated, overdue tasks sort before upcoming.
 */
function sortTasks(tasks: FpTask[]): FpTask[] {
  return [...tasks].sort((a, b) => {
    const aHasDue = !!a.due;
    const bHasDue = !!b.due;
    if (!aHasDue && !bHasDue) return 0;
    if (!aHasDue) return 1;
    if (!bHasDue) return -1;
    try {
      const da = parseISO(a.due!.datetime ?? a.due!.date);
      const db = parseISO(b.due!.datetime ?? b.due!.date);
      return compareAsc(da, db);
    } catch {
      return 0;
    }
  });
}

/**
 * Group sorted tasks by their month label ('JUN 2026'), keeping undated separate.
 */
interface MonthGroup {
  label: string;   // 'JUN 2026' or 'UNSCHEDULED'
  tasks: FpTask[];
}

function groupByMonth(tasks: FpTask[]): MonthGroup[] {
  const groups: MonthGroup[] = [];
  const monthMap = new Map<string, FpTask[]>();
  const undated: FpTask[] = [];

  for (const task of tasks) {
    if (!task.due) {
      undated.push(task);
      continue;
    }
    try {
      const d = parseISO(task.due.datetime ?? task.due.date);
      const label = monthLabel(d);
      if (!monthMap.has(label)) monthMap.set(label, []);
      monthMap.get(label)!.push(task);
    } catch {
      undated.push(task);
    }
  }

  for (const [label, list] of monthMap) {
    groups.push({ label, tasks: list });
  }

  if (undated.length > 0) {
    groups.push({ label: 'UNSCHEDULED', tasks: undated });
  }

  return groups;
}

/**
 * Build a recurrence display string from a task's due.string.
 * Returns e.g. 'EVERY WK' or 'ONE-OFF'.
 */
function recurLabel(task: FpTask): string {
  if (!task.due?.isRecurring) return 'ONE-OFF';
  const s = task.due.string ?? '';
  return s.toUpperCase() || 'RECURRING';
}

/** Truncate description for meta line. */
function descSnippet(desc: string, maxLen = 48): string {
  const trimmed = desc.trim();
  if (!trimmed) return '';
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen - 1) + '…';
}

// ─── Sub-views ────────────────────────────────────────────────────────────────

interface TimelinePanelProps {
  tasks: FpTask[];
  onClose: (id: string) => void;
}

function TimelinePanel({ tasks, onClose }: TimelinePanelProps) {
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);
  const groups = useMemo(() => groupByMonth(sorted), [sorted]);

  if (sorted.length === 0) {
    return null; // Caller renders empty state
  }

  return (
    <div className="tl-body-wrap">
      <div className="tl">
        {groups.map((group) => (
          <React.Fragment key={group.label}>
            {/* Month header or UNSCHEDULED */}
            <div className="tl-month">{group.label}</div>

            {group.tasks.map((task) => {
              const { label: dateStr, over, tonight } = tlDateLabel(task);
              const urgent = isUrgentDot(task);
              const recur = task.due?.isRecurring ?? false;
              const meta = [recurLabel(task), descSnippet(task.description)]
                .filter(Boolean)
                .join(' · ');

              return (
                <div
                  key={task.id}
                  className={[
                    'tl-item',
                    urgent ? 'urgent' : '',
                    recur ? 'recur' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  <div
                    className={[
                      'tl-date',
                      over ? 'over' : '',
                      tonight ? 'tonight' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {dateStr}
                  </div>

                  <div className="tl-body">
                    <div className="nm">{task.content}</div>
                    {meta && <div className="mt">{meta}</div>}
                  </div>

                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={false}
                    aria-label={`Mark "${task.content}" done`}
                    className={[
                      'chk',
                      recur ? 'recur' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => onClose(task.id)}
                  />
                </div>
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

interface ListPanelProps {
  tasks: FpTask[];
  card: CardDef;
  onClose: (id: string) => void;
}

function ListPanel({ tasks, card, onClose }: ListPanelProps) {
  const sorted = useMemo(() => sortTasks(tasks), [tasks]);

  return (
    <div className="tl-list-wrap">
      <div className="tlist">
        {sorted.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            card={card}
            onToggle={() => onClose(task.id)}
          />
        ))}
      </div>
    </div>
  );
}

interface DonePanelProps {
  cardId: string;
  card: CardDef;
  onReopen: (id: string) => void;
}

function DonePanel({ cardId, card, onReopen }: DonePanelProps) {
  const { data: allCompleted, isLoading, isError, refetch } = useCompletedTasks(30);

  // Hooks must run unconditionally before any early return.
  const tasks = (allCompleted ?? []).filter((t) => t.cardId === cardId);
  const sorted = sortTasks(tasks);

  if (isLoading) {
    return <LoadState status="loading" />;
  }

  if (isError) {
    return (
      <LoadState
        status="error"
        message="Could not load completed tasks"
        retry={() => void refetch()}
      />
    );
  }

  if (sorted.length === 0) {
    return (
      <div className="tl-done-wrap">
        <div className="tl-empty">
          <div className="lbl">No completed tasks in last 30 days</div>
        </div>
      </div>
    );
  }

  return (
    <div className="tl-done-wrap">
      <GroupLabel label="COMPLETED · LAST 30 DAYS" count={sorted.length} />
      <div className="tlist">
        {sorted.map((task) => (
          <TaskRow
            key={task.id}
            task={{ ...task, isCompleted: true }}
            card={card}
            onToggle={() => onReopen(task.id)}
          />
        ))}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface Props {
  card: CardDef;
}

export default function TimelineView({ card }: Props) {
  const [mode, setMode] = useState<Mode>('timeline');
  const [qaOpen, setQaOpen] = useState(false);

  const { status: connStatus } = useConnection();
  const { data: tasks, isLoading, isError, refetch } = useCardTasks(card.id);
  const closeTask = useCloseTask();
  const reopenTask = useReopenTask();

  const openTasks = tasks ?? [];
  const scheduledCount = openTasks.filter((t) => !!t.due).length;

  // ── Loading / error / no-token guards ──
  const handleModeChange = (m: string) => setMode(m as Mode);

  if (connStatus === 'no-token') {
    return (
      <div className="view">
        <ViewHead card={card} scheduledCount={0} mode={mode} onModeChange={handleModeChange} onAddTask={() => setQaOpen(true)} />
        <CharterPanel card={card} />
        <LoadState status="no-token" />
        <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="view">
        <ViewHead card={card} scheduledCount={0} mode={mode} onModeChange={handleModeChange} onAddTask={() => setQaOpen(true)} />
        <CharterPanel card={card} />
        <LoadState status="loading" />
        <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="view">
        <ViewHead card={card} scheduledCount={0} mode={mode} onModeChange={handleModeChange} onAddTask={() => setQaOpen(true)} />
        <CharterPanel card={card} />
        <LoadState
          status="error"
          message="Could not load tasks from Todoist"
          retry={() => void refetch()}
        />
        <QuickAdd open={qaOpen} onClose={() => setQaOpen(false)} presetCardId={card.id} />
      </div>
    );
  }

  // ── Empty state ──
  const isEmpty = openTasks.length === 0 && mode !== 'done';

  return (
    <div className="view">
      <ViewHead
        card={card}
        scheduledCount={scheduledCount}
        mode={mode}
        onModeChange={handleModeChange}
        onAddTask={() => setQaOpen(true)}
      />
      <CharterPanel card={card} />

      {isEmpty ? (
        <div className="tl-empty">
          <div className="lbl">No tasks on this card</div>
          <div className="sub">Use + Task to add one</div>
          <button className="btn coral" onClick={() => setQaOpen(true)}>
            + Task
          </button>
        </div>
      ) : mode === 'timeline' ? (
        <TimelinePanel
          tasks={openTasks}
          onClose={(id) => closeTask.mutate(id)}
        />
      ) : mode === 'list' ? (
        <ListPanel
          tasks={openTasks}
          card={card}
          onClose={(id) => closeTask.mutate(id)}
        />
      ) : (
        <DonePanel
          cardId={card.id}
          card={card}
          onReopen={(id) => reopenTask.mutate(id)}
        />
      )}

      <QuickAdd
        open={qaOpen}
        onClose={() => setQaOpen(false)}
        presetCardId={card.id}
      />
    </div>
  );
}

// ─── ViewHead ─────────────────────────────────────────────────────────────────

interface ViewHeadProps {
  card: CardDef;
  scheduledCount: number;
  mode: Mode;
  onModeChange: (m: string) => void;
  onAddTask: () => void;
}

function ViewHead({ card, scheduledCount, mode, onModeChange, onAddTask }: ViewHeadProps) {
  return (
    <div className="tl-view-head">
      <div className="tl-head-left">
        <div className="kicker">
          <span className="tick" />
          <span className="mono up">CARD · {card.category}</span>
        </div>
        <div className="tl-view-title">{card.name}</div>
        <div className="view-sub">
          {scheduledCount} scheduled · default layout
        </div>
      </div>

      <div className="tl-head-right toolrow">
        <Seg
          options={SEG_OPTIONS}
          value={mode}
          onChange={onModeChange}
        />
        <button className="btn coral" onClick={onAddTask}>
          + Task
        </button>
      </div>
    </div>
  );
}
