import { describe, it, expect } from 'vitest';
import {
  invPerDay,
  invDaysSince,
  invEst,
  invDaysLeft,
  invStatus,
  invFmt,
  invDateLabel,
  invRunout,
  invRateLabel,
  invChip,
} from './inventory-math';
import type { InvMeta } from './types';

// Fixed "now" for deterministic tests: 2026-06-09 noon
const NOW = new Date(2026, 5, 9, 12, 0, 0);

function item(overrides: Partial<InvMeta> = {}): InvMeta {
  return {
    icon: 'tp',
    w: 2,
    h: 2,
    x: 0,
    y: 0,
    stack: 30,
    count: 14,
    verified: '2026-06-01',
    rate: { n: 0.7, per: 'day' },
    warn: { mode: 'days', value: 7 },
    ...overrides,
  };
}

describe('invPerDay', () => {
  it('returns rate for per=day unchanged', () => {
    expect(invPerDay(item({ rate: { n: 1, per: 'day' } }))).toBe(1);
  });

  it('converts per=week to per-day', () => {
    expect(invPerDay(item({ rate: { n: 7, per: 'week' } }))).toBe(1);
    expect(invPerDay(item({ rate: { n: 1, per: 'week' } }))).toBeCloseTo(1 / 7);
  });

  it('converts per=month to per-day', () => {
    expect(invPerDay(item({ rate: { n: 30, per: 'month' } }))).toBe(1);
    expect(invPerDay(item({ rate: { n: 1, per: 'month' } }))).toBeCloseTo(1 / 30);
  });

  it('returns 0 when rate.n is 0', () => {
    expect(invPerDay(item({ rate: { n: 0, per: 'day' } }))).toBe(0);
  });
});

describe('invDaysSince', () => {
  it('returns 0 when verified is today', () => {
    expect(invDaysSince(item({ verified: '2026-06-09' }), NOW)).toBe(0);
  });

  it('returns correct days elapsed', () => {
    // verified 2026-06-01, now 2026-06-09 → 8 days
    expect(invDaysSince(item({ verified: '2026-06-01' }), NOW)).toBe(8);
  });

  it('returns 0 for future verification (clamps at 0)', () => {
    expect(invDaysSince(item({ verified: '2026-06-15' }), NOW)).toBe(0);
  });
});

describe('invEst', () => {
  it('calculates estimated stock correctly', () => {
    // count=14, rate=0.7/day, days=8 → 14 - 0.7*8 = 8.4
    expect(invEst(item(), NOW)).toBeCloseTo(8.4);
  });

  it('clamps to 0 when stock is depleted', () => {
    // count=1, rate=2/day, days=8 → 1 - 16 = -15 → 0
    expect(invEst(item({ count: 1, rate: { n: 2, per: 'day' } }), NOW)).toBe(0);
  });

  it('returns full count when rate is 0', () => {
    expect(invEst(item({ rate: { n: 0, per: 'day' } }), NOW)).toBe(14);
  });
});

describe('invDaysLeft', () => {
  it('returns Infinity when rate is 0', () => {
    expect(invDaysLeft(item({ rate: { n: 0, per: 'day' } }), NOW)).toBe(Infinity);
  });

  it('returns 0 when already out', () => {
    expect(invDaysLeft(item({ count: 0, rate: { n: 1, per: 'day' } }), NOW)).toBe(0);
  });

  it('calculates days left correctly', () => {
    // est=8.4, rate=0.7/day → 8.4/0.7 = 12
    expect(invDaysLeft(item(), NOW)).toBeCloseTo(12);
  });
});

describe('invStatus', () => {
  it('returns out when estimated count is essentially zero', () => {
    expect(invStatus(item({ count: 0 }), NOW)).toBe('out');
  });

  it('returns out when count is very nearly zero (<=0.01)', () => {
    // count=0.007 after burn
    const it = item({ count: 0.007, rate: { n: 0, per: 'day' }, verified: '2026-06-09' });
    expect(invStatus(it, NOW)).toBe('out');
  });

  it('returns low when days left <= warn.value (mode=days)', () => {
    // daysLeft=12, warn=7 → ok; daysLeft=5, warn=7 → low
    const lowItem = item({ count: 5, rate: { n: 1, per: 'day' }, warn: { mode: 'days', value: 7 } });
    // est after 8 days at rate 1/day = 5 - 8 = -3 → clamped 0 → out
    // Use freshly verified item
    const it = item({
      count: 5,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
      warn: { mode: 'days', value: 7 },
    });
    // est=5, daysLeft=5 <= 7 → low
    expect(invStatus(it, NOW)).toBe('low');
  });

  it('returns ok when days left > warn.value', () => {
    const it = item({
      count: 14,
      verified: '2026-06-09',
      rate: { n: 0.7, per: 'day' },
      warn: { mode: 'days', value: 7 },
    });
    // est=14, daysLeft=20 > 7 → ok
    expect(invStatus(it, NOW)).toBe('ok');
  });

  it('returns low when count <= warn.value (mode=count)', () => {
    const it = item({
      count: 2,
      verified: '2026-06-09',
      rate: { n: 0, per: 'day' },
      warn: { mode: 'count', value: 2 },
    });
    // est=2, warn count=2 → 2 <= 2 → low
    expect(invStatus(it, NOW)).toBe('low');
  });

  it('returns ok when count > warn.value (mode=count)', () => {
    const it = item({
      count: 5,
      verified: '2026-06-09',
      rate: { n: 0, per: 'day' },
      warn: { mode: 'count', value: 2 },
    });
    expect(invStatus(it, NOW)).toBe('ok');
  });
});

describe('invFmt', () => {
  it('shows integer for values >= 10', () => {
    expect(invFmt(14)).toBe('14');
    expect(invFmt(10)).toBe('10');
    expect(invFmt(10.7)).toBe('11');
  });

  it('shows 1 decimal for values < 10 when needed', () => {
    expect(invFmt(8.4)).toBe('8.4');
    expect(invFmt(1.5)).toBe('1.5');
  });

  it('shows integer for whole numbers < 10', () => {
    expect(invFmt(5)).toBe('5');
    expect(invFmt(0)).toBe('0');
  });
});

describe('invDateLabel', () => {
  it('formats a date as "MON DD"', () => {
    expect(invDateLabel('2026-06-01')).toBe('JUN 1');
    expect(invDateLabel('2026-01-15')).toBe('JAN 15');
    expect(invDateLabel('2026-12-31')).toBe('DEC 31');
  });
});

describe('invRunout', () => {
  it('returns — for infinite runout (rate=0)', () => {
    expect(invRunout(item({ rate: { n: 0, per: 'day' } }), NOW)).toBe('—');
  });

  it('returns NOW when already out', () => {
    const it = item({ count: 0, rate: { n: 1, per: 'day' } });
    expect(invRunout(it, NOW)).toBe('NOW');
  });

  it('returns >90 DAYS when runout is far away', () => {
    const it = item({
      count: 200,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
    });
    expect(invRunout(it, NOW)).toBe('>90 DAYS');
  });

  it('returns formatted date for near-term runout', () => {
    // est=5, rate=1/day → 5 more days → Jun 14
    const it = item({
      count: 5,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
    });
    expect(invRunout(it, NOW)).toBe('JUN 14');
  });
});

describe('invRateLabel', () => {
  it('formats per=day', () => {
    expect(invRateLabel(item({ rate: { n: 0.7, per: 'day' } }))).toBe('0.7/DAY');
  });

  it('formats per=week', () => {
    expect(invRateLabel(item({ rate: { n: 2, per: 'week' } }))).toBe('2/WK');
  });

  it('formats per=month', () => {
    expect(invRateLabel(item({ rate: { n: 1, per: 'month' } }))).toBe('1/MO');
  });
});

describe('invChip', () => {
  it('returns OUT when stock is depleted', () => {
    expect(invChip(item({ count: 0 }), NOW)).toBe('OUT');
  });

  it('returns XD LEFT for low stock within 14 days', () => {
    const it = item({
      count: 5,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
      warn: { mode: 'days', value: 7 },
    });
    // daysLeft=5 → "5D LEFT"
    expect(invChip(it, NOW)).toBe('5D LEFT');
  });

  it('returns LOW for low stock beyond 14 days', () => {
    const it = item({
      count: 20,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
      // daysLeft=20, warn=25 → 20 <= 25 → low; 20 > 14 → 'LOW' (not 'XD LEFT')
      warn: { mode: 'days', value: 25 },
    });
    expect(invChip(it, NOW)).toBe('LOW');
  });

  it('returns OK when status is ok', () => {
    const it = item({
      count: 100,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
      warn: { mode: 'days', value: 7 },
    });
    expect(invChip(it, NOW)).toBe('OK');
  });

  it('returns at least 1D LEFT when < 1 day left', () => {
    const it = item({
      count: 0.5,
      verified: '2026-06-09',
      rate: { n: 1, per: 'day' },
      warn: { mode: 'days', value: 3 },
    });
    // daysLeft=0.5, low → "1D LEFT"
    expect(invChip(it, NOW)).toBe('1D LEFT');
  });
});
