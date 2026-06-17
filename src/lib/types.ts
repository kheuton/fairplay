export type Theme = 'bone' | 'eclipse' | 'vapor';
export type CardKind = 'timeline' | 'inventory' | 'auto' | 'home' | 'datenight';
export type CardCategory = 'HOME' | 'OUT' | 'CAREGIVING' | 'MAGIC';

export interface CardDef {
  id: string;
  todoistId: string;
  num: string;
  name: string;
  category: CardCategory;
  kind: CardKind;
  color?: string;
}

export interface FpDue {
  date: string;
  datetime?: string;
  string: string;
  isRecurring: boolean;
}

export interface InvMeta {
  icon: string;
  w: number;
  h: number;
  x: number;
  y: number;
  stack: number;
  count: number;
  verified: string;
  rate: { n: number; per: 'day' | 'week' | 'month' };
  warn: { mode: 'days' | 'count'; value: number };
}

export interface FpMeta {
  part?: string;
  zone?: string;
  inv?: InvMeta;
  config?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface FpTask {
  id: string;
  content: string;
  description: string;
  cardId: string | null;
  labels: string[];
  due: FpDue | null;
  priority: 1 | 2 | 3 | 4;
  isCompleted: boolean;
  url: string;
  meta: FpMeta;
}
