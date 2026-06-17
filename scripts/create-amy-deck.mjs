/**
 * FAIRPLAY · Create Amy's Fair Play deck in Todoist
 *
 * Usage:
 *   node scripts/create-amy-deck.mjs           — dry run (no writes, prints plan)
 *   node scripts/create-amy-deck.mjs --commit  — performs writes
 *
 * Reads VITE_TODOIST_API_TOKEN from .env.local. NEVER prints the token.
 * Safe to re-run: idempotent — reuses existing projects, moves from
 * "Unused Fair Play Cards" when possible, skips existing charters.
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
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
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

async function apiPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST ${path} → ${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return {};
  return res.json();
}

async function apiDelete(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`DELETE ${path} → ${res.status} ${res.statusText}: ${text}`);
  }
}

// FP carrier task labels — these are app metadata, not real to-dos. A project
// holding only carriers (or nothing) is considered "stray cruft" and safe to delete.
const CARRIER_LABELS = ['FP-charter', 'FP-item', 'FP-config'];

// ─── Deck spec ────────────────────────────────────────────────────────────────

const AMY_PARENT_NAME = "Amy's Fair Play Cards";
const UNUSED_PARENT_NAME = 'Unused Fair Play Cards';

const CARDS = [
  {
    name: 'Dishes',
    kind: 'timeline',
    category: 'HOME',
    msc: 'Sink empty, dishwasher run and unloaded, counters wiped.',
  },
  {
    name: 'Laundry',
    kind: 'timeline',
    category: 'HOME',
    msc: 'Hampers clear; clothes washed, dried, folded and put away.',
  },
  {
    name: 'Cleaning',
    kind: 'timeline',
    category: 'HOME',
    msc: 'Floors, surfaces and bathrooms cleaned on a regular cadence.',
  },
  {
    name: 'Tidying, organizing & donations',
    kind: 'timeline',
    category: 'HOME',
    msc: 'Common areas tidy; clutter sorted; donations boxed and dropped off.',
  },
  {
    name: 'Storage, garage & seasonal items',
    kind: 'timeline',
    category: 'HOME',
    msc: 'Seasonal gear stored, labeled and findable; garage walkable.',
  },
  {
    name: 'Mail',
    kind: 'timeline',
    category: 'HOME',
    msc: "Mail collected, sorted, actioned and recycled; nothing important missed.",
  },
  {
    name: 'Groceries',
    kind: 'inventory',
    category: 'HOME',
    msc: 'Staples kept in stock; shopping done before we run out.',
  },
  {
    name: 'First aid, safety & emergency',
    kind: 'inventory',
    category: 'HOME',
    msc: 'Kits stocked, supplies in date, emergency plan current.',
  },
  {
    name: 'Packing & unpacking (travel)',
    kind: 'timeline',
    category: 'OUT',
    msc: 'Everyone packed with what they need; unpacked and reset after.',
  },
  {
    name: 'Travel',
    kind: 'timeline',
    category: 'OUT',
    msc: 'Trips researched, booked and itineraries shared ahead of time.',
  },
  {
    name: 'Homework, projects & school supplies (kids)',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Homework done on time; projects planned ahead; supplies on hand.',
  },
  {
    name: 'Clothes & accessories (kids)',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Kids have clean, weather and size appropriate clothing ready.',
  },
  {
    name: 'Friendship & social media (kids)',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Kids friendships supported; online activity age appropriate and monitored.',
  },
  {
    name: 'Informal education (kids)',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Everyday learning and curiosity nurtured outside school.',
  },
  {
    name: 'Discipline & screen time',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Consistent limits and expectations applied calmly across the household.',
  },
  {
    name: 'Calendar keeper',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Family calendar current; everyone knows what is happening when.',
  },
  {
    name: 'Childcare helpers',
    kind: 'timeline',
    category: 'CAREGIVING',
    msc: 'Reliable care arranged, briefed and paid; backups lined up.',
  },
  {
    name: 'Extended family',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Relationships maintained; visits, calls and milestones kept up.',
  },
  {
    name: 'Spirituality',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Family spiritual practices and community supported.',
  },
  {
    name: 'Holidays',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Holidays planned, prepped and celebrated to our family standard.',
  },
  {
    name: 'Holiday cards',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Cards designed, addressed and mailed on time.',
  },
  {
    name: 'Hosting',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Guests welcomed; home, food and plan ready before they arrive.',
  },
  {
    name: 'Thank-you notes',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Thank-yous written and sent promptly after gifts and events.',
  },
  {
    name: 'Memories & photos',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Photos captured, backed up and turned into albums or prints.',
  },
  {
    name: 'Birthday celebrations (your kids)',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Birthdays planned and celebrated the way each child would love it.',
  },
  {
    name: 'Gifts (family)',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Thoughtful gifts chosen, bought and wrapped on time for family.',
  },
  {
    name: 'Social plans (couples)',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Plans with other couples proposed, scheduled and confirmed.',
  },
  {
    name: 'Weekend plans',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Weekends have a loose plan the whole family looks forward to.',
  },
  // Amy's "happy trio" — mirrors Kyle's deck (same names, MAGIC/timeline).
  {
    name: 'Self-care',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Time and space protected for rest, health and personal upkeep.',
  },
  {
    name: 'Adult friendships',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Friendships nurtured; plans made and kept with the people who matter.',
  },
  {
    name: 'Unicorn Space',
    kind: 'timeline',
    category: 'MAGIC',
    msc: 'Regular time for a creative or intellectual pursuit that is just for you.',
  },
];

// ─── Charter serialization ────────────────────────────────────────────────────

function buildCharterDescription(msc) {
  const sections = [
    `## Minimum Standard of Care\n${msc}`,
    '## Conception\nnotice & anticipate what this needs before it\'s urgent',
    '## Planning\nresearch options, decide, and schedule',
    '## Execution\ncarry it out to the agreed standard',
  ];
  return (
    sections.join('\n\n') +
    '\n' +
    'FP::' +
    JSON.stringify({ charter: { revised: '2026-06-16' } })
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const COMMIT = process.argv.includes('--commit');
  const mode = COMMIT ? 'COMMIT' : 'DRY RUN';

  console.log(`FAIRPLAY · Create Amy's Deck — ${mode}\n`);

  // ── 1. Fetch all projects ──────────────────────────────────────────────────
  console.log('Fetching projects...');
  const allProjects = await fetchAllPages('/api/v1/projects?limit=200');
  console.log(`  ${allProjects.length} total projects\n`);

  // ── 2. Find (or create) the Amy parent project ─────────────────────────────
  let amyParent =
    allProjects.find((p) => p.name === AMY_PARENT_NAME && p.parent_id === null) ??
    allProjects.find((p) => p.name === AMY_PARENT_NAME);

  let counts = { reuse: 0, move: 0, create: 0, deletedStray: 0, charter: 0, charterSkip: 0 };

  if (!amyParent) {
    if (COMMIT) {
      console.log(`Creating parent project "${AMY_PARENT_NAME}"...`);
      amyParent = await apiPost('/api/v1/projects', { name: AMY_PARENT_NAME });
      console.log(`  Created parent id=${amyParent.id}`);
      // Add newly created parent to allProjects so child lookups work
      allProjects.push(amyParent);
    } else {
      console.log(`  [DRY RUN] would CREATE parent "${AMY_PARENT_NAME}"`);
      // Fabricate a placeholder so the rest of the plan can continue
      amyParent = { id: '__amy_parent__', name: AMY_PARENT_NAME, parent_id: null };
      allProjects.push(amyParent);
    }
  } else {
    console.log(`Found parent "${AMY_PARENT_NAME}" id=${amyParent.id}\n`);
  }

  // Identify "Unused Fair Play Cards" parent for move logic
  const unusedParent =
    allProjects.find((p) => p.name === UNUSED_PARENT_NAME && p.parent_id === null) ??
    allProjects.find((p) => p.name === UNUSED_PARENT_NAME);

  // Build a quick lookup of current children of the Amy parent
  // (re-query after potential parent creation so we have the right id)
  const amyChildren = allProjects.filter((p) => p.parent_id === amyParent.id);
  const amyChildByName = new Map(amyChildren.map((p) => [p.name, p]));

  // Build lookup for children of "Unused" parent
  const unusedChildren = unusedParent
    ? allProjects.filter((p) => p.parent_id === unusedParent.id)
    : [];
  const unusedChildByName = new Map(unusedChildren.map((p) => [p.name, p]));

  // ── 3. Process each card ───────────────────────────────────────────────────
  console.log('Processing cards:\n');

  for (let i = 0; i < CARDS.length; i++) {
    const card = CARDS[i];
    const childOrder = i + 1;
    let cardProject = null;

    if (amyChildByName.has(card.name)) {
      // (a) Already exists under Amy parent — reuse, normalizing child_order so
      // re-runs keep the deck in the intended sequence (deck.ts sorts by it).
      cardProject = amyChildByName.get(card.name);
      console.log(`  [${String(childOrder).padStart(2, '0')}] REUSE   "${card.name}" id=${cardProject.id}`);
      if (cardProject.child_order !== childOrder) {
        if (COMMIT) {
          await apiPost(`/api/v1/projects/${cardProject.id}`, { child_order: childOrder });
          console.log(`          normalized child_order ${cardProject.child_order} → ${childOrder}`);
        } else {
          console.log(`          [DRY RUN] would normalize child_order ${cardProject.child_order} → ${childOrder}`);
        }
      }
      counts.reuse++;
    } else if (unusedChildByName.has(card.name)) {
      // (b) A same-named project exists under "Unused Fair Play Cards".
      //   • If it has NO real open tasks (only FP carrier tasks, or empty) and no
      //     sub-projects, it's stray cruft → DELETE it, then CREATE fresh under Amy.
      //   • If it has real open work (or sub-projects), leave it untouched and
      //     CREATE fresh under Amy (a duplicate name results — flagged for cleanup).
      // Only ever touches children of "Unused Fair Play Cards"; never Kyle's deck.
      const num = String(childOrder).padStart(2, '0');
      const candidate = unusedChildByName.get(card.name);
      const hasChildProjects = allProjects.some((p) => p.parent_id === candidate.id);
      const tasks = await fetchAllPages(
        `/api/v1/tasks?project_id=${candidate.id}&limit=200`
      );
      const realOpen = tasks.filter(
        (t) => !t.checked && !(t.labels ?? []).some((l) => CARRIER_LABELS.includes(l))
      );

      if (realOpen.length === 0 && !hasChildProjects) {
        if (COMMIT) {
          console.log(`  [${num}] DELETE  stray "${card.name}" under "${UNUSED_PARENT_NAME}" (no real tasks)...`);
          await apiDelete(`/api/v1/projects/${candidate.id}`);
          console.log(`  [${num}] CREATE  "${card.name}"...`);
          cardProject = await apiPost('/api/v1/projects', {
            name: card.name,
            parent_id: amyParent.id,
            child_order: childOrder,
          });
          console.log(`          Created id=${cardProject.id}`);
        } else {
          console.log(`  [${num}] [DRY RUN] would DELETE stray "${card.name}" under "${UNUSED_PARENT_NAME}", then CREATE fresh`);
          cardProject = { id: `__new_${i}__`, name: card.name };
        }
        counts.deletedStray++;
        counts.create++;
      } else {
        const reason = hasChildProjects ? 'has sub-projects' : `has ${realOpen.length} real open task(s)`;
        if (COMMIT) {
          console.log(`  [${num}] CREATE  "${card.name}" (Unused copy ${reason} — left intact, duplicate name)...`);
          cardProject = await apiPost('/api/v1/projects', {
            name: card.name,
            parent_id: amyParent.id,
            child_order: childOrder,
          });
          console.log(`          Created id=${cardProject.id}`);
        } else {
          console.log(`  [${num}] [DRY RUN] would CREATE "${card.name}" (Unused copy ${reason} — left intact, duplicate name)`);
          cardProject = { id: `__new_${i}__`, name: card.name };
        }
        counts.create++;
      }
    } else {
      // (c) Does not exist — create
      if (COMMIT) {
        console.log(`  [${String(childOrder).padStart(2, '0')}] CREATE  "${card.name}"...`);
        cardProject = await apiPost('/api/v1/projects', {
          name: card.name,
          parent_id: amyParent.id,
          child_order: childOrder,
        });
        console.log(`          Created id=${cardProject.id}`);
      } else {
        console.log(
          `  [${String(childOrder).padStart(2, '0')}] [DRY RUN] would CREATE "${card.name}"`
        );
        cardProject = { id: `__new_${i}__`, name: card.name };
      }
      counts.create++;
    }

    // ── Charter task ─────────────────────────────────────────────────────────
    // Skip charter check for placeholder ids in dry-run (no real project to query)
    const isPlaceholder = cardProject.id.startsWith('__');

    let hasCharter = false;
    if (!isPlaceholder) {
      const tasks = await fetchAllPages(
        `/api/v1/tasks?project_id=${cardProject.id}&limit=200`
      );
      hasCharter = tasks.some((t) => t.labels?.includes('FP-charter'));
    }

    if (hasCharter) {
      console.log(`           charter: already exists — skip`);
      counts.charterSkip++;
    } else if (COMMIT && !isPlaceholder) {
      console.log(`           charter: creating...`);
      await apiPost('/api/v1/tasks', {
        content: `Card charter — ${card.name}`,
        project_id: cardProject.id,
        labels: ['FP-charter'],
        description: buildCharterDescription(card.msc),
      });
      console.log(`           charter: created`);
      counts.charter++;
    } else {
      console.log(`           charter: [DRY RUN] would CREATE charter for "${card.name}"`);
      counts.charter++;
    }
  }

  // ── 4. Summary ────────────────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────');
  console.log('Summary:');
  console.log(`  Reused existing projects : ${counts.reuse}`);
  console.log(`  Moved from Unused        : ${counts.move}`);
  console.log(`  Deleted stray (Unused)   : ${counts.deletedStray}`);
  console.log(`  Created new projects     : ${counts.create}`);
  console.log(`  Charters to create       : ${counts.charter}`);
  console.log(`  Charters already present : ${counts.charterSkip}`);
  console.log('─────────────────────────────────────────');

  if (!COMMIT) {
    console.log('\nThis was a DRY RUN — no changes were made.');
    console.log('Re-run with --commit to apply:\n  node scripts/create-amy-deck.mjs --commit');
  } else {
    console.log("\nDone. Amy's Fair Play deck is set up in Todoist.");
  }
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
