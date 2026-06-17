/**
 * FAIRPLAY · Prune the "Unused Fair Play Cards" list
 * ──────────────────────────────────────────────────────────────────────────
 * Removes tasks from the Todoist project "Unused Fair Play Cards" that
 * correspond to cards EITHER deck now holds, so the list only contains cards
 * that neither Kyle nor Amy have.
 *
 * Matching rules (per card title in the unused list):
 *   • Normal title           → DELETE if it matches a card in EITHER deck.
 *   • "X (partner)" title     → DELETE only if BOTH decks have card "X"
 *                               (both partners hold that personal card; the
 *                               second copy is now redundant). Otherwise KEEP.
 *
 * DRY RUN by default. Pass --commit to actually delete. NEVER prints the token.
 * Run:  node scripts/prune-unused.mjs            (preview)
 *       node scripts/prune-unused.mjs --commit   (delete)
 */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function loadEnv(filePath) {
  try {
    const content = readFileSync(filePath, 'utf8');
    const vars = {};
    for (const line of content.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      vars[t.slice(0, eq).trim()] = val;
    }
    return vars;
  } catch { return {}; }
}

const TOKEN = loadEnv(join(root, '.env.local'))['VITE_TODOIST_API_TOKEN'];
if (!TOKEN) {
  console.error('ERROR: VITE_TODOIST_API_TOKEN not found in .env.local');
  process.exit(1);
}

const BASE = 'https://api.todoist.com';
const COMMIT = process.argv.includes('--commit');

const UNUSED_PARENT = 'Unused Fair Play Cards';
const KYLE_PARENT = 'My Fair Play Cards';
const AMY_PARENT = "Amy's Fair Play Cards";

async function apiGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
  return res.json();
}
async function fetchAllPages(path) {
  const out = []; let cursor = null;
  do {
    const url = cursor ? `${path}&cursor=${encodeURIComponent(cursor)}` : path;
    const d = await apiGet(url); out.push(...(d.results ?? [])); cursor = d.next_cursor ?? null;
  } while (cursor);
  return out;
}
async function apiDelete(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status} ${res.statusText}: ${await res.text().catch(() => '')}`);
}

const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
const PARTNER_RE = /\s*\(partner\)\s*$/i;

async function main() {
  console.log(`FAIRPLAY · Prune "${UNUSED_PARENT}" — ${COMMIT ? 'COMMIT (will delete)' : 'DRY RUN'}\n`);

  const projects = await fetchAllPages('/api/v1/projects?limit=200');
  const find = (name) =>
    projects.find((p) => p.name === name && p.parent_id === null) ?? projects.find((p) => p.name === name);

  const unusedParent = find(UNUSED_PARENT);
  if (!unusedParent) { console.error(`"${UNUSED_PARENT}" not found.`); process.exit(1); }
  const kyleParent = find(KYLE_PARENT);
  const amyParent = find(AMY_PARENT);

  const cardSet = (parent) =>
    parent
      ? new Set(projects.filter((p) => p.parent_id === parent.id).map((p) => norm(p.name)))
      : new Set();
  const kyleCards = cardSet(kyleParent);
  const amyCards = cardSet(amyParent);
  console.log(`Kyle deck: ${kyleCards.size} cards · Amy deck: ${amyCards.size} cards\n`);

  const tasks = await fetchAllPages(`/api/v1/tasks?project_id=${unusedParent.id}&limit=200`);

  const toDelete = [];
  const toKeep = [];
  for (const t of tasks) {
    const name = t.content;
    let del = false;
    let why = '';
    if (PARTNER_RE.test(name)) {
      const base = norm(name.replace(PARTNER_RE, ''));
      if (kyleCards.has(base) && amyCards.has(base)) { del = true; why = 'both have base card'; }
      else { why = 'partner copy still unclaimed'; }
    } else {
      const n = norm(name);
      const inKyle = kyleCards.has(n);
      const inAmy = amyCards.has(n);
      if (inKyle || inAmy) { del = true; why = inKyle && inAmy ? 'both have it' : inAmy ? 'Amy has it' : 'Kyle has it'; }
    }
    (del ? toDelete : toKeep).push({ name, why, id: t.id });
  }

  console.log(`── DELETE (${toDelete.length}) — now held by a deck ─────────────────────`);
  for (const d of toDelete) console.log(`   ✗ ${d.name}  (${d.why})`);
  console.log(`\n── KEEP (${toKeep.length}) — neither deck has these ─────────────────`);
  for (const k of toKeep) console.log(`   • ${k.name}${k.why ? `  (${k.why})` : ''}`);

  if (COMMIT) {
    console.log(`\nDeleting ${toDelete.length} tasks...`);
    for (const d of toDelete) {
      await apiDelete(`/api/v1/tasks/${d.id}`);
      console.log(`   deleted: ${d.name}`);
    }
    console.log(`\nDone. "${UNUSED_PARENT}" now holds ${toKeep.length} cards (neither deck has them).`);
  } else {
    console.log(`\nDRY RUN — nothing deleted. Re-run with --commit to delete the ${toDelete.length} tasks above.`);
  }
}

main().catch((err) => { console.error('FAILED:', err.message); process.exit(1); });
