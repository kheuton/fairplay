import type { InvMeta } from './types';

const PER_DAYS: Record<InvMeta['rate']['per'], number> = {
  day: 1,
  week: 7,
  month: 30,
};

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/**
 * Fills in missing/invalid fields on a raw (possibly user-edited) inv object so
 * that all inventory-math functions get safe numeric inputs.
 *
 * Required numeric fields that can be undefined if the user hand-edits an FP::
 * payload: rate, warn, stack, count, x, y, w, h, verified.
 * order is preserved when present and finite; otherwise omitted so legacy items
 * fall back to query/Todoist order.
 * Returns a new object — never mutates the input.
 */
export function normalizeInvMeta(raw: Partial<InvMeta>): InvMeta {
  const rate =
    raw.rate &&
    typeof raw.rate.n === 'number' &&
    (raw.rate.per === 'day' || raw.rate.per === 'week' || raw.rate.per === 'month')
      ? raw.rate
      : { n: 1, per: 'week' as const };

  const warn =
    raw.warn &&
    (raw.warn.mode === 'days' || raw.warn.mode === 'count') &&
    typeof raw.warn.value === 'number'
      ? raw.warn
      : { mode: 'days' as const, value: 7 };

  return {
    icon: typeof raw.icon === 'string' && raw.icon ? raw.icon : 'generic',
    w: typeof raw.w === 'number' && raw.w >= 1 ? Math.round(raw.w) : 1,
    h: typeof raw.h === 'number' && raw.h >= 1 ? Math.round(raw.h) : 1,
    x: typeof raw.x === 'number' && raw.x >= 0 ? Math.round(raw.x) : 0,
    y: typeof raw.y === 'number' && raw.y >= 0 ? Math.round(raw.y) : 0,
    stack: typeof raw.stack === 'number' && raw.stack >= 1 ? raw.stack : 10,
    count: typeof raw.count === 'number' && raw.count >= 0 ? raw.count : 0,
    verified: typeof raw.verified === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.verified)
      ? raw.verified
      : new Date().toISOString().slice(0, 10),
    rate,
    warn,
    ...(typeof raw.order === 'number' && Number.isFinite(raw.order) ? { order: raw.order } : {}),
  };
}

/** Burn rate in units per day. */
export function invPerDay(item: InvMeta): number {
  return item.rate.n / PER_DAYS[item.rate.per];
}

/** Days elapsed since last verification. */
export function invDaysSince(item: InvMeta, now?: Date): number {
  const ref = now ?? new Date();
  return Math.max(0, Math.round((ref.getTime() - parseDate(item.verified).getTime()) / 864e5));
}

/** Estimated current count (may be fractional). */
export function invEst(item: InvMeta, now?: Date): number {
  return Math.max(0, item.count - invPerDay(item) * invDaysSince(item, now));
}

/** Days until estimated runout. Infinity when burn rate is zero. */
export function invDaysLeft(item: InvMeta, now?: Date): number {
  const pd = invPerDay(item);
  return pd <= 0 ? Infinity : invEst(item, now) / pd;
}

/** 'ok' | 'low' | 'out' based on warn threshold. */
export function invStatus(item: InvMeta, now?: Date): 'ok' | 'low' | 'out' {
  const est = invEst(item, now);
  if (est <= 0.01) return 'out';
  const w = item.warn ?? { mode: 'days', value: 7 };
  const threshold = w.mode === 'count' ? est <= w.value : invDaysLeft(item, now) <= w.value;
  return threshold ? 'low' : 'ok';
}

/** Format a count nicely (1 decimal if < 10). */
export function invFmt(n: number): string {
  if (n >= 10) return String(Math.round(n));
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

export function invDateLabel(s: string): string {
  const d = parseDate(s);
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

/** Human-readable runout date like "JUN 14" or "NOW" / ">90 DAYS". */
export function invRunout(item: InvMeta, now?: Date): string {
  const ref = now ?? new Date();
  const dl = invDaysLeft(item, ref);
  if (!isFinite(dl)) return '—';
  if (invEst(item, ref) <= 0.01) return 'NOW';
  if (dl > 90) return '>90 DAYS';
  const d = new Date(ref.getTime() + dl * 864e5);
  return MONTHS[d.getMonth()] + ' ' + d.getDate();
}

/** Short rate label, e.g. "0.7/DAY". */
export function invRateLabel(item: InvMeta): string {
  const perLabel: Record<InvMeta['rate']['per'], string> = { day: 'DAY', week: 'WK', month: 'MO' };
  return item.rate.n + '/' + perLabel[item.rate.per];
}

/** Compact chip text: "OK" / "7D LEFT" / "LOW" / "OUT". */
export function invChip(item: InvMeta, now?: Date): string {
  const st = invStatus(item, now);
  if (st === 'out') return 'OUT';
  if (st === 'low') {
    const dl = invDaysLeft(item, now);
    return dl <= 14 ? Math.max(1, Math.ceil(dl)) + 'D LEFT' : 'LOW';
  }
  return 'OK';
}
