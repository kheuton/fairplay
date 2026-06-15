/**
 * FAIRPLAY · Shared atom components.
 * Full implementation matching the prototype markup/classes.
 */
import React from 'react';
import { format, getDaysInMonth, startOfMonth, getDay } from 'date-fns';
import type { FpTask, CardDef } from '../lib/types';
import { dueLabel } from '../lib/format';

// ─── TaskRow ────────────────────────────────────────────────────────────────

interface TaskRowProps {
  task: FpTask;
  card?: CardDef;
  dense?: boolean;
  onToggle: () => void;
  onOpen?: () => void;
}

export function TaskRow({ task, card, onToggle, onOpen }: TaskRowProps) {
  const dl = dueLabel(task);
  const isRecurring = task.due?.isRecurring ?? false;
  const isDone = task.isCompleted;

  return (
    <div
      className={`trow${isDone ? ' done' : ''}${dl.over ? ' urgent' : ''}`}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
    >
      {/* Checkbox — round for recurring, square otherwise */}
      <button
        type="button"
        role="checkbox"
        aria-checked={isDone}
        aria-label={`Mark "${task.content}" ${isDone ? 'not done' : 'done'}`}
        className={`chk${isRecurring ? ' recur' : ''}${isDone ? ' done' : ''}`}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}
      />

      {/* Main content: task name only */}
      <div className="t-main">
        <div className="t-name">{task.content}</div>
      </div>

      {/* Card tag column (auto width) */}
      {card ? (
        <span className="tag">
          <span
            className="sw"
            style={{ background: card.color ?? 'var(--ink-4)' }}
          />
          <span className="up-s">{card.name}</span>
        </span>
      ) : (
        <span />
      )}

      {/* Due date */}
      <div className={`due${dl.over ? ' over' : ''}`}>
        {dl.main}
        {dl.sub && <span className="d2">{dl.sub}</span>}
      </div>

      {/* Recur glyph */}
      <div className={`recur-i${isRecurring ? ' on' : ''}`}>
        {isRecurring ? '⟳' : '·'}
      </div>
    </div>
  );
}

// ─── SideTaskRow ─────────────────────────────────────────────────────────────

interface SideTaskRowProps {
  task: FpTask;
  right?: React.ReactNode;
  onToggle: () => void;
}

export function SideTaskRow({ task, right, onToggle }: SideTaskRowProps) {
  const isRecurring = task.due?.isRecurring ?? false;
  return (
    <div className="trow" style={{ gridTemplateColumns: '24px 1fr auto' }}>
      <button
        type="button"
        role="checkbox"
        aria-checked={task.isCompleted}
        aria-label={`Mark "${task.content}" ${task.isCompleted ? 'not done' : 'done'}`}
        className={`chk${isRecurring ? ' recur' : ''}${task.isCompleted ? ' done' : ''}`}
        onClick={onToggle}
      />
      <div className="t-main">
        <div className="t-name">{task.content}</div>
      </div>
      {right !== undefined ? <div>{right}</div> : <div />}
    </div>
  );
}

// ─── Stp (Stepper) ──────────────────────────────────────────────────────────

interface StpProps {
  label: string;
  dec: () => void;
  inc: () => void;
}

export function Stp({ label, dec, inc }: StpProps) {
  return (
    <div className="stp">
      <button onClick={dec}>−</button>
      <span className="mono">{label}</span>
      <button onClick={inc}>+</button>
    </div>
  );
}

// ─── StpNum (Editable numeric stepper) ──────────────────────────────────────

interface StpNumProps {
  value: number;
  /**
   * Called when the − button is clicked.  Receives the current effective
   * numeric base (draft value when the user is mid-edit, otherwise `value`)
   * so the step can be applied to whatever the user has already typed.
   */
  dec: (base: number) => void;
  /**
   * Called when the + button is clicked.  Same semantics as `dec`.
   */
  inc: (base: number) => void;
  /** Commit a directly-typed (and parsed) value. */
  onCommit: (n: number) => void;
  /** Clamp bounds for typed input. */
  min?: number;
  max?: number;
  /** Display formatter for the committed value (default String). */
  format?: (n: number) => string;
}

export function StpNum({ value, dec, inc, onCommit, min = 0, max = 9999, format }: StpNumProps) {
  const display = format ? format(value) : String(value);
  // draft===null means "not editing, mirror the prop"; a string means an in-progress edit.
  const [draft, setDraft] = React.useState<string | null>(null);
  const text = draft ?? display;

  // Ref that suppresses the next blur→commit when Escape was pressed.
  const cancelRef = React.useRef(false);

  // When the prop value changes (server round-trip lands), clear the draft if it
  // still matches what we committed — this bridges the optimistic gap and prevents
  // "committed value flashes back to stale prop" flicker.
  React.useEffect(() => {
    setDraft(null);
  }, [value]);

  const commit = () => {
    if (cancelRef.current) {
      cancelRef.current = false;
      setDraft(null);
      return;
    }
    if (draft === null) return;
    const n = parseFloat(draft);
    if (Number.isFinite(n)) {
      const clamped = Math.min(max, Math.max(min, n));
      // Keep the committed string as draft until the new `value` prop arrives,
      // so the field doesn't revert to the old number during network latency.
      setDraft(String(clamped));
      onCommit(clamped);
    } else {
      setDraft(null); // invalid input — revert to prop
    }
  };

  // Resolve the current numeric base for step operations: use draft when editing
  // so that clicking +/- after typing doesn't silently discard the typed value.
  const draftNum = draft !== null ? parseFloat(draft) : NaN;
  const stepBase = Number.isFinite(draftNum) ? draftNum : value;

  return (
    <div className="stp">
      <button type="button" onClick={() => { setDraft(null); dec(stepBase); }}>−</button>
      <input
        className="stp-in mono"
        type="text"
        inputMode="decimal"
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          else if (e.key === 'Escape') {
            cancelRef.current = true;
            setDraft(null);
            e.currentTarget.blur();
          }
        }}
      />
      <button type="button" onClick={() => { setDraft(null); inc(stepBase); }}>+</button>
    </div>
  );
}

// ─── Chip ────────────────────────────────────────────────────────────────────

interface ChipProps {
  status: 'ok' | 'low' | 'out';
  children: React.ReactNode;
}

export function Chip({ status, children }: ChipProps) {
  return (
    <span className={`chip ${status} mono up`}>
      {children}
    </span>
  );
}

// ─── Seg ─────────────────────────────────────────────────────────────────────

interface SegOption {
  key: string;
  label: string;
}

interface SegProps {
  options: SegOption[];
  value: string;
  onChange: (key: string) => void;
}

export function Seg({ options, value, onChange }: SegProps) {
  return (
    <div className="seg">
      {options.map((opt) => (
        <button
          key={opt.key}
          className={value === opt.key ? 'on' : ''}
          onClick={() => onChange(opt.key)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ─── GroupLabel ──────────────────────────────────────────────────────────────

interface GroupLabelProps {
  label: string;
  count?: number;
  urgent?: boolean;
}

export function GroupLabel({ label, count, urgent }: GroupLabelProps) {
  return (
    <div className={`grp mono up${urgent ? ' urgent' : ''}`}>
      <span>{urgent ? '◆ ' + label : label}</span>
      <span className="ln" />
      {count !== undefined && (
        <span>{String(count).padStart(2, '0')}</span>
      )}
    </div>
  );
}

// ─── Stats ───────────────────────────────────────────────────────────────────

interface StatItem {
  v: React.ReactNode;
  k: string;
  coral?: boolean;
}

interface StatsProps {
  items: StatItem[];
  small?: boolean;
}

export function Stats({ items, small }: StatsProps) {
  return (
    <div className={`stats${small ? ' small' : ''}`}>
      {items.map((item, i) => (
        <div key={i} className="stat">
          <div className={`v${item.coral ? ' coral' : ''}`}>{item.v}</div>
          <div className="k mono up">{item.k}</div>
        </div>
      ))}
    </div>
  );
}

// ─── MiniCalendar ────────────────────────────────────────────────────────────

interface MiniCalendarProps {
  month: Date;
  pips: Record<string, 'normal' | 'urgent'>;
  onPrev?: () => void;
  onNext?: () => void;
}

export function MiniCalendar({ month, pips, onPrev, onNext }: MiniCalendarProps) {
  const year = month.getFullYear();
  const mon = month.getMonth();

  // date-fns: getDay returns 0=Sun, startOfMonth gives us first day
  const firstDow = getDay(startOfMonth(month)); // 0=Sun
  const daysInMon = getDaysInMonth(month);

  const pad2 = (n: number) => String(n).padStart(2, '0');
  const toKey = (d: number) => `${year}-${pad2(mon + 1)}-${pad2(d)}`;

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;

  const DOW = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  const monthStr = format(month, 'MMM yyyy').toUpperCase();

  const cells: React.ReactNode[] = [];
  // Leading blank cells
  for (let i = 0; i < firstDow; i++) {
    cells.push(<div key={`b${i}`} className="cal-day muted" />);
  }
  // Day cells
  for (let d = 1; d <= daysInMon; d++) {
    const key = toKey(d);
    const pip = pips[key];
    const isToday = key === todayKey;
    cells.push(
      <div key={key} className={`cal-day${isToday ? ' today' : ''}`}>
        {pad2(d)}
        {pip && <span className={`pip${pip === 'urgent' ? ' urgent' : ''}`} />}
      </div>
    );
  }

  return (
    <div className="cal">
      {(onPrev || onNext) && (
        <div className="peek-label mono up" style={{ marginBottom: 4 }}>
          {onPrev ? (
            <span
              style={{ cursor: 'pointer', color: 'var(--ink-3)', padding: '0 4px' }}
              onClick={onPrev}
            >
              ‹
            </span>
          ) : <span />}
          <span>{monthStr}</span>
          {onNext ? (
            <span
              style={{ cursor: 'pointer', color: 'var(--ink-3)', padding: '0 4px' }}
              onClick={onNext}
            >
              ›
            </span>
          ) : <span />}
        </div>
      )}
      <div className="cal-grid">
        {DOW.map((d, i) => (
          <div key={i} className="cal-dow mono">{d}</div>
        ))}
        {cells}
      </div>
    </div>
  );
}

// ─── LoadState ───────────────────────────────────────────────────────────────

interface LoadStateProps {
  status: 'loading' | 'error' | 'empty' | 'no-token';
  message?: string;
  retry?: () => void;
}

export function LoadState({ status, message, retry }: LoadStateProps) {
  let label: string;
  let sub: string | undefined;

  switch (status) {
    case 'loading':
      label = 'SYNCING ▸';
      break;
    case 'error':
      label = 'LINK DOWN · RETRY';
      sub = message;
      break;
    case 'no-token':
      label = 'NO LINK · ADD TOKEN IN SETTINGS';
      break;
    case 'empty':
      label = 'NOTHING HERE';
      sub = message;
      break;
  }

  return (
    <div className="ph">
      <div className="lbl mono up">{label}</div>
      {sub && <div className="sub mono">{sub}</div>}
      {retry && status === 'error' && (
        <button className="btn ghost" style={{ marginTop: 12 }} onClick={retry}>
          RETRY
        </button>
      )}
    </div>
  );
}
