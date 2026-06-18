# Skylight ICS Worker

A Cloudflare Worker that reads FairPlay chore data from Todoist and serves iCalendar (.ics) feeds. Subscribe to these feeds on your Skylight calendar display.

## Routes

| URL | Content |
|-----|---------|
| `/` | Help page listing all feed URLs |
| `/amy.ics?key=<FEED_KEY>` | Amy's Fair Play chores |
| `/kyle.ics?key=<FEED_KEY>` | Kyle's Fair Play chores |
| `/all.ics?key=<FEED_KEY>` | All chores (both decks combined) |

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/) (free tier is fine)
- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/): `npm install -g wrangler`
- Your Todoist personal API token (Settings → Integrations → Developer → API token)

## Setup & Deploy

### 1. Install dependencies

```bash
cd worker/skylight-ics
npm install
```

### 2. Authenticate with Cloudflare

```bash
wrangler login
```

### 3. Set secrets

```bash
# Your Todoist personal API token — NEVER commit this
wrangler secret put TODOIST_API_TOKEN

# A random shared secret for the ?key= URL parameter (keep it private)
# Generate one with: openssl rand -hex 32
wrangler secret put FEED_KEY
```

### 4. Deploy

```bash
npm run deploy
```

Wrangler will print your Worker URL, e.g.:
```
https://skylight-ics.<your-account>.workers.dev
```

### 5. Test the feed

```bash
curl "https://skylight-ics.<your-account>.workers.dev/kyle.ics?key=<your-FEED-KEY>"
```

You should see a `text/calendar` response with `BEGIN:VCALENDAR`.

## Adding to Skylight

1. Open the Skylight app or web interface.
2. Go to **Settings → Calendars → Sync new calendar**.
3. Choose **Calendar URL** (not Google/Apple/etc).
4. Paste the full feed URL, e.g.:
   ```
   https://skylight-ics.<your-account>.workers.dev/kyle.ics?key=<your-FEED-KEY>
   ```
5. Skylight will fetch the feed and display the chores on the calendar.

## Local Development

Create a `.dev.vars` file (gitignored) for local secrets:

```
TODOIST_API_TOKEN=your_token_here
FEED_KEY=any_string_for_local_testing
```

Then run:

```bash
npm run dev
```

The worker runs at `http://localhost:8787`.

## Running Tests

Tests use the repo's root Vitest installation (no separate install needed):

```bash
# From the repo root:
npx vitest run --config worker/skylight-ics/vitest.config.ts

# Or from this directory:
npm test
```

## Type Checking

```bash
npm run typecheck
```

## Known Limitations

1. **Display only / one-way.** This is a read-only ICS feed. Completing a chore on Skylight does NOT sync back to Todoist. Chore completion must be done in the FairPlay app or Todoist directly.

2. **Skylight refresh interval.** Skylight typically polls subscribed calendar feeds every 15–30 minutes. Changes in Todoist (new tasks, rescheduled due dates) will not appear instantly on Skylight.

3. **Recurrence mapping.** The worker maps Todoist's natural-language recurrence strings (e.g. "every day", "every monday") to RFC-5545 RRULEs. Complex patterns that cannot be safely mapped (e.g. "every other week", "every 2nd Tuesday") fall back to a single one-time event on the next due date. The original Todoist string is stored in the `X-FP-RECUR` property for traceability.

4. **DST / timezone.** Timed events (those with a specific time in Todoist) are treated as UTC. If a task's configured timezone differs from UTC, the displayed time may be off by the UTC offset. All-day events (the majority of chores) are unaffected.

5. **Completed tasks excluded.** Tasks marked `checked=true` in Todoist are not included in the feed (they have no future occurrences to show).

6. **No real-time updates.** There is no webhook integration. The feed is generated fresh on every HTTP request to the Worker.

## Architecture

```
src/
  types.ts      — Shared TypeScript types (RawTask, RawProject, Env, etc.)
  deck.ts       — Deck resolution: finds card projects under the deck parent
  metadata.ts   — parseFp(): strips FP:: metadata from task descriptions
  recur.ts      — Todoist NL due.string → RFC-5545 RRULE converter
  ics.ts        — RFC-5545 builder: escaping, folding, VEVENT, VCALENDAR
  feed.ts       — Task[] → ICS string (filtering + orchestration)
  index.ts      — Cloudflare Worker fetch handler (routing + Todoist HTTP client)
```
