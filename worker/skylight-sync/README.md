# skylight-sync

FairPlay (Todoist) ⇄ Skylight kitchen calendar — two-way sync Worker.

**Phase 2a**: non-recurring tasks with due dates. Full hardened engine:
DRYRUN-at-client, frame fingerprint guard, create-then-verify-then-record,
delete protocol with 404 confirmation, echo-fingerprint guard, single-writer lease.

## Architecture

```
Cloudflare Worker (cron) ─── D1 (id-map + lease) ─── KV (tokens + config)
         │
         ├── Todoist REST API (read deck tasks; close/reopen)
         └── Skylight unofficial API (PKCE auth; chore CRUD)
```

## Setup

### 1. Create D1 and KV

```bash
wrangler d1 create skylight-sync-db
wrangler kv:namespace create SKYLIGHT_SYNC_KV
```

Update `wrangler.jsonc` with the returned `database_id` and KV `id`.

### 2. Apply DB schema

```bash
wrangler d1 execute skylight-sync-db --file=migrations/0001_init.sql
```

### 3. Set secrets

```bash
wrangler secret put TODOIST_API_TOKEN
wrangler secret put SKYLIGHT_EMAIL
wrangler secret put SKYLIGHT_PASSWORD
```

### 4. Configure vars

Edit `wrangler.jsonc` or create `.dev.vars` (never commit):

```
DRYRUN=true
FRAME=5381689
FRAME_CONFIRMED=5381689:thehd
PROFILE_CATEGORY_MAP={"kyle":"20976592","amy":"20976818"}
FRAME_TIMEZONE=America/New_York
```

### 5. Run locally

```bash
npm run dev
```

### 6. Deploy

```bash
npm run deploy
```

## Safety progression

1. **DRYRUN=true** (default) — zero Skylight writes. Verify logs look correct.
2. **Test frame** (`FRAME=5381689`, `FRAME_CONFIRMED=5381689:thehd`, `DRYRUN=false`) — live writes to test device only.
3. **Real frame** (`FRAME=5356033`, `FRAME_CONFIRMED=5356033:heutoncal`, `DRYRUN=false`) — production sync.

## Tests

```bash
npx vitest run --config worker/skylight-sync/vitest.config.ts
```

## Key files

| File | Purpose |
|------|---------|
| `src/types.ts` | All shared types (Env, RawTask, ChoreResource, MappingRow, ReconcileAction) |
| `src/skylight-client.ts` | Skylight PKCE auth + chore CRUD; DRYRUN-at-client; frame fingerprint assert |
| `src/todoist-client.ts` | Todoist deck task fetch; close/reopen task |
| `src/db.ts` | D1 mapping + lease CRUD |
| `src/reconcile.ts` | PURE decision functions (surface, fingerprint, decide) |
| `src/index.ts` | Scheduled handler — thin wiring of all modules |
| `migrations/0001_init.sql` | D1 schema |

## Phasing

- **2a** (this): non-recurring tasks with due dates. Full safety engine.
- **2b**: recurring tasks via rolling-occurrence model (§5).
- **2c**: no-due tasks via Lists surface (§11, gated on write-probe).
