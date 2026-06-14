/**
 * FAIRPLAY · Water-filter health math.
 *
 * Models a consumable filter cartridge that deteriorates over time and must be
 * replaced periodically. Mirrors the inventory-math.ts pattern (a verified date
 * + a rate → a derived current state) but the "rate" here is simply elapsed time
 * against an expected lifespan.
 *
 * State is persisted in the Home card's FP-config carrier under
 *   config.waterFilter = { installed, lifespanDays, warnDays }
 * (see useWaterFilter in hooks.ts). Marking the filter replaced just resets
 * `installed` to today — fully reversible, no destructive Todoist writes.
 */

export interface FilterState {
  /** Date the current cartridge was installed / last replaced (YYYY-MM-DD). */
  installed: string;
  /** Expected service life of a cartridge, in days. */
  lifespanDays: number;
  /** Warn (status 'low') when this many days of life remain. */
  warnDays: number;
}

export const FILTER_DEFAULTS = {
  lifespanDays: 120, // ~4 months — typical under-sink / faucet cartridge
  warnDays: 21,
} as const;

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

/** Parse a YYYY-MM-DD date at local noon (matches inventory-math.parseDate). */
function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}

/** Today as YYYY-MM-DD (local). */
function todayStr(now?: Date): string {
  const d = now ?? new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Coerce a raw (possibly hand-edited or absent) config blob into a safe
 * FilterState. Missing/invalid `installed` defaults to today; numeric fields
 * fall back to FILTER_DEFAULTS. Never mutates the input.
 */
export function normalizeFilter(raw: Partial<FilterState> | undefined, now?: Date): FilterState {
  const installed =
    typeof raw?.installed === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.installed)
      ? raw.installed
      : todayStr(now);
  const lifespanDays =
    typeof raw?.lifespanDays === 'number' && raw.lifespanDays >= 1
      ? Math.round(raw.lifespanDays)
      : FILTER_DEFAULTS.lifespanDays;
  const warnDays =
    typeof raw?.warnDays === 'number' && raw.warnDays >= 0
      ? Math.round(raw.warnDays)
      : FILTER_DEFAULTS.warnDays;
  return { installed, lifespanDays, warnDays };
}

/** Whole days elapsed since the cartridge was installed (never negative). */
export function filterDaysUsed(state: FilterState, now?: Date): number {
  const ref = now ?? new Date();
  return Math.max(0, Math.round((ref.getTime() - parseDate(state.installed).getTime()) / 864e5));
}

/** Days of life remaining (may be negative once overdue). */
export function filterDaysLeft(state: FilterState, now?: Date): number {
  return state.lifespanDays - filterDaysUsed(state, now);
}

/** Fraction of life remaining, clamped to [0, 1]. */
export function filterLifeFrac(state: FilterState, now?: Date): number {
  if (state.lifespanDays <= 0) return 0;
  const frac = filterDaysLeft(state, now) / state.lifespanDays;
  return Math.max(0, Math.min(1, frac));
}

/** 'ok' | 'low' | 'out' against the warn threshold. */
export function filterStatus(state: FilterState, now?: Date): 'ok' | 'low' | 'out' {
  const left = filterDaysLeft(state, now);
  if (left <= 0) return 'out';
  if (left <= state.warnDays) return 'low';
  return 'ok';
}

/** Replace-by date (installed + lifespan) as YYYY-MM-DD. */
export function filterReplaceBy(state: FilterState): string {
  const base = parseDate(state.installed);
  const by = new Date(base.getTime() + state.lifespanDays * 864e5);
  const y = by.getFullYear();
  const m = String(by.getMonth() + 1).padStart(2, '0');
  const d = String(by.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Human label for a YYYY-MM-DD date like "JUN 14". */
export function filterDateLabel(s: string): string {
  const d = parseDate(s);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/** Compact status chip text: "OK" / "21D LEFT" / "LOW" / "REPLACE". */
export function filterChip(state: FilterState, now?: Date): string {
  const st = filterStatus(state, now);
  if (st === 'out') return 'REPLACE';
  const left = filterDaysLeft(state, now);
  if (st === 'low') return `${Math.max(1, Math.ceil(left))}D LEFT`;
  return 'OK';
}

/** Percent of life remaining, 0..100 (rounded). */
export function filterPct(state: FilterState, now?: Date): number {
  return Math.round(filterLifeFrac(state, now) * 100);
}
