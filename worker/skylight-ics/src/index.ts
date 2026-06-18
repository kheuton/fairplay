/**
 * Skylight ICS Worker — main entry point.
 *
 * Routes:
 *   GET /           → help page listing feed URLs
 *   GET /amy.ics    → ICS feed for Amy's Fair Play deck
 *   GET /kyle.ics   → ICS feed for Kyle's Fair Play deck
 *   GET /all.ics    → ICS feed combining both decks
 *
 * Security:
 *   All ICS routes require ?key=<FEED_KEY> when FEED_KEY env var is set.
 *   Returns 401 if key is missing or wrong.
 *   TODOIST_API_TOKEN is never echoed or included in any response or log.
 *
 * Todoist API:
 *   Base: https://api.todoist.com
 *   Auth: Authorization: Bearer <TODOIST_API_TOKEN>
 *   Pagination: cursor-based; appends &cursor=<next_cursor>
 */

import type { Env, RawProject, RawTask, PagedResponse } from './types.js';
import { PROFILES, resolveDeck, buildDeckProjectIds } from './deck.js';
import { buildFeed } from './feed.js';

const TODOIST_BASE = 'https://api.todoist.com';

// ---------------------------------------------------------------------------
// Todoist HTTP helpers (Workers-runtime-safe; no Node APIs)
// ---------------------------------------------------------------------------

async function todoistGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${TODOIST_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 429) {
    // Honour rate-limit: retry once after Retry-After (default 1 s)
    const delay = parseFloat(res.headers.get('Retry-After') ?? '1') * 1000;
    await new Promise((r) => setTimeout(r, delay));
    const retry = await fetch(`${TODOIST_BASE}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!retry.ok) throw new Error(`Todoist GET ${path} → ${retry.status}`);
    return retry.json() as Promise<T>;
  }
  if (!res.ok) throw new Error(`Todoist GET ${path} → ${res.status}`);
  return res.json() as Promise<T>;
}

/** Fetch all pages for a cursor-paginated endpoint (envelope key: "results"). */
async function fetchAllPages<T>(path: string, token: string): Promise<T[]> {
  const all: T[] = [];
  let cursor: string | undefined;

  do {
    const sep = path.includes('?') ? '&' : '?';
    const url = cursor ? `${path}${sep}cursor=${encodeURIComponent(cursor)}` : path;
    const page = await todoistGet<PagedResponse<T>>(url, token);
    all.push(...page.results);
    cursor = page.next_cursor;
  } while (cursor);

  return all;
}

/** Fetch all projects from Todoist (paginated). */
async function fetchProjects(token: string): Promise<RawProject[]> {
  return fetchAllPages<RawProject>('/api/v1/projects?limit=200', token);
}

/** Fetch all tasks for a given project_id (paginated, active tasks only). */
async function fetchTasksForProject(projectId: string, token: string): Promise<RawTask[]> {
  return fetchAllPages<RawTask>(
    `/api/v1/tasks?project_id=${encodeURIComponent(projectId)}&limit=200`,
    token
  );
}

// ---------------------------------------------------------------------------
// Feed generation
// ---------------------------------------------------------------------------

async function generateFeed(
  profileIds: Array<'amy' | 'kyle'>,
  calName: string,
  token: string
): Promise<string> {
  // Fetch all projects once
  const projects = await fetchProjects(token);

  // Resolve each profile's deck
  const allDecks = profileIds.map((pid) =>
    resolveDeck(projects, PROFILES[pid].deckParent)
  );

  // Collect all unique deck project IDs
  const projectIds = buildDeckProjectIds(allDecks);

  // Fetch tasks for each deck project in parallel
  const taskArrays = await Promise.all(
    [...projectIds].map((pid) => fetchTasksForProject(pid, token))
  );

  const allTasks = taskArrays.flat();

  return buildFeed(allTasks, calName);
}

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------

function checkKey(request: Request, env: Env): boolean {
  const feedKey = env.FEED_KEY;
  // If FEED_KEY is not configured, feeds are open (useful for local dev)
  if (!feedKey) return true;
  const url = new URL(request.url);
  const provided = url.searchParams.get('key');
  // Constant-time comparison via crypto.subtle.timingSafeEqual is ideal but
  // not available in all Workers runtimes; use simple string compare for now.
  // The key is unguessable by URL secrecy, not timing safety.
  return provided === feedKey;
}

// ---------------------------------------------------------------------------
// Help page
// ---------------------------------------------------------------------------

function helpPage(baseUrl: string, hasKey: boolean): string {
  const keyNote = hasKey
    ? '<p>Feeds require <code>?key=YOUR_FEED_KEY</code> appended to the URL.</p>'
    : '<p>No FEED_KEY configured — feeds are open. Set <code>FEED_KEY</code> in wrangler to require authentication.</p>';

  const suffix = hasKey ? '?key=YOUR_FEED_KEY' : '';

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>FairPlay Skylight ICS</title></head>
<body>
<h1>FairPlay Skylight ICS Feed</h1>
${keyNote}
<ul>
  <li><a href="${baseUrl}/amy.ics${suffix}">${baseUrl}/amy.ics${suffix}</a> — Amy's chores</li>
  <li><a href="${baseUrl}/kyle.ics${suffix}">${baseUrl}/kyle.ics${suffix}</a> — Kyle's chores</li>
  <li><a href="${baseUrl}/all.ics${suffix}">${baseUrl}/all.ics${suffix}</a> — All chores (both decks)</li>
</ul>
<p>Subscribe by copying a URL above into Skylight: <em>Sync new calendar → Calendar URL</em>.</p>
<p>Note: Skylight refreshes approximately every 15–30 minutes.</p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Worker fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    // Only handle GET
    if (request.method !== 'GET') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // Help page
    if (pathname === '/' || pathname === '') {
      const base = `${url.protocol}//${url.host}`;
      return new Response(helpPage(base, !!env.FEED_KEY), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ICS routes — check auth first
    if (pathname === '/amy.ics' || pathname === '/kyle.ics' || pathname === '/all.ics') {
      if (!checkKey(request, env)) {
        return new Response('Unauthorized: missing or invalid ?key parameter', {
          status: 401,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      if (!env.TODOIST_API_TOKEN) {
        return new Response('Internal Server Error: TODOIST_API_TOKEN not configured', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      try {
        let icsBody: string;

        if (pathname === '/amy.ics') {
          icsBody = await generateFeed(['amy'], "Amy's Fair Play Chores", env.TODOIST_API_TOKEN);
        } else if (pathname === '/kyle.ics') {
          icsBody = await generateFeed(['kyle'], "Kyle's Fair Play Chores", env.TODOIST_API_TOKEN);
        } else {
          // /all.ics
          icsBody = await generateFeed(
            ['amy', 'kyle'],
            'Fair Play Chores (All)',
            env.TODOIST_API_TOKEN
          );
        }

        return new Response(icsBody, {
          headers: {
            'Content-Type': 'text/calendar; charset=utf-8',
            'Content-Disposition': `attachment; filename="${pathname.slice(1)}"`,
            // Prevent caching at the CDN level so each request is fresh
            'Cache-Control': 'no-store',
          },
        });
      } catch (err) {
        // Log the error message (not the token) for debugging
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[skylight-ics] Error generating ${pathname}:`, msg);
        return new Response(`Error generating feed: ${msg}`, {
          status: 502,
          headers: { 'Content-Type': 'text/plain' },
        });
      }
    }

    return new Response('Not Found', { status: 404 });
  },
};
