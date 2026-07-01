/**
 * FAIRPLAY · Bulk update "Home goods & supplies" inventory (Kyle deck)
 *
 *   node scripts/inv-bulk-homegoods.mjs            — dry run (prints plan, no writes)
 *   node scripts/inv-bulk-homegoods.mjs --commit   — performs writes
 *
 * Reads VITE_TODOIST_API_TOKEN from .env.local. NEVER prints the token.
 * Creates new FP-item carrier tasks; UPDATES existing items matched by name
 * (Toothpaste, All-purpose cleaner) instead of duplicating. Idempotent: re-running
 * re-matches by name so already-created items get updated, not duplicated.
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const COMMIT = process.argv.includes('--commit');

// ─── token ───────────────────────────────────────────────────────────────────
function loadEnv(filePath) {
  try {
    const vars = {};
    for (const line of readFileSync(filePath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('='); if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      vars[key] = val;
    }
    return vars;
  } catch { return {}; }
}
const TOKEN = loadEnv(join(root, '.env.local'))['VITE_TODOIST_API_TOKEN'];
if (!TOKEN) { console.error('ERROR: VITE_TODOIST_API_TOKEN not found in .env.local'); process.exit(1); }

// ─── api ─────────────────────────────────────────────────────────────────────
const BASE = 'https://api.todoist.com';
async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}
async function getAll(path) {
  const out = []; let cursor = null;
  do {
    const url = cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path;
    const data = await apiGet(url);
    out.push(...(data.results ?? []));
    cursor = data.next_cursor ?? null;
  } while (cursor);
  return out;
}
async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${await res.text().catch(() => '')}`);
  return res.json();
}

// ─── FP metadata helpers (mirror src/lib/metadata.ts) ──────────────────────────
const FP = 'FP::';
function parseFp(description) {
  if (!description) return { meta: {}, clean: '' };
  const lines = description.split('\n');
  const last = lines[lines.length - 1];
  if (last.startsWith(FP)) {
    try {
      const parsed = JSON.parse(last.slice(FP.length));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return { meta: parsed, clean: lines.slice(0, -1).join('\n') };
    } catch { /* malformed */ }
  }
  return { meta: {}, clean: description };
}
function withFp(clean, meta) {
  if (Object.keys(meta).length === 0) return clean;
  const line = `${FP}${JSON.stringify(meta)}`;
  return clean ? `${clean}\n${line}` : line;
}

const TODAY = new Date().toISOString().slice(0, 10);
const norm = (s) => s.trim().toLowerCase();

// stack = one full stack at the verified count (honors "1 stack of each"); flavor only.
function makeInv(icon, count, rateN, ratePer, warnValue, order) {
  return {
    icon, w: 1, h: 1, x: 0, y: 0,
    stack: Math.max(1, Math.ceil(count)),
    count, verified: TODAY,
    rate: { n: rateN, per: ratePer },
    warn: { mode: 'count', value: warnValue },
    order,
  };
}

// ─── desired items (display order) ─────────────────────────────────────────────
// a=assumed (filled because user didn't specify): w=warn r=rate c=count
const SPEC = [
  // paper goods
  { name: 'Toilet paper',                icon: 'tp',            count: 30,  rate: [2, 'week'],   warn: 6,    a: 'w' },
  { name: 'Paper towel',                 icon: 'papertowel',    count: 6,   rate: [1, 'week'],   warn: 3 },
  { name: 'Tissue',                      icon: 'tissues',       count: 4,   rate: [2, 'month'],  warn: 2 },
  // dish / laundry / soaps / cleaners
  { name: 'Dish soap',                   icon: 'detergent',     count: 0.7, rate: [0.5, 'month'],warn: 0.25 },
  { name: 'Hand soap',                   icon: 'handsoap',      count: 0.7, rate: [0.5, 'month'],warn: 0.25 },
  { name: 'Dish detergent',              icon: 'dishwasher_det',count: 0.7, rate: [0.5, 'month'],warn: 0.25 },
  { name: 'Laundry detergent',           icon: 'laundry',       count: 0.7, rate: [0.5, 'month'],warn: 0.25 },
  { name: 'Bottle washing detergent',    icon: 'bottlesoap',    count: 0.7, rate: [0.5, 'month'],warn: 0.25 },
  { name: 'Dawn power wash',             icon: 'dawn',          count: 1,   rate: [1, 'month'],  warn: 1,    a: 'r w' },
  { name: 'Glass cleaner',               icon: 'glasscleaner',  count: 1,   rate: [1, 'month'],  warn: 1,    a: 'r w' },
  { name: 'Organic all-purpose cleaner', icon: 'allpurpose',    count: 1,   rate: [1, 'month'],  warn: 1,    a: 'r w', match: 'All-purpose cleaner' },
  { name: 'Organic bath cleaner',        icon: 'nontoxic',      count: 1,   rate: [1, 'month'],  warn: 1,    a: 'c r w' },
  { name: 'Wipes',                       icon: 'childwipes',    count: 3,   rate: [1, 'month'],  warn: 1,    a: 'r w' },
  { name: 'Swiffer wet',                 icon: 'swiffer_wet',   count: 1,   rate: [1, 'month'],  warn: 1,    a: 'c r w' },
  { name: 'Swiffer dry',                 icon: 'swiffer_dust',  count: 1,   rate: [1, 'month'],  warn: 1,    a: 'c r w' },
  { name: 'Toilet wands',                icon: 'toiletpucks',   count: 2,   rate: [1, 'month'],  warn: 1,    a: 'r w' },
  { name: 'Simple Human small bathroom trash bags', icon: 'trashbag_bath', count: 1, rate: [1, 'month'], warn: 1, a: 'c r w' },
  // personal care
  { name: 'Shampoo',                     icon: 'shampoo',       count: 3,   rate: [1, 'month'],  warn: 1 },
  { name: 'Conditioner',                 icon: 'conditioner',   count: 3,   rate: [1, 'month'],  warn: 1 },
  { name: 'Body wash',                   icon: 'bodywash',      count: 2,   rate: [1, 'month'],  warn: 1 },
  { name: 'Toothpaste',                  icon: 'toothpaste',    count: 0.5, rate: [1, 'month'],  warn: 1,    match: 'Toothpaste' },
  { name: 'Toner',                       icon: 'generic',       count: 1,   rate: [1, 'month'],  warn: 1,    a: 'c r w' },
  { name: 'Adult sunscreen',             icon: 'sunscreen',     count: 1,   rate: [1, 'month'],  warn: 1 },
  { name: 'Baby sunscreen',              icon: 'sunscreen',     count: 1,   rate: [1, 'month'],  warn: 1 },
  { name: 'Bug spray',                   icon: 'bugspray',      count: 0,   rate: [1, 'month'],  warn: 1,    a: 'r' },
  // baby + meds
  { name: 'Diapers',                     icon: 'diaper',        count: 0.5, rate: [1, 'month'],  warn: 1,    a: 'r' },
  { name: 'Probiotic drops',             icon: 'probiotic',     count: 2,   rate: [1, 'month'],  warn: 1 },
  { name: 'Tylenol',                     icon: 'tylenol',       count: 0.2, rate: [1, 'month'],  warn: 0.5,  a: 'r' },
  { name: 'Motrin',                      icon: 'motrin',        count: 0.2, rate: [1, 'month'],  warn: 0.5,  a: 'r' },
];

// ─── resolve project ───────────────────────────────────────────────────────────
const projects = await getAll('/api/v1/projects?limit=200');
const parent = projects.find((p) => p.name === 'My Fair Play Cards');
if (!parent) throw new Error('parent project "My Fair Play Cards" not found');
const card = projects.find((p) => p.parent_id === parent.id && p.name === 'Home goods & supplies');
if (!card) throw new Error('card project "Home goods & supplies" not found under Kyle deck');

const tasks = await getAll('/api/v1/tasks?limit=200');
const existing = tasks.filter((t) => t.project_id === card.id && (t.labels ?? []).includes('FP-item'));
const existingByName = new Map(existing.map((t) => [norm(t.content), t]));

// nextOrder mirrors the app: max(existing order ?? -1) + 1
let nextOrder = existing.reduce((m, t) => {
  const ord = parseFp(t.description ?? '').meta?.inv?.order;
  return typeof ord === 'number' && Number.isFinite(ord) ? Math.max(m, ord) : m;
}, -1) + 1;

// ─── plan ────────────────────────────────────────────────────────────────────
const plan = [];
for (const s of SPEC) {
  const matchKey = norm(s.match ?? s.name);
  const hit = existingByName.get(matchKey);
  const [rateN, ratePer] = s.rate;
  if (hit) {
    const { meta, clean } = parseFp(hit.description ?? '');
    const prevOrder = meta?.inv?.order;
    const order = typeof prevOrder === 'number' && Number.isFinite(prevOrder) ? prevOrder : nextOrder++;
    const inv = makeInv(s.icon, s.count, rateN, ratePer, s.warn, order);
    plan.push({ op: 'UPDATE', id: hit.id, oldName: hit.content, name: s.name, clean, meta, inv, a: s.a });
  } else {
    const inv = makeInv(s.icon, s.count, rateN, ratePer, s.warn, nextOrder++);
    plan.push({ op: 'CREATE', name: s.name, inv, a: s.a });
  }
}

// ─── print ───────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
const perL = { day: '/day', week: '/wk', month: '/mo' };
console.log(`\nCard: "${card.name}"  (project ${card.id}, Kyle deck)`);
console.log(`Existing FP-item tasks: ${existing.length}   Desired: ${SPEC.length}   Mode: ${COMMIT ? 'COMMIT' : 'DRY RUN'}\n`);
console.log(pad('OP', 7) + pad('NAME', 36) + pad('ICON', 15) + pad('COUNT', 7) + pad('STACK', 7) + pad('RATE', 9) + pad('ALERT', 8) + 'ASSUMED');
console.log('-'.repeat(104));
for (const p of plan) {
  const assumed = (p.a || '').replace('c', 'count').replace('r', 'rate').replace('w', 'warn');
  const nm = p.op === 'UPDATE' && norm(p.oldName) !== norm(p.name) ? `${p.name}  (was "${p.oldName}")` : p.name;
  console.log(
    pad(p.op, 7) + pad(nm, 36) + pad(p.inv.icon, 15) +
    pad(p.inv.count, 7) + pad(p.inv.stack, 7) +
    pad(p.inv.rate.n + perL[p.inv.rate.per], 9) +
    pad('≤' + p.inv.warn.value, 8) + (assumed || '—'),
  );
}
const creates = plan.filter((p) => p.op === 'CREATE').length;
const updates = plan.filter((p) => p.op === 'UPDATE').length;
console.log(`\n${creates} create · ${updates} update`);

// ─── execute ───────────────────────────────────────────────────────────────────
if (!COMMIT) {
  console.log('\nDRY RUN — no writes. Re-run with --commit to apply.');
  process.exit(0);
}
console.log('\nWriting...');
for (const p of plan) {
  if (p.op === 'CREATE') {
    await apiPost('/api/v1/tasks', {
      content: p.name,
      project_id: card.id,
      description: withFp('', { inv: p.inv }),
      labels: ['FP-item'],
    });
    console.log(`  + created ${p.name}`);
  } else {
    const newMeta = { ...p.meta, inv: { ...(p.meta.inv ?? {}), ...p.inv } };
    await apiPost(`/api/v1/tasks/${p.id}`, {
      content: p.name,
      description: withFp(p.clean, newMeta),
    });
    console.log(`  ~ updated ${p.name}`);
  }
}
console.log('\nDone.');
