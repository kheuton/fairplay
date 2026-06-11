/**
 * FAIRPLAY · Smoke test (read-only)
 * Reads VITE_TODOIST_API_TOKEN from .env.local, hits the real Todoist API,
 * resolves the deck using the same logic as the app, and prints:
 *   - Resolved deck table (num, slug, name, kind, category)
 *   - Open task counts per card
 *
 * NEVER prints the token. NEVER writes to the account.
 * Run: node scripts/smoke.mjs
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ─── Load token from .env.local ──────────────────────────────────────────────

function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // Strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      vars[key] = val;
    }
    return vars;
  } catch {
    return {};
  }
}

const env = loadEnv(join(root, '.env.local'));
const TOKEN = env['VITE_TODOIST_API_TOKEN'];
if (!TOKEN) {
  console.error('ERROR: VITE_TODOIST_API_TOKEN not found in .env.local');
  process.exit(1);
}

// ─── Todoist API helpers ──────────────────────────────────────────────────────

const BASE = 'https://api.todoist.com';

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GET ${path} → ${res.status} ${res.statusText}: ${body}`);
  }
  return res.json();
}

async function fetchAllPages(path) {
  const results = [];
  let cursor = null;
  do {
    const url = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
    const data = await apiGet(url);
    results.push(...(data.results ?? []));
    cursor = data.next_cursor ?? null;
  } while (cursor);
  return results;
}

// ─── Deck-config (mirrored from src/cards/deck-config.ts) ────────────────────

const DECK_PARENT_NAME = 'My Fair Play Cards';

const CARD_OVERRIDES = {
  'Garbage':                                          { kind: 'inventory', category: 'HOME',       color: '#9A7B33' },
  'Home goods & supplies':                            { kind: 'inventory', category: 'HOME' },
  'Home maintenance':                                 { kind: 'home',      category: 'HOME',       color: '#0C857C' },
  'Home purchase/rental, mortgage & insurance':       { kind: 'timeline',  category: 'HOME' },
  'Laundry':                                          { kind: 'timeline',  category: 'HOME' },
  "Meals (kids' school lunches)":                     { kind: 'timeline',  category: 'HOME' },
  'Meals (weekday dinners)':                          { kind: 'timeline',  category: 'HOME',       color: '#5B6BB0' },
  'Meals (weekend)':                                  { kind: 'timeline',  category: 'HOME' },
  'Money manager':                                    { kind: 'timeline',  category: 'OUT' },
  'Auto':                                             { kind: 'auto',      category: 'HOME',       color: '#EE5B2B' },
  'Cash & bills':                                     { kind: 'timeline',  category: 'OUT',        color: '#5B6BB0' },
  'Electronics & IT':                                 { kind: 'timeline',  category: 'OUT' },
  'School breaks (non-summer)':                       { kind: 'timeline',  category: 'CAREGIVING' },
  'Bathing & grooming (kids)':                        { kind: 'inventory', category: 'CAREGIVING' },
  'Bedtime routine':                                  { kind: 'timeline',  category: 'CAREGIVING' },
  'Birth control':                                    { kind: 'timeline',  category: 'CAREGIVING' },
  'Dental (kids)':                                    { kind: 'timeline',  category: 'CAREGIVING' },
  'Estate planning & life insurance':                 { kind: 'timeline',  category: 'OUT' },
  'Health insurance':                                 { kind: 'timeline',  category: 'OUT' },
  'Grooming & wardrobe':                              { kind: 'timeline',  category: 'OUT' },
  'Medical & healthy living (kids)':                  { kind: 'inventory', category: 'CAREGIVING' },
  'Morning routines (kids)':                          { kind: 'timeline',  category: 'CAREGIVING' },
  'Self-care':                                        { kind: 'timeline',  category: 'MAGIC' },
  'Teacher communication':                            { kind: 'timeline',  category: 'CAREGIVING' },
  'Adult friendships':                                { kind: 'timeline',  category: 'MAGIC' },
  'Fun & playing (kids)':                             { kind: 'timeline',  category: 'CAREGIVING' },
  'Marriage & romance':                               { kind: 'datenight', category: 'MAGIC',      color: '#C0497E' },
  'Middle-of-the-night comfort':                      { kind: 'timeline',  category: 'CAREGIVING' },
  'Diapering & potty training':                       { kind: 'inventory', category: 'CAREGIVING' },
  'Unicorn Space':                                    { kind: 'timeline',  category: 'MAGIC' },
};

const DEFAULT_KIND = 'timeline';
const DEFAULT_CATEGORY = 'HOME';

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── Deck resolution (mirrors src/lib/todoist/deck.ts) ───────────────────────

function resolveDeck(projects) {
  const parent =
    projects.find((p) => p.name === DECK_PARENT_NAME && p.parent_id === null) ??
    projects.find((p) => p.name === DECK_PARENT_NAME);

  if (!parent) {
    throw new Error(`Deck parent project "${DECK_PARENT_NAME}" not found.`);
  }

  const children = projects
    .filter((p) => p.parent_id === parent.id)
    .sort((a, b) => a.child_order - b.child_order);

  return children.map((p, idx) => {
    const override = CARD_OVERRIDES[p.name];
    const num = String(idx + 1).padStart(2, '0');
    return {
      id: slug(p.name),
      todoistId: p.id,
      num,
      name: p.name,
      kind: override?.kind ?? DEFAULT_KIND,
      category: override?.category ?? DEFAULT_CATEGORY,
      color: override?.color,
    };
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('FAIRPLAY SMOKE TEST — read-only\n');

  // 1. Fetch all projects
  console.log('Fetching projects...');
  const projects = await fetchAllPages('/api/v1/projects?limit=200');
  console.log(`  ${projects.length} total projects\n`);

  // 2. Resolve deck
  const deck = resolveDeck(projects);
  console.log(`Resolved deck: ${deck.length} cards under "${DECK_PARENT_NAME}"\n`);

  // 3. Fetch open tasks for all deck projects concurrently
  console.log('Fetching open tasks per card...');
  const taskCounts = await Promise.all(
    deck.map(async (card) => {
      const tasks = await fetchAllPages(`/api/v1/tasks?project_id=${card.todoistId}&limit=200`);
      // Exclude FP-item and FP-config carrier tasks from the open-task count
      const openTasks = tasks.filter(
        (t) => !t.labels?.includes('FP-item') && !t.labels?.includes('FP-config') && !t.checked
      );
      return { card, count: openTasks.length };
    })
  );

  // 4. Print deck table
  const COL = { num: 4, slug: 42, name: 45, kind: 10, cat: 12, tasks: 6 };
  const sep = '-'.repeat(COL.num + COL.slug + COL.name + COL.kind + COL.cat + COL.tasks + 14);

  const pad = (s, n) => String(s).padEnd(n);
  const rpad = (s, n) => String(s).padStart(n);

  console.log(
    `\n${pad('NUM', COL.num)}  ${pad('SLUG', COL.slug)}  ${pad('NAME', COL.name)}  ${pad('KIND', COL.kind)}  ${pad('CATEGORY', COL.cat)}  ${rpad('TASKS', COL.tasks)}`
  );
  console.log(sep);

  for (const { card, count } of taskCounts) {
    console.log(
      `${pad(card.num, COL.num)}  ${pad(card.id, COL.slug)}  ${pad(card.name, COL.name)}  ${pad(card.kind, COL.kind)}  ${pad(card.category, COL.cat)}  ${rpad(count, COL.tasks)}`
    );
  }

  console.log(sep);
  const totalTasks = taskCounts.reduce((s, { count }) => s + count, 0);
  console.log(`${''.padEnd(COL.num + COL.slug + COL.name + COL.kind + COL.cat + 10)}TOTAL: ${totalTasks}`);

  console.log('\nSMOKE OK — deck resolved, no writes made.');
}

main().catch((err) => {
  console.error('SMOKE FAILED:', err.message);
  process.exit(1);
});
