/**
 * Read-only inspection of FairPlay inventory state in Todoist.
 * Lists deck parents, their child (card) projects, and existing FP-item tasks.
 * NEVER prints the token.
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
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      vars[key] = val;
    }
    return vars;
  } catch { return {}; }
}

const TOKEN = loadEnv(join(root, '.env.local'))['VITE_TODOIST_API_TOKEN'];
if (!TOKEN) { console.error('no token'); process.exit(1); }
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

const PARENTS = ["Amy's Fair Play Cards", 'My Fair Play Cards'];

const projects = await getAll('/api/v1/projects?limit=200');
const byId = new Map(projects.map(p => [p.id, p]));
const tasks = await getAll('/api/v1/tasks?limit=200');

for (const parentName of PARENTS) {
  const parent = projects.find(p => p.name === parentName);
  if (!parent) { console.log(`\n## ${parentName}  — NOT FOUND`); continue; }
  const children = projects.filter(p => p.parent_id === parent.id).sort((a, b) => a.name.localeCompare(b.name));
  console.log(`\n## ${parentName}  (id ${parent.id}) — ${children.length} cards`);
  for (const c of children) {
    const items = tasks.filter(t => t.project_id === c.id && (t.labels ?? []).includes('FP-item'));
    const tag = items.length ? `  [${items.length} FP-item]` : '';
    console.log(`  - ${c.name}${tag}`);
    for (const it of items) {
      let icon = '?', count = '?';
      const desc = it.description ?? '';
      const m = desc.split('\n').find(l => l.startsWith('FP::'));
      if (m) { try { const j = JSON.parse(m.slice(4)); icon = j.inv?.icon ?? '?'; count = j.inv?.count ?? '?'; } catch {} }
      console.log(`      · ${it.content}  (icon=${icon} count=${count})`);
    }
  }
}
