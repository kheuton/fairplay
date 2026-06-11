/**
 * FAIRPLAY · Inventory seeds
 * Default item sets ported from design/prototype/inventory-data.jsx.
 * Mapped by exact Todoist project name to prototype inventory key.
 * verified = today (set at call time so it's always fresh).
 */
import type { InvMeta } from '../../lib/types';

export interface SeedItem {
  name: string;
  inv: InvMeta;
}

type SeedDef = { cols: number; rows: number; items: SeedItem[] };

function makeItem(
  name: string,
  icon: string,
  w: number, h: number,
  x: number, y: number,
  stack: number,
  count: number,
  rateN: number,
  ratePer: InvMeta['rate']['per'],
  warnMode: InvMeta['warn']['mode'],
  warnValue: number,
  today: string,
): SeedItem {
  return {
    name,
    inv: { icon, w, h, x, y, stack, count, verified: today, rate: { n: rateN, per: ratePer }, warn: { mode: warnMode, value: warnValue } },
  };
}

function buildSeeds(today: string): Record<string, SeedDef> {
  return {
    'Diapering': {
      cols: 7, rows: 4,
      items: [
        makeItem('Diapers · Size 4',  'diaper',  2, 2, 0, 0, 64,  38, 6,   'day',   'days',  7,   today),
        makeItem('Water Wipes',       'wipes',   2, 1, 2, 0, 12,  7,  2,   'week',  'days',  7,   today),
        makeItem('Diaper Cream',      'cream',   1, 1, 4, 0, 2,   1,  1,   'month', 'count', 1,   today),
        makeItem('Formula · Stage 1', 'formula', 2, 2, 5, 0, 4,   3,  1.5, 'week',  'days',  7,   today),
        makeItem('Swim Diapers',      'diaper',  1, 1, 2, 1, 20,  17, 2,   'week',  'days',  7,   today),
      ],
    },
    'Bathtime': {
      cols: 6, rows: 3,
      items: [
        makeItem('Kids Shampoo',           'shampoo',     1, 2, 0, 0, 2, 2, 0.6, 'month', 'count', 1,   today),
        makeItem('Kids Conditioner',       'conditioner', 1, 2, 1, 0, 2, 1, 0.5, 'month', 'count', 1,   today),
        makeItem('Cradle Cap Conditioner', 'cradlecap',   1, 1, 3, 0, 1, 1, 0.3, 'month', 'count', 0.5, today),
        makeItem('Kids Sunscreen SPF 50',  'sunscreen',   1, 1, 4, 0, 3, 2, 1,   'month', 'count', 1,   today),
      ],
    },
    'Garbage': {
      cols: 6, rows: 3,
      items: [
        makeItem('Kitchen Bags · 13 gal', 'trashbag',   2, 1, 0, 0, 90, 34, 1,   'day',   'days',  7, today),
        makeItem('Compost Liners',        'compostbag', 1, 1, 2, 0, 50, 9,  1,   'day',   'days',  7, today),
        makeItem('Contractor Bags',       'trashbag',   1, 1, 3, 1, 10, 6,  0.5, 'month', 'count', 1, today),
      ],
    },
    'Pharmacy': {
      cols: 6, rows: 3,
      items: [
        makeItem('Infant Motrin',     'tablets',  1, 1, 0, 0, 2, 1, 0.4, 'month', 'count', 1,   today),
        makeItem('Infant Tylenol',    'capsules', 1, 1, 1, 0, 2, 2, 0.3, 'month', 'count', 1,   today),
        makeItem("Children's Zyrtec", 'blister',  1, 1, 3, 0, 2, 1, 1,   'month', 'count', 1,   today),
        makeItem('Probiotic Drops',   'drops',    1, 1, 4, 1, 1, 1, 1,   'month', 'count', 0.5, today),
      ],
    },
    'Home Goods': {
      cols: 8, rows: 4,
      items: [
        makeItem('Toilet Paper',        'tp',          2, 2, 0, 0, 30, 14, 0.7,  'day',   'days',  7, today),
        makeItem('Paper Towels',        'papertowel',  2, 1, 2, 0, 12, 3,  0.4,  'day',   'days',  7, today),
        makeItem('Gallon Zip Bags',     'ziplock',     1, 1, 4, 0, 75, 40, 2,    'week',  'days',  7, today),
        makeItem('Sandwich Zip Bags',   'ziplock',     1, 1, 5, 0, 90, 25, 3,    'week',  'days',  7, today),
        makeItem('Plastic Wrap',        'plasticwrap', 1, 1, 4, 1, 2,  2,  0.2,  'month', 'count', 1, today),
        makeItem('Aluminum Foil',       'foil',        1, 1, 5, 1, 2,  1,  0.25, 'month', 'count', 1, today),
        makeItem('Parchment Paper',     'parchment',   1, 1, 6, 1, 2,  2,  0.15, 'month', 'count', 1, today),
        makeItem('Fridge Water Filter', 'waterfilter', 1, 1, 2, 1, 6,  2,  0.5,  'month', 'count', 1, today),
      ],
    },
  };
}

/** Map from exact Todoist project name to seed def key. */
const NAME_TO_SEED_KEY: Record<string, string> = {
  'Garbage':                             'Garbage',
  'Home goods & supplies':               'Home Goods',
  'Diapering & potty training':          'Diapering',
  'Bathing & grooming (kids)':           'Bathtime',
  'Medical & healthy living (kids)':     'Pharmacy',
};

export function getSeedDef(cardName: string, today: string): SeedDef | null {
  const key = NAME_TO_SEED_KEY[cardName];
  if (!key) return null;
  return buildSeeds(today)[key] ?? null;
}
