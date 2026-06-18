# Skylight Lists API Write Probe

Validates Skylight's unofficial Lists API write mechanics before building phase 2c (Lists sync).

## Quick start

```bash
SKYLIGHT_EMAIL="you@example.com" \
SKYLIGHT_PASSWORD="yourpass" \
SKYLIGHT_FRAME_ID="5381689" \
node scripts/skylight-list-probe.mjs
```

Use `SKYLIGHT_FRAME_ID=5381689` (the TEST frame "thehd") — **never** the real frame `5356033`.

## Required env vars

| Variable | Description |
|---|---|
| `SKYLIGHT_EMAIL` | Your Skylight account email |
| `SKYLIGHT_PASSWORD` | Your Skylight account password (never logged or written to disk) |
| `SKYLIGHT_FRAME_ID` | Frame ID to run the probe against — use `5381689` (TEST frame) |

## What the probe does

All five steps run against a throwaway list the script creates itself. It will **never** touch pre-existing lists.

1. **Auth** — 5-step PKCE OAuth flow → bearer token
2. **Create list** — `POST /api/frames/{frameId}/lists` with flat JSON `{ label, kind: "to_do", color: null }`. Captures the returned `id`.
3. **Create item** — `POST /api/frames/{frameId}/lists/{listId}/list_items` with flat JSON `{ label }`. Captures the returned `id`.
4. **Complete item** — `PUT /api/frames/{frameId}/lists/{listId}/list_items/{itemId}` with `{ status: "completed" }`. Re-GETs the list to confirm the status actually changed (guards against silent no-ops). Falls back to `"complete"` if `"completed"` doesn't work.
5. **Cleanup (always)** — Deletes the probe item, then deletes the throwaway list. Reports if manual cleanup is needed.

## Reading the output

Each line is prefixed with a stage tag:

- `[PASS]` — step succeeded and was confirmed
- `[FAIL]` — step failed; details follow
- `[WARN]` — non-fatal issue (e.g. cleanup couldn't delete item but list delete succeeded)
- `[INFO]` — progress information

The **FINAL SUMMARY** section (last ~30 lines) is the key output:

- Lists the confirmed request shapes for all five operations
- States whether `id` is returned on create (the go/no-go for safe sync mapping)
- States the canonical completion status string (`"completed"` expected)
- Prints `LISTS-SYNC GO/NO-GO: GO` if auth + create + complete + cleanup all passed

## Exit codes

| Code | Meaning |
|---|---|
| 0 | All steps passed (auth + create list + create item + complete + cleanup) |
| 1 | Missing required env vars |
| 2 | Auth succeeded but one or more write or cleanup steps failed |

## Safety

- The probe creates its own throwaway list named `▸ FairPlay list probe — SAFE TO DELETE`
- Cleanup runs in a `finally` block and fires even on errors
- If cleanup fails (e.g. network drop), the FINAL SUMMARY will warn you with the list ID to delete manually
- The script never reads from or writes to any pre-existing list

## Confirmed API shapes (from source research)

Sources:
- [TheEagleByte/skylight-api openapi.yaml](https://raw.githubusercontent.com/TheEagleByte/skylight-api/main/docs/openapi/openapi.yaml) — HAR-captured real traffic
- [rjhalvorson/skylight-mcp src/api/endpoints/lists.ts](https://raw.githubusercontent.com/rjhalvorson/skylight-mcp/main/src/api/endpoints/lists.ts)
- [rjhalvorson/skylight-mcp src/api/types.ts](https://raw.githubusercontent.com/rjhalvorson/skylight-mcp/main/src/api/types.ts)

### Create list
```
POST /api/frames/{frameId}/lists
Content-Type: application/json
Authorization: Bearer <token>
Skylight-Api-Version: 2026-03-01

{ "label": "My List", "kind": "to_do", "color": null }
```
Response: `{ data: { id: "...", type: "list", attributes: { label, kind, color, default_grocery_list, hide_on_device }, relationships: { list_items: { data: [] } } } }`

**Important:** FLAT JSON body. The `skylight-mcp` TypeScript types have a JSON:API wrapper for `CreateListRequest` but the actual server (per OpenAPI HAR) accepts and the MCP implementation sends flat JSON. Id is returned.

### Create list item
```
POST /api/frames/{frameId}/lists/{listId}/list_items
Content-Type: application/json

{ "label": "Buy milk", "section": null }
```
Response: `{ data: { id: "...", type: "list_item", attributes: { label, status: "pending", section, position, created_at }, relationships: { list: { data: { id, type } } } } }`

Id is returned.

### Complete list item
```
PUT /api/frames/{frameId}/lists/{listId}/list_items/{itemId}
Content-Type: application/json

{ "status": "completed" }
```
Status enum: `"completed"` | `"pending"`. **Note:** list items use `"completed"`, NOT chores' `"complete"`.

### Delete list item
```
DELETE /api/frames/{frameId}/lists/{listId}/list_items/{itemId}
```
No body. Returns 200 with the deleted resource.

### Delete list
```
DELETE /api/frames/{frameId}/lists/{listId}
```
No body. Returns 200 with the deleted resource.
