# Skylight API Validation Probe

A standalone Node.js script that tests Skylight's UNOFFICIAL private API
to determine whether two-way sync is viable for FairPlay integration.

## Legal caveat

Skylight exposes no public API. This probe uses a reverse-engineered OAuth flow
and undocumented endpoints. Running it may violate Skylight's Terms of Service
§7.4. It is intended strictly for the **owner** of the Skylight account, for
**personal use** on their own device, and may break without notice if Skylight
changes its internals.

## Requirements

- Node.js 18 or later (uses global `fetch` and `crypto`)
- Your Skylight account email and password
- Your Skylight **frame ID** (required; see below)

## How to find your frame ID

The Skylight API has no endpoint to list frames. You must discover the frame ID
by proxying the Skylight app's network traffic:

1. Use a proxy tool (e.g. Charles, mitmproxy, Proxyman) on your device.
2. Open the Skylight mobile app while proxying.
3. Look for requests to `app.ourskylight.com/api/frames/{frameId}/...`.
4. Copy the `{frameId}` value (typically a numeric string).

## How to run

```sh
SKYLIGHT_EMAIL="you@example.com" \
SKYLIGHT_PASSWORD="yourpassword" \
SKYLIGHT_FRAME_ID="12345" \
node scripts/skylight-probe.mjs
```

All three environment variables are required. Nothing is written to disk;
credentials are read only from the environment.

## How to read the result

The script runs three experiments in sequence:

| Experiment | What it tests |
|------------|---------------|
| 2a — Auth  | 5-step OAuth/PKCE login; obtains a bearer token |
| 2b — Read  | Lists chores for the frame; prints a compact table |
| 3  — Write | Creates a throwaway chore, attempts to mark it complete (tries `"completed"` then `"complete"`), verifies a genuine status transition via the PUT response body (falls back to a list GET), then deletes it |

A `[PASS]` / `[FAIL]` prefix marks each step. The final summary block says:

- **ALL EXPERIMENTS PASSED** — two-way sync (Option B) is viable. The summary
  also prints the confirmed status string (`"completed"` or `"complete"`) to use
  in the PUT request body. The script verifies the status actually changed (not
  just that the PUT returned 2xx), so this is a genuine confirmation.
- **Auth failed** — the API is dead or credentials are wrong. Stay on the
  one-way ICS feed.
- **Read/write failed** — auth works but the chore API is broken or the frame ID
  is wrong. Investigate before committing to two-way sync.

## Exit codes

| Code | Meaning |
|------|---------|
| `0`  | auth + read + write all succeeded |
| `1`  | auth failed |
| `2`  | auth succeeded but read or write failed |

## What the script does NOT do

- It does not store, log, or transmit your password anywhere except
  `app.ourskylight.com/auth/session`.
- It does not write any files to disk.
- It does not modify any real chores on your device (only the clearly-named
  throwaway chore, which is deleted at the end).
- It does not change your Todoist data.
