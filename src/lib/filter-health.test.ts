import { describe, it, expect } from 'vitest';
import {
  normalizeFilter,
  filterDaysUsed,
  filterDaysLeft,
  filterLifeFrac,
  filterStatus,
  filterReplaceBy,
  filterChip,
  filterPct,
  FILTER_DEFAULTS,
  type FilterState,
} from './filter-health';

// Fixed reference "now" so every test is deterministic (local noon-safe).
const NOW = new Date(2026, 5, 14, 12); // 2026-06-14

function state(partial: Partial<FilterState> = {}): FilterState {
  return { installed: '2026-06-14', lifespanDays: 120, warnDays: 21, ...partial };
}

describe('normalizeFilter', () => {
  it('fills defaults when raw is undefined', () => {
    const s = normalizeFilter(undefined, NOW);
    expect(s.installed).toBe('2026-06-14');
    expect(s.lifespanDays).toBe(FILTER_DEFAULTS.lifespanDays);
    expect(s.warnDays).toBe(FILTER_DEFAULTS.warnDays);
  });

  it('keeps valid fields and rounds numerics', () => {
    const s = normalizeFilter({ installed: '2026-01-01', lifespanDays: 90.6, warnDays: 14.2 }, NOW);
    expect(s.installed).toBe('2026-01-01');
    expect(s.lifespanDays).toBe(91);
    expect(s.warnDays).toBe(14);
  });

  it('rejects malformed install date → today', () => {
    expect(normalizeFilter({ installed: 'nope' }, NOW).installed).toBe('2026-06-14');
  });

  it('rejects non-positive lifespan → default', () => {
    expect(normalizeFilter({ lifespanDays: 0 }, NOW).lifespanDays).toBe(FILTER_DEFAULTS.lifespanDays);
  });
});

describe('filterDaysUsed', () => {
  it('is 0 the day it was installed', () => {
    expect(filterDaysUsed(state(), NOW)).toBe(0);
  });
  it('counts whole days since install', () => {
    expect(filterDaysUsed(state({ installed: '2026-05-15' }), NOW)).toBe(30);
  });
  it('never goes negative for a future install date', () => {
    expect(filterDaysUsed(state({ installed: '2026-07-01' }), NOW)).toBe(0);
  });
});

describe('filterDaysLeft', () => {
  it('equals lifespan when fresh', () => {
    expect(filterDaysLeft(state(), NOW)).toBe(120);
  });
  it('decreases with age', () => {
    expect(filterDaysLeft(state({ installed: '2026-05-15' }), NOW)).toBe(90);
  });
  it('goes negative when overdue', () => {
    expect(filterDaysLeft(state({ installed: '2026-01-01', lifespanDays: 120 }), NOW)).toBeLessThan(0);
  });
});

describe('filterLifeFrac', () => {
  it('is 1 when fresh', () => {
    expect(filterLifeFrac(state(), NOW)).toBe(1);
  });
  it('is 0.5 at half life', () => {
    // Apr 15 → Jun 14 is exactly 60 days of a 120-day cartridge.
    expect(filterLifeFrac(state({ installed: '2026-04-15', lifespanDays: 120 }), NOW)).toBeCloseTo(0.5, 5);
  });
  it('clamps to 0 when overdue', () => {
    expect(filterLifeFrac(state({ installed: '2026-01-01', lifespanDays: 100 }), NOW)).toBe(0);
  });
});

describe('filterStatus', () => {
  it('ok when plenty of life', () => {
    expect(filterStatus(state(), NOW)).toBe('ok');
  });
  it('low within warn window', () => {
    // installed 105 days ago, lifespan 120 → 15 days left, warn 21 → low
    expect(filterStatus(state({ installed: '2026-03-01', lifespanDays: 120, warnDays: 21 }), NOW)).toBe('low');
  });
  it('out when no life remains', () => {
    expect(filterStatus(state({ installed: '2026-01-01', lifespanDays: 100 }), NOW)).toBe('out');
  });
});

describe('filterReplaceBy', () => {
  it('is install + lifespan', () => {
    expect(filterReplaceBy(state({ installed: '2026-06-14', lifespanDays: 120 }))).toBe('2026-10-12');
  });
});

describe('filterChip', () => {
  it('OK when healthy', () => {
    expect(filterChip(state(), NOW)).toBe('OK');
  });
  it('shows days left when low', () => {
    expect(filterChip(state({ installed: '2026-03-01', lifespanDays: 120, warnDays: 21 }), NOW)).toBe('15D LEFT');
  });
  it('REPLACE when out', () => {
    expect(filterChip(state({ installed: '2026-01-01', lifespanDays: 100 }), NOW)).toBe('REPLACE');
  });
});

describe('filterPct', () => {
  it('100 when fresh', () => {
    expect(filterPct(state(), NOW)).toBe(100);
  });
  it('0 when overdue', () => {
    expect(filterPct(state({ installed: '2026-01-01', lifespanDays: 100 }), NOW)).toBe(0);
  });
});
