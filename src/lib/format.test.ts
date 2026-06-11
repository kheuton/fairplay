import { describe, it, expect } from 'vitest';
import { dueLabel, monthLabel } from './format';
import type { FpTask } from './types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTask(due: FpTask['due']): FpTask {
  return {
    id: 'test',
    content: 'Test task',
    description: '',
    cardId: 'test-card',
    labels: [],
    due,
    priority: 1,
    isCompleted: false,
    url: '',
    meta: {},
  };
}

// Reference date: Wed Jun 11 2026, 10:00 AM local time
const NOW = new Date(2026, 5, 11, 10, 0, 0); // month is 0-indexed

// ─── monthLabel ───────────────────────────────────────────────────────────────

describe('monthLabel', () => {
  it('formats JUN 2026', () => {
    expect(monthLabel(new Date(2026, 5, 1))).toBe('JUN 2026');
  });
  it('formats JAN 2025', () => {
    expect(monthLabel(new Date(2025, 0, 1))).toBe('JAN 2025');
  });
  it('formats DEC 2024', () => {
    expect(monthLabel(new Date(2024, 11, 1))).toBe('DEC 2024');
  });
});

// ─── dueLabel — no due ────────────────────────────────────────────────────────

describe('dueLabel — no due', () => {
  it('returns dash when no due', () => {
    const task = makeTask(null);
    const r = dueLabel(task, NOW);
    expect(r).toEqual({ main: '—', sub: '', over: false });
  });
});

// ─── dueLabel — date only ─────────────────────────────────────────────────────

describe('dueLabel — date only', () => {
  it('today → Tonight', () => {
    const task = makeTask({ date: '2026-06-11', isRecurring: false, string: 'today' });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('Tonight');
    expect(r.over).toBe(false);
  });

  it('tomorrow → Tomorrow + Jun 12', () => {
    const task = makeTask({ date: '2026-06-12', isRecurring: false, string: 'tomorrow' });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('Tomorrow');
    expect(r.sub).toBe('Jun 12');
    expect(r.over).toBe(false);
  });

  it('yesterday → 1 day ago', () => {
    const task = makeTask({ date: '2026-06-10', isRecurring: false, string: 'yesterday' });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('1 day ago');
    expect(r.sub).toBe('was Jun 10');
    expect(r.over).toBe(true);
  });

  it('3 days ago → 3 days ago', () => {
    const task = makeTask({ date: '2026-06-08', isRecurring: false, string: '' });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('3 days ago');
    expect(r.sub).toBe('was Jun 8');
    expect(r.over).toBe(true);
  });

  it('within 7 days → Fri Jun 12 style', () => {
    const task = makeTask({ date: '2026-06-13', isRecurring: false, string: '' });
    const r = dueLabel(task, NOW);
    expect(r.main).toMatch(/Sat Jun 13/);
    expect(r.over).toBe(false);
  });

  it('further out → Jun 26', () => {
    const task = makeTask({ date: '2026-06-26', isRecurring: false, string: '' });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('Jun 26');
    expect(r.over).toBe(false);
  });

  it('recurring task includes recur string as sub', () => {
    const task = makeTask({ date: '2026-06-18', isRecurring: true, string: 'every thursday' });
    const r = dueLabel(task, NOW);
    expect(r.sub).toBe('every thursday');
  });
});

// ─── dueLabel — with datetime ─────────────────────────────────────────────────

describe('dueLabel — with datetime', () => {
  it('today morning → 9:00 AM + today', () => {
    const task = makeTask({
      date: '2026-06-11',
      datetime: '2026-06-11T09:00:00',
      isRecurring: false,
      string: 'today at 9am',
    });
    const r = dueLabel(task, NOW);
    // time is past (09:00 < 10:00)
    expect(r.main).toMatch(/9:00/i);
    expect(r.over).toBe(true);
  });

  it('today evening → Tonight + time', () => {
    const task = makeTask({
      date: '2026-06-11',
      datetime: '2026-06-11T20:00:00',
      isRecurring: false,
      string: 'tonight at 8pm',
    });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('Tonight');
    expect(r.over).toBe(false);
  });

  it('tomorrow datetime → Tomorrow + time', () => {
    const task = makeTask({
      date: '2026-06-12',
      datetime: '2026-06-12T08:00:00',
      isRecurring: false,
      string: 'tomorrow at 8am',
    });
    const r = dueLabel(task, NOW);
    expect(r.main).toBe('Tomorrow');
    expect(r.over).toBe(false);
  });
});
