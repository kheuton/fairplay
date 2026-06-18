# FairPlay ⇄ Skylight — Phase 2 Two-Way Sync Design (v2, hardened post-red-team)

**Status:** design / not yet built · **Date:** 2026-06-18 · **Revision:** v2 (4-lens adversarial review applied)
**Prereq proven:** chore create/assign/complete/delete + read-with-status confirmed on real frame `5356033` ("heutoncal"). **List-item *writes* are NOT yet proven** (see §11).

> **What the red-team changed (read this first).** A 4-lens adversarial review found ~23 concrete failure modes, mostly converging on five root causes — all fixed below:
> 1. **Echo guard must be content-fingerprint, not wall-clock** (cron jitter made the time window both leak and stick). → §8
> 2. **Per-occurrence / per-item status, both edges** (the single scalar latch dropped reopens and the next recurring occurrence). → §6, §7
> 3. **Recurrence = "rolling one-time chore per occurrence"** (a recurring Todoist *advances* one id; it never "closes" — a native recurring chore can't track that). → §5
> 4. **Structural wrong-frame guard + read-back-verify every write** (the 5381689-vs-5356033 bug must be impossible, not just avoided). → §9
> 5. **Lists deferred behind a write-probe** (unverified mechanics, no mappable id). → §11

---

## 0. Decisions locked — and the one the review forces us to revise

| # | Your decision | Status after review |
|---|---|---|
| 1 | Start with a **single task**, dry-run → test frame → real | ✅ kept (even more important) |
| 2 | **Full two-way** from day 1 | ✅ kept — but the engine is rebuilt to survive it (§7/§8) |
| 3 | **Recurrence in scope** | ✅ kept — via the rolling-occurrence model (§5), not native RRULE chores |
| 4 | **Keep no-due tasks → Lists** | ⚠️ **goal kept, but Lists can't ship in v1.** We never proved list-item writes; doing it blind risks clobbering your ~30 real list items. **v1 SKIPS no-due tasks (logged, visibly), and Lists becomes phase 2c after a write-probe (§11).** *Needs your nod.* |
| 5 | **Visible `▸` tag** | ✅ kept — but as a *secondary* signal only (§9); never a matcher |

---

## 1. Goal & the safety invariant

Sync FairPlay (Todoist) ⇄ Skylight **chores**, two-way, **without ever harming the family's ~479 chores / ~30 list items**. Todoist is the source of truth; Skylight is a projection + a completion input.

**The invariant (now belt-and-suspenders):** the bridge writes to a Skylight object only when **all** hold:
1. its id is in our D1 map with `state='active'`, **and** `mapping.frame_id == the frame we're writing to**, **and**
2. a **read-back GET by id** confirms the live object still carries **our exact stored fingerprint** (summary sentinel + created marker), **and**
3. we are on the **fingerprinted frame** (startup asserts `GET /frames/{id}.name == expected`), **and**
4. `DRYRUN` is off — enforced **inside the HTTP client** for every non-GET (§9).

Any check fails → **do nothing, log `needs_review`**. The map is never assumed to be a faithful mirror; every write re-validates against the live resource.

---

## 2. Architecture

Cloudflare Worker (cron) + **D1** (id-map + state machine) + **KV** (tokens, frame fingerprint, lease). Talks to Todoist (REST/Sync, personal token) and the unofficial Skylight API (PKCE OAuth, one `skylight-client.ts` module).

**Single-writer:** a **lease** (D1 row or Durable Object) taken at the top of each run; a second cron tick that finds an unexpired lease exits immediately. Plus a `UNIQUE(todoist_id, frame_id, occurrence_date)` constraint so a racing create fails at the DB before a second device-create.

---

## 3. Scope & phasing (revised)

| Phase | Deliverable | Gate |
|---|---|---|
| **2a** | **One non-recurring task**, full two-way, with the *entire* hardened engine (fingerprint echo, write-ahead intent, frame guard, read-back-verify, lease, DRYRUN-at-client). Dry-run → test frame → real frame. | the engine is the point; prove it bulletproof on the simplest case |
| **2b** | **Recurrence** via the rolling-occurrence model (§5) | only after 2a is stable |
| **2c** | **Lists** for no-due tasks — **only after** a list-item write-probe proves create/complete/delete + the real status string + that the create returns a mappable id (§11) | gated on the probe |
| 2d | Widen scope (more cards), observability polish | — |

In-scope object: FairPlay deck tasks (card sub-projects), carriers excluded. **Tasks with a due date → chores. No-due tasks → skipped+logged until 2c.**

Profile→category: enumerate `GET /api/frames/5356033/categories` at setup, store `{amy,kyle}→catId` in config (real-frame ids differ; a completed chore was under `cat 21035874`).

---

## 4. Field mapping (Todoist task ↔ Skylight chore)

| Todoist | Skylight chore | Notes |
|---|---|---|
| `content` (FP:: stripped) | `summary` | + the `▸`+token sentinel (§9); store the **exact** expected summary in the map |
| `due.date` / `datetime` | `start` / `start_time` | **current occurrence only** (§5) |
| profile | `category_id` + `category_ids:[id]` | from config |
| completion | `status:"complete"` | flat body; never JSON:API; never `"completed"` |
| — | `completed_on` | read on inbound |

---

## 5. Recurrence model — "rolling one-time chore per current occurrence" (the core fix)

A recurring Todoist task **advances the same id** to the next due date on completion; it never closes. A native Skylight recurring chore (template + dated occurrences) can't represent that without constant drift. So **we never create recurring Skylight chores.** Instead:

- For a recurring (or one-time) Todoist task `T`, materialize **only its current due occurrence** as a **non-recurring** Skylight chore `C` (`recurring:false`, `start=T.due.date`). Map row keyed **`(todoist_id, occurrence_date)`**.
- **Device completes C** → advance `T` in Todoist (its due rolls forward) → **delete C** (one-time `DELETE /chores/{id}`, no `apply_to`) → **create the next occurrence** `C'` for `T`'s new due, as a *new* map row. Gated on `occurrence_date` strictly increasing (no recreate-on-stale-due ping-pong).
- **Todoist completes/advances first** → same: delete old `C`, create `C'` for the new due.

This makes each occurrence its own row (no status latch), avoids RRULE round-trips and the ~1,730-occurrence explosion, keeps every delete a simple one-time delete, and confines blast radius. (Native recurring badge on-device is a possible far-future v3 with a per-occurrence child table — not now.)

---

## 6. D1 schema (hardened)

```sql
CREATE TABLE mapping (
  todoist_id        TEXT NOT NULL,         -- Todoist task id
  fp_stable_id      TEXT,                  -- FairPlay-minted id from FP::{json} (join key, survives id reuse)
  occurrence_date   TEXT NOT NULL,         -- YYYY-MM-DD of this occurrence ('' for non-recurring)
  surface           TEXT NOT NULL,         -- 'chore' (| 'list' in 2c)
  frame_id          TEXT NOT NULL,         -- frame this row was created against (cross-frame write guard)
  profile           TEXT NOT NULL,         -- 'amy'|'kyle'
  skylight_id       TEXT,                  -- chore id (or list_item id in 2c)
  expected_summary  TEXT,                  -- exact string we wrote (read-back compares full, not prefix)
  last_pushed_status TEXT,                 -- the status WE last sent ('pending'|'complete')
  observed_status   TEXT,                  -- status we last saw on device
  last_pushed_hash  TEXT,                  -- fingerprint of fields we last pushed
  state             TEXT NOT NULL,         -- 'creating'|'active'|'deleting'|'deleted'|'needs_review'|'detached'
  idem_token        TEXT,                  -- per-create idempotency token (also embedded in summary/emoji)
  updated_at        INTEGER,
  PRIMARY KEY (todoist_id, occurrence_date),
  UNIQUE (skylight_id, frame_id)
);
```
KV: `skylight_token`(+exp), `frame_fingerprint` (`5356033:heutoncal`), `todoist_sync_token`, `run_lease`.

---

## 7. Sync algorithm (hardened, per leased run)

**Startup:** take lease (else exit) → assert `GET /frames/{frame}.name == frame_fingerprint` (else hard-abort) → refresh Skylight token; treat 401 anytime as re-auth-then-retry-once.

**A. Outbound (Todoist → Skylight), Todoist authoritative for content/due**
For each in-scope task (Sync API delta), compute correct **surface** + `hash`:
- **Not mapped** → write-ahead `state='creating'` row (with `idem_token`) **before** the create → `POST` ONE chore → **assert** `data.length==1` and the returned summary carries our sentinel + matches `start/category` → **read-back GET by id**, confirm → commit `state='active'`, store `skylight_id`, `expected_summary`, `last_pushed_*`. On any mismatch: `needs_review`, create nothing further.
- **Mapped, content/due hash changed** → if `occurrence_date` advanced (recurrence) run the §5 roll (delete old, create next); else `PUT` update → read-back-verify → update hash.
- **Mapped, Todoist now complete** → `PUT {status:"complete"}` → **read-back GET, assert status flipped** (catches silent no-ops on the real frame) → set `last_pushed_status='complete'`.
- **Mapped, Todoist task gone** → §9 delete protocol (re-GET, confirm ours, delete, confirm 404, hard-delete row).

**B. Inbound (Skylight → Todoist), completion + reopen**
For each `active` mapped chore, **GET it by id** (never infer from list-absence; a confirmed 404 = device-side delete → §8 rule):
- `observed_status` flips **pending→complete** and the change is **genuine** (`observed != last_pushed_status` — the fingerprint echo test, §8) and Todoist task still open → **complete/advance the Todoist task**; for recurring, immediately run the §5 roll.
- flips **complete→pending** (device reopen) and Todoist is closed → re-assert Todoist truth (re-push `complete`), echo-guarded.

Window for any list scan is sized from the actual min/max `occurrence_date` in the map; but **per-mapped-id GETs are the source of truth**, not the windowed list.

---

## 8. Echo / conflict resolution (fingerprint-based)

Echo suppression no longer uses wall-clock. We store **what we last pushed** (`last_pushed_status`, `last_pushed_hash`). Inbound propagates a change only when **observed ≠ last_pushed** (it wasn't us) **and** observed ≠ current Todoist truth (it's a real divergence). Timing-independent → immune to cron jitter / slow API. (A tiny monotonic-counter debounce is optional, never wall-clock-primary.)

Conflict rules: **Todoist wins** on content/due/recurrence (re-push on drift). Completion: either side may originate; first genuine transition wins; reopen is Todoist-authoritative. Skylight-side delete of a mapped chore (confirmed 404) → drop the mapping, **don't auto-recreate** (no whack-a-mole), log.

---

## 9. Safety / blast-radius (structural, not procedural)

- **Wrong-frame impossible:** `frame_id` in every row; refuse any write where `target_frame != mapping.frame_id`; startup name-fingerprint assert; **`DRYRUN` default true**, real writes require explicit `FRAME_CONFIRMED='5356033:heutoncal'`.
- **DRYRUN at the client:** every non-GET in `skylight-client.ts` short-circuits under DRYRUN and returns a synthetic logged result; unit test spies on `fetch` to assert no mutating call escapes. No other path to Skylight exists.
- **Create-then-verify-then-record:** never trust `create_multiple[0].id`; assert count, sentinel, fields; **create ONE per call in v1**; match by embedded `idem_token`, never array position.
- **Delete protocol:** re-GET → confirm exists + ▸-sentinel + (for recurrence) group matches → `DELETE` (one-time path; **never `apply_to=all`**) → confirm 404 → commit. Mismatch → abort+flag.
- **Per-write read-back verification on the *real* frame** (the test-frame canary can't catch real-frame-only regressions / silent no-ops).
- **`▸` sentinel is secondary only:** low-collision (rare/zero-width glyph + short token derived from `todoist_id`); compare the **full stored `expected_summary`**, never a prefix; if the on-device summary diverges (edited by family / sentinel stripped) → mark `detached`, stop syncing it, log. No code path may match by prefix/label.
- **Id-reuse / stale rows:** join on `fp_stable_id` (from FP:: payload) and require `mapping.profile == task's current profile` before any write; **hard-delete** rows once Skylight side is confirmed gone, so a stale row can't re-match a reused id.
- **Partial-failure safe:** write-ahead intent (`creating`/`deleting`) before the HTTP call; a `creating` row with no confirmed id → **read-back-by-sentinel, never blind re-create**.

---

## 10. Operations & fragility

- **Cron overlap:** lease/lock (§2) + the `UNIQUE` constraint; consider a Durable Object as single writer.
- **Token expiry mid-run:** 401 → reauth → retry the *one* call; reconcile is **idempotent + resumable** (write-ahead intent means a re-run continues, not duplicates).
- **429:** bounded backoff; on exhaustion, checkpoint and exit cleanly (next run resumes) — never leave a half-applied batch as "done".
- **Date/timezone:** compute "today"/windows in the **frame's timezone**, not the Worker's `new Date()` local (we already hit the 06-18-vs-06-17 boundary). Use generous windows; rely on per-id GETs for truth.
- **Staleness alerting:** the unofficial API *will* break again — emit a heartbeat/last-success metric and alert if a run hasn't succeeded in N intervals; surface `needs_review`/`detached` counts.
- **Drift canary** stays on the test frame **and** runs **before** any real-frame write each run; but the production guarantee is the per-write real-frame read-back (§9).

---

## 11. Lists surface (phase 2c — gated on a write-probe)

Why deferred: we'd proven only chore writes. **The write-probe is now BUILT** — `scripts/skylight-list-probe.mjs` (separate from the chore probe). Shapes are **pinned from source** (OpenAPI HAR + skylight-mcp):
- create list → `POST /api/frames/{frame}/lists`, FLAT `{label, kind:"to_do", color}` → **returns `data.id`** ✅
- create item → `POST /api/frames/{frame}/lists/{listId}/list_items`, FLAT `{label, section}` → **returns `data.id`** ✅
- complete item → `PUT /api/frames/{frame}/lists/{listId}/list_items/{itemId}`, FLAT `{status:"completed"}` — note **`"completed"`, NOT chores' `"complete"`**
- delete item / list → `DELETE …/list_items/{itemId}` / `DELETE …/lists/{listId}`

**Both creates return ids → lists are mappable → Lists-sync is GO.** The probe still must be **run live once** (user creds) to confirm the `status` write actually persists and isn't a silent no-op (the chore-envelope trap), and to confirm cleanup — that live run is the remaining 2c gate.

Then build with: a **dedicated bridge-owned list** (`▸ FairPlay`) as the **only** list the worker may write to (assert at startup its id is not one of the family's 2 lists); a **list-item id-map** (`skylight_list_item_id`, `surface='list'`) — never label matching; a **second inbound poll of `/lists`** for `status=='completed'`; and **surface-migration** handling (a task gaining/losing a due date deletes the old-surface artifact and creates the new one, atomically — else it duplicates).

Until 2c ships, **no-due tasks are skipped and logged** (visible, not silent).

---

## 12. Red-team findings → where fixed

| Lens | Blocker | Fixed in |
|---|---|---|
| Conflict/echo | time-based echo guard leaks/sticks | §8 fingerprint |
| Conflict/echo | status latch drops reopen & next occurrence | §6 per-occurrence rows, §7B both edges |
| Conflict/echo | map updated before write confirmed | §7/§9 write-ahead + read-back |
| Recurrence | recurring-complete advances, breaks inbound | §5 rolling-occurrence model |
| Recurrence | NL→RRULE gaps for chores | §5 avoids RRULE entirely |
| Safety | wrong-frame writes | §9 frame fingerprint + per-row frame_id + FRAME_CONFIRMED |
| Safety | trust create_multiple[0].id | §9 create-then-verify, one-per-call |
| Safety | DELETE can wipe a series | §9 delete protocol, never apply_to=all |
| Safety | partial failure corrupts map / id reuse | §9 write-ahead + fp_stable_id + hard-delete |
| Lists | write mechanics unverified | §11 probe gate; v1 skips no-due |
| Lists | no mappable id / which list | §11 dedicated list + id-map |
| Lists | inbound ignores lists | §11 second /lists poll |
| Ops | cron overlap double-writes | §2/§10 lease + UNIQUE |
| Ops | token expiry mid-run | §10 idempotent resume |

---

## 13. Reuse from what's built

- `worker/skylight-ics/` — Todoist client, deck resolution, `parseFp` (the NL→RRULE mapper is **not** needed anymore — §5 drops RRULE).
- `scripts/skylight-probe.mjs` (chore write) + `scripts/skylight-read-probe.mjs` (read) + `scripts/skylight-list-probe.mjs` (list write — built; run live to clear the 2c gate, §11) — proven request shapes for every call the bridge needs.
