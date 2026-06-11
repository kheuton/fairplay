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
