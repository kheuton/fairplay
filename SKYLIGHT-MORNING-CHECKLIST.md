# Skylight ⇄ FairPlay — Morning Checklist

Overnight status (all autonomous; nothing run against your account, nothing deployed, nothing committed).

## What's done ✅

| Thing | State |
|---|---|
| **Phase 2a** (non-recurring two-way sync engine) | **Built + opus-verified.** All hardened safety machinery. |
| **Phase 2b** (recurrence, rolling-occurrence model) | **Built + opus-verified.** |
| **Phase 2c** (no-due tasks ↔ dedicated `▸ FairPlay` list, surface migration) | **Built + opus-verified.** Family lists structurally un-writable. |
| Sync worker tests | **96/96 green, `tsc` clean** (independently re-run). |
| List write-probe | **Passed LIVE** on real frame — lists fully confirmed (create/complete/delete, ids returned, `"completed"` sticks). 2c gate cleared. |
| Design doc | `design/SKYLIGHT-SYNC-PLAN.md` — hardened v2 (post 4-lens red-team). |

**The engine is feature-complete.** What remains is deploy + live test (steps below).

The engine survived a brutal adversarial review: it found ~23 ways to corrupt your data (incl. a sneaky one where the outbound pass would delete every healthy chore) — all fixed and now under test.

## Where things are

- **Probes** (read from your main repo): `scripts/skylight-probe.mjs` (chore write), `scripts/skylight-read-probe.mjs` (read), `scripts/skylight-list-probe.mjs` (list write).
- **Sync worker** (already `npm install`-ed, deploy from here):
  `C:\Users\kheut\code\fairplay\.claude\worktrees\skylight\worker\skylight-sync\`
- **Design doc**: `design/SKYLIGHT-SYNC-PLAN.md`.

## Safety model (so you trust the first run)

The worker **defaults to `DRYRUN=true`** (zero writes to *either* API — Skylight *and* Todoist), it **hard-aborts unless the frame's real name matches** what you configured, and it refuses to touch any chore not in its own id-map. To ever write you must explicitly set `DRYRUN=false` **and** `FRAME_CONFIRMED=<frameId>:<name>`. So you literally cannot hit "heutoncal" by accident.

## The sequence (do these in order)

### 0. (Optional, clears the Lists/2c gate) — run the list write-probe on the TEST frame
```powershell
cd C:\Users\kheut\code\fairplay
$env:SKYLIGHT_EMAIL="kheuton@gmail.com"; $env:SKYLIGHT_PASSWORD="…"; $env:SKYLIGHT_FRAME_ID="5381689"
node scripts/skylight-list-probe.mjs
Remove-Item Env:SKYLIGHT_PASSWORD
```
It creates a throwaway `▸ FairPlay list probe` list, proves create/complete/delete, confirms the `"completed"` status actually persists (not a silent no-op), and cleans up. If it passes, I can build Lists (2c).

### 1. Category ids — DONE ✅ (discovered live on frame 5356033)
- **Kyle** (kheuton@gmail.com) = `21035874` · **Amy** = `20774318` · (Uncategorized = `20781856`)
- **Real-frame** config: `PROFILE_CATEGORY_MAP={"kyle":"21035874","amy":"20774318"}`
- **Test-frame** (5381689) config: `PROFILE_CATEGORY_MAP={"kyle":"20976592","amy":"20976818"}`

### 2. Stand up + dry-run the worker (TEST frame)
```
cd C:\Users\kheut\code\fairplay\.claude\worktrees\skylight\worker\skylight-sync
```
Then follow `README.md` §1–§4: create D1 + KV (paste ids into `wrangler.jsonc`), apply `migrations/0001_init.sql`, `wrangler secret put` the Todoist token + Skylight email/password, and a `.dev.vars` with:
```
DRYRUN=true
FRAME=5381689
FRAME_CONFIRMED=5381689:thehd
PROFILE_CATEGORY_MAP={"kyle":"20976592","amy":"20976818"}
FRAME_TIMEZONE=America/New_York
```
`npm run dev` (or deploy) and **watch the logs** — it prints every action it *would* take, with no writes.

### 3. Go live on the TEST frame, one task
Flip `DRYRUN=false` (keep `FRAME=5381689` / `FRAME_CONFIRMED=5381689:thehd`). Add one FairPlay task with a due date, watch it appear as a chore on the test device, check it off there, watch it close in Todoist. Test recurrence + reopen too.

> **Tip (clears the one known minor):** the id-map is disposable — it rebuilds from Todoist. If a dry-run left state that makes the first live run behave oddly, just reset it and re-run:
> `wrangler d1 execute skylight-sync-db --command "DELETE FROM mapping; DELETE FROM lease;"`

### 4. Promote to the REAL frame
Only after step 3 looks right: `FRAME=5356033`, `FRAME_CONFIRMED=5356033:heutoncal`, the **real-frame** `PROFILE_CATEGORY_MAP` from step 1, `DRYRUN=true` first (watch one cycle), then `false`. **Start with a single task / one card.**

## What still needs you (can't be done without your creds/decisions)

- Running the probes/worker live (creds) and deploying (your Cloudflare).
- The real-frame category ids (step 1).
- Deciding the starting scope (which card/task).
- **Committing**: everything is uncommitted in the worktree on `main`. Say the word and I'll commit it to a feature branch (I held off per "commit only when asked").

## Want me to keep going?

- **Build 2c (Lists)** — ready the moment your step-0 probe passes.
- **Commit / open a PR** for all of this.
- Tighten the two non-blocking minors (warn on unassigned chores; dry-run synthetic-row edge).

Ping me and I'll pick any of these up.
