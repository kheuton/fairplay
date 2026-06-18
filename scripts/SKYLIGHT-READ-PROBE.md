# Skylight Read-Only Diagnostic Probe

## Purpose

`skylight-read-probe.mjs` is a **read-only** diagnostic script that runs a
battery of labeled GET-request variations against the Skylight chores API to
find out which query actually returns chore data from your account.  It does
not create, update, or delete anything.

## Before you run: add a chore on the physical device

The probe is most useful when there is at least one chore on the device to find.

1. Open the Skylight app or calendar on your physical device.
2. Add any test chore (e.g. "test task") assigned to Kyle or Amy, due today
   or a nearby date.
3. Optionally note the chore's ID from the web URL
   (`https://ourskylight.com/calendar/5381689/tasks?...`) if you can find it —
   set it as `SKYLIGHT_KNOWN_CHORE_ID` to enable the single-fetch variation.
4. Run the probe (see below).

## How to run

```sh
SKYLIGHT_EMAIL="you@example.com" \
SKYLIGHT_PASSWORD="yourpass" \
SKYLIGHT_FRAME_ID="5381689" \
node scripts/skylight-read-probe.mjs
```

Optional environment variables:

| Variable                  | Description                                                       |
|---------------------------|-------------------------------------------------------------------|
| `SKYLIGHT_PROFILE_ID`     | From `?profileId=<id>` in the Skylight web URL.  Enables V11.    |
| `SKYLIGHT_KNOWN_CHORE_ID` | Integer chore ID from the device.  Enables V13 (single-fetch).   |

## How to read the output

Each variation is labelled `V1` through `V14`, plus `C1`–`C3` for the completed-item hunt, `L1`–`L2` for the Lists surface, `P1`–`P2` for per-profile probes, and a SEARCH STEP that scans all items. Each section shows:

- The full request URL
- HTTP status
- Item count returned
- A compact table: `ID | SUMMARY | STATUS | START | COMPLETED_ON | CAT_ID | RECUR`
  - Any chore with `status == "complete"` or `completed_on != null` is labelled `[COMPLETED]`
- Full raw JSON (no truncation)

The final **SUMMARY** section lists which variation(s) returned data, any
`[COMPLETED]` chores found across all variations (deduplicated), and the
winning query.

### Lists surface — L1, L2

`GET /api/frames/{frame}/lists` (L1) returns ALL lists for the frame with ALL
list items sideloaded in the top-level `included` array.  No pagination, no
profile scoping.  This is expected to contain Amy's items ("Mail", "Groceries",
"Coffee Prepped", "Laundry", "Dishes") and possibly Kyle's "Inbound test
delete" if it was added via the Lists surface rather than the Tasks button.

List item attributes: `{ label, status ("pending"|"completed"), section, position, created_at }`.
No `due_date`, no `profile_id`.

`L2` drills into each individual list returned by L1 via
`GET /api/frames/{frame}/lists/{listId}` to cross-check item membership.

Sources: `rjhalvorson/skylight-mcp src/api/endpoints/lists.ts`,
`TheEagleByte/skylight-api openapi.yaml`.

### Per-profile probes — P1, P2

Research confirms there is **no `profile_id` / `category_id` query param** on
the chores endpoint.  The web app's `?profileId=` is a pure client-side UI
filter.

- **P1a**: wide window, no filter, client-side split by `relationships.category.data.id`
  (Kyle = 20976592, Amy = 20976818, others shown separately).
- **P1b / P1c / P2a / P2b**: undocumented `profile_id=` and `person_id=` params
  tested for Kyle and Amy respectively.  A 404/422 confirms these params don't
  exist server-side.

Source: per-profile-scoping investigation findings.

### Search step

After all endpoint queries complete, the probe scans the **entire return corpus**
(all chores across V1–V14/C1–C3/P1–P2, all list items from L1/L2, all
task_box items from V12) for the string `"Inbound test"` (case-insensitive).
It reports:
- Which endpoint/variation the match was found in
- The full item object (pretty-printed)

It also scans for Amy's named items ("Groceries", "Coffee Prepped", "Laundry",
"Dishes", "Mail") and reports where they appear.

This directly tells you: did the mobile Tasks button create a **chore** (in
`/chores`) or a **list item** (in `/lists`)?

### task_box/items — V12

`GET /api/frames/{frame}/task_box/items` is **not paginated**.  Per the
OpenAPI spec (TheEagleByte/skylight-api), the response is a flat JSON:API
array with no `links`/`meta`/cursor block.  The probe prints ALL items as a
numbered table (`# | ID | SUMMARY | EMOJI | ROUTINE | REWARD_PTS`) and the
full raw JSON.

`task_box_item` objects have **no status or completed_on field**.  Completing
a task_box item on the device **converts it into a `chore`** (visible in
`/chores` with `status:"complete"` and `completed_on` set).

### Completed-item hunt — C1–C3

Three additional queries specifically hunting for device-created completed tasks:

| Label | Query | Purpose |
|---|---|---|
| C1 | `/chores?after=…&before=…&include_late=true` (no filter) | Finds chores under any category, including newly-created device chores that may not have `linked_to_profile:true` |
| C2 | `/chores?…&filter=linked_to_profile&include_late=true` | Same as V5; re-run here with explicit `[COMPLETED]` labelling |
| C3 | `/chores?…&status=complete` (exploratory) | Tests an undocumented `status=` filter param; a 422/400 is expected/informative |

### What to look for

| Observation | Meaning |
|---|---|
| V2 (filter=linked_to_profile) returns items but V1 (no filter) does not | The API requires `filter=linked_to_profile` and your categories have `linked_to_profile:true` |
| V1 returns items but V2 returns 0 | Your categories have `linked_to_profile:false`; the filter must be OMITTED for your account |
| V4/V5 (wide ±365d window) returns items but V1 does not | The chore's start date is outside the default 30-day/90-day window |
| V6/V7 (no date params) 422s | Date params are required |
| V12 (task_box) returns items | These are backlog tasks only — no status field; completing one creates a chore |
| C1 returns items C2 does not | Device-created chores are under a category without `linked_to_profile:true` |
| Any row shows `[COMPLETED]` | Found a completed chore — attributes.completed_on has the completion date |
| V14 shows all categories have `linked_to_profile: false` | Confirms that `filter=linked_to_profile` will always return 0 for this account |
| L1 returns list items with "Mail", "Groceries" etc. | Amy's items are in the Lists surface, not /chores |
| L1 returns a list item with "Inbound test" | Kyle's task was added via Lists, not the Tasks button |
| Search step finds "Inbound test" in a chore | Kyle's task is a chore — the Tasks button creates chores |
| Search step finds "Inbound test" in L1/L2 | Kyle's task is a list item — the Tasks button creates list items |
| P1b/P1c/P2a/P2b return 422 or same count as P1a | No server-side profile_id/person_id param exists |
| All variations return 0 | See the CONCLUSION section in the script output for next steps |

### Inbound sync attributes (once working)

A pending chore: `attributes.status = "pending"`, `attributes.completed_on = null`

A chore completed on-device: `attributes.status = "complete"`, `attributes.completed_on = "YYYY-MM-DD"`

The category (person) is in `relationships.category.data.id`.

## Legal note

This script uses Skylight's unofficial reverse-engineered API.  It is intended
for personal use by the account owner only and may violate Skylight's Terms of
Service.  Use at your own risk.
