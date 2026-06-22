import { format } from 'date-fns';

/** Local calendar date as YYYY-MM-DD (the format FP:: inv.verified uses). */
export function todayString(): string {
  return format(new Date(), 'yyyy-MM-dd');
}
