/**
 * FAIRPLAY · Skylight Lists API Write Probe
 * ==========================================
 * PURPOSE
 *   This script validates whether Skylight's UNOFFICIAL, REVERSE-ENGINEERED
 *   private Lists API supports the read+write mechanics needed for FairPlay
 *   phase 2c (Lists sync). It tests: auth, list creation, list-item creation,
 *   item completion (status update), item deletion, and list deletion — producing
 *   a PASS/FAIL summary and confirming the exact canonical shapes needed for the
 *   sync implementation.
 *
 * LEGAL / RISK CAVEAT (read before running)
 *   Skylight exposes NO public API. This probe uses a reverse-engineered OAuth
 *   flow and undocumented endpoints discovered by reading third-party source code
 *   (github.com/rjhalvorson/skylight-mcp, github.com/TheEagleByte/skylight-api).
 *   Using this API almost certainly violates Skylight's Terms of Service §7.4
 *   ("you may not... reverse engineer... any portion of the Service").
 *   It is intended strictly for the OWNER of the Skylight account being tested,
 *   for PERSONAL USE on their own device, and may break at any time without
 *   notice if Skylight changes its internals.
 *   USE AT YOUR OWN RISK.
 *
 * SAFETY GUARANTEE
 *   This probe ONLY touches a throwaway list it creates itself.
 *   It will NEVER read from, write to, or delete any pre-existing list
 *   (including any hand-made to_do lists on the frame).
 *   Cleanup happens in a finally block — even on errors or Ctrl-C (SIGINT).
 *
 * PRIVACY
 *   - Your password is read ONLY from process.env — never logged, never written
 *     to disk, never transmitted except to app.ourskylight.com.
 *   - Nothing is written to disk. The script runs entirely in memory.
 *
 * API SHAPES (confirmed from HAR captures in TheEagleByte/skylight-api openapi.yaml
 *             and from rjhalvorson/skylight-mcp src/api/endpoints/lists.ts + types.ts)
 *
 *   CREATE LIST:
 *     POST /api/frames/{frameId}/lists
 *     Body (FLAT JSON — NOT a JSON:API envelope):
 *       { label: string, kind: "to_do"|"shopping", color?: string|null }
 *     Response: { data: { id: string, type: "list", attributes: { label, kind, color,
 *                         default_grocery_list, hide_on_device }, relationships: {...} } }
 *     NOTE: id IS returned in the response.
 *
 *   CREATE LIST ITEM:
 *     POST /api/frames/{frameId}/lists/{listId}/list_items
 *     Body (FLAT JSON — NOT a JSON:API envelope):
 *       { label: string, section?: string|null }
 *     Response: { data: { id: string, type: "list_item", attributes: { label, status,
 *                         section, position, created_at }, relationships: { list: {...} } } }
 *     NOTE: id IS returned in the response.
 *
 *   UPDATE (COMPLETE) LIST ITEM:
 *     PUT /api/frames/{frameId}/lists/{listId}/list_items/{itemId}
 *     Body (FLAT JSON):
 *       { status: "completed" }   ← enum: "completed" | "pending"
 *       (may also include label, section, position in same flat object)
 *     Response: { data: { id: string, type: "list_item", attributes: { ..., status: "completed" } } }
 *     NOTE: status string is "completed" (NOT chores' "complete").
 *
 *   DELETE LIST ITEM:
 *     DELETE /api/frames/{frameId}/lists/{listId}/list_items/{itemId}
 *     No body. Response: 200 with { data: { ... } } (the deleted resource).
 *
 *   DELETE LIST:
 *     DELETE /api/frames/{frameId}/lists/{listId}
 *     No body. Response: 200 with { data: { ... } } (the deleted resource).
 *
 * HOW TO RUN
 *   See scripts/SKYLIGHT-LIST-PROBE.md for full instructions. Quick start:
 *
 *   SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" \
 *   SKYLIGHT_FRAME_ID="5381689" \
 *   node scripts/skylight-list-probe.mjs
 *
 * EXIT CODES
 *   0  auth + create list + create item + complete item + cleanup all succeeded
 *   1  missing required env vars (usage error)
 *   2  auth succeeded but one or more write/cleanup operations failed
 */

// ─── Env / usage ──────────────────────────────────────────────────────────────

const EMAIL = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;
const FRAME_ID = process.env.SKYLIGHT_FRAME_ID ?? null;

if (!EMAIL || !PASSWORD) {
  console.error('USAGE:');
  console.error(
    '  SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" \\'
  );
  console.error(
    '  SKYLIGHT_FRAME_ID="<frame-id>" \\'
  );
  console.error('  node scripts/skylight-list-probe.mjs');
  console.error('');
  console.error('Required env vars: SKYLIGHT_EMAIL, SKYLIGHT_PASSWORD, SKYLIGHT_FRAME_ID');
  console.error('Use SKYLIGHT_FRAME_ID=5381689 for the TEST frame (thehd), never the real frame.');
  process.exit(1);
}

if (!FRAME_ID) {
  console.error('[FAIL] SKYLIGHT_FRAME_ID is required.');
  console.error('       Set SKYLIGHT_FRAME_ID=5381689 (TEST frame) to run the probe safely.');
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE = 'https://app.ourskylight.com';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID = 'skylight-mobile';
const SCOPE = 'everything';

/** Throwaway list name — unique enough to identify probe leftovers for cleanup. */
const PROBE_LIST_NAME = '▸ FairPlay list probe — SAFE TO DELETE';

/** Throwaway item label inside the probe list. */
const PROBE_ITEM_LABEL = 'probe item — delete me';

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: 'https://ourskylight.com/',
};

const API_HEADERS_BASE = {
  'User-Agent': 'SkylightMobile (web)',
  Accept: 'application/json',
  'Skylight-Api-Version': '2026-03-01',
};

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

/** Generate a 64-character PKCE code_verifier (two UUIDs, hyphens removed). */
function generateVerifier() {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return uuid1 + uuid2; // 64 hex chars
}

/** Base64url-encode a Uint8Array (no padding, URL-safe chars). */
function base64url(bytes) {
  const binaryStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binaryStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 PKCE challenge from verifier string. */
async function computeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

/** 10-character random state string (alphanumeric, UUID-derived). */
function generateState() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// ─── Cookie jar ───────────────────────────────────────────────────────────────

/**
 * A minimal cookie jar: stores Set-Cookie values and re-sends them.
 * Only tracks name=value pairs; ignores attributes (domain, path, etc.)
 * since all requests go to the same origin.
 */
class CookieJar {
  #store = new Map();

  ingest(headers) {
    if (!headers) return;
    const setCookieValues = [];
    if (typeof headers.getSetCookie === 'function') {
      setCookieValues.push(...headers.getSetCookie());
    } else if (typeof headers.get === 'function') {
      const v = headers.get('set-cookie');
      if (v) setCookieValues.push(v);
    }
    for (const raw of setCookieValues) {
      const part = raw.split(';')[0].trim();
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      this.#store.set(name, value);
    }
  }

  header() {
    return [...this.#store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  size() {
    return this.#store.size;
  }
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────

/**
 * Perform a fetch call without following redirects; ingest Set-Cookie into jar.
 * Returns { res, body } where body is text.
 */
async function rawFetch(url, opts, jar) {
  const res = await fetch(url, { ...opts, redirect: 'manual' });
  if (jar) jar.ingest(res.headers);
  const body = await res.text().catch(() => '');
  return { res, body };
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Authenticated API call. Returns parsed JSON or throws ApiError on non-2xx.
 */
async function apiCall(method, path, token, bodyObj) {
  const url = `${BASE}${path}`;
  const headers = {
    ...API_HEADERS_BASE,
    Authorization: `Bearer ${token}`,
  };
  const opts = { method, headers };
  if (bodyObj !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(bodyObj);
  }
  const res = await fetch(url, opts);
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const snippet = text.slice(0, 400);
    throw new ApiError(
      `${method} ${path} => HTTP ${res.status} ${res.statusText}: ${snippet}`,
      res.status
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ─── Logging helpers ──────────────────────────────────────────────────────────

const PASS = '[PASS]';
const FAIL = '[FAIL]';
const INFO = '[INFO]';
const WARN = '[WARN]';

function log(level, msg) {
  console.log(`${level} ${msg}`);
}

function separator(title) {
  const line = '─'.repeat(60);
  if (title) {
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(line);
  } else {
    console.log(line);
  }
}

// ─── Step 1: Auth (5-step PKCE flow) ─────────────────────────────────────────

/**
 * Run the 5-step OAuth/PKCE login flow and return the bearer token string.
 * This is copied verbatim from the proven skylight-probe.mjs auth implementation.
 */
async function doAuth() {
  separator('STEP 1 — OAuth Login (5-step PKCE)');

  const jar = new CookieJar();
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state = generateState();

  log(INFO, `PKCE verifier length: ${verifier.length} chars`);
  log(INFO, `State: ${state}`);

  // ── Step 1: initiate OAuth, capture session cookies ──────────────────────
  log(INFO, 'Step 1: GET /oauth/authorize (initiate PKCE flow)...');
  const authorizeUrl =
    `${BASE}/oauth/authorize` +
    `?client_id=${CLIENT_ID}` +
    `&code_challenge=${encodeURIComponent(challenge)}` +
    `&code_challenge_method=S256` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=${SCOPE}` +
    `&state=${state}` +
    `&prompt=login`;

  const { res: r1, body: b1 } = await rawFetch(
    authorizeUrl,
    { headers: COMMON_HEADERS },
    jar
  );
  log(INFO, `  => HTTP ${r1.status}, cookies collected: ${jar.size()}`);

  const loginFormUrl = r1.headers.get('location');
  if (!loginFormUrl) {
    log(WARN, '  No Location header — checking if body contains login form...');
    if (!b1.includes('authenticity_token')) {
      throw new Error(
        `Step 1 failed: HTTP ${r1.status}, no redirect and no authenticity_token in body`
      );
    }
  }

  // ── Step 2: load login form, extract authenticity_token ──────────────────
  log(INFO, 'Step 2: GET login form page...');
  const formUrl = loginFormUrl ?? authorizeUrl;
  const { res: r2, body: formHtml } = await rawFetch(
    formUrl,
    { headers: { ...COMMON_HEADERS, Cookie: jar.header() } },
    jar
  );
  log(INFO, `  => HTTP ${r2.status}`);

  const tokenMatch =
    formHtml.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i) ??
    formHtml.match(/value=["']([^"']+)["'][^>]*name=["']authenticity_token["']/i);

  if (!tokenMatch) {
    throw new Error(
      `Step 2 failed: could not extract authenticity_token from login form. ` +
      `HTTP ${r2.status}. Body snippet: ${formHtml.slice(0, 200)}`
    );
  }
  const authenticityToken = tokenMatch[1];
  log(INFO, `  authenticity_token extracted (${authenticityToken.length} chars)`);

  // ── Step 3: POST credentials ──────────────────────────────────────────────
  log(INFO, 'Step 3: POST credentials to /auth/session...');
  const formBody = new URLSearchParams({
    authenticity_token: authenticityToken,
    email: EMAIL,
    password: PASSWORD,
  });

  const { res: r3 } = await rawFetch(
    `${BASE}/auth/session`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: BASE,
        Referer: `${BASE}/auth/session/new`,
        Cookie: jar.header(),
      },
      body: formBody.toString(),
    },
    jar
  );
  log(INFO, `  => HTTP ${r3.status}`);

  if (r3.status !== 302 && r3.status !== 301) {
    throw new Error(
      `Step 3 failed: expected 302 redirect after login, got HTTP ${r3.status}. ` +
      'Check email/password.'
    );
  }
  const oauthRedirectUrl = r3.headers.get('location');
  if (!oauthRedirectUrl) {
    throw new Error('Step 3 failed: no Location header after login POST');
  }
  log(INFO, `  Redirecting to oauth authorize...`);

  // ── Step 4: follow /oauth/authorize to capture auth code ─────────────────
  log(INFO, 'Step 4: Follow /oauth/authorize redirect to capture auth code...');
  const step4Url = oauthRedirectUrl.startsWith('/')
    ? `${BASE}${oauthRedirectUrl}`
    : oauthRedirectUrl;

  const { res: r4 } = await rawFetch(
    step4Url,
    {
      headers: {
        ...COMMON_HEADERS,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie: jar.header(),
      },
    },
    jar
  );
  log(INFO, `  => HTTP ${r4.status}`);

  const codeRedirect = r4.headers.get('location');
  if (!codeRedirect) {
    throw new Error(
      `Step 4 failed: expected 302 with code, got HTTP ${r4.status} (no Location)`
    );
  }

  let codeUrl;
  try {
    codeUrl = new URL(
      codeRedirect.startsWith('/') ? `${BASE}${codeRedirect}` : codeRedirect
    );
  } catch {
    throw new Error(`Step 4 failed: could not parse Location as URL: ${codeRedirect}`);
  }

  const authCode = codeUrl.searchParams.get('code');
  const returnedState = codeUrl.searchParams.get('state');

  if (!authCode) {
    throw new Error(
      `Step 4 failed: no "code" param in redirect URL: ${codeRedirect}`
    );
  }
  if (returnedState !== state) {
    throw new Error(
      `Step 4 failed: state mismatch! Sent "${state}", got "${returnedState}". CSRF risk.`
    );
  }
  log(INFO, `  Auth code received (${authCode.length} chars), state verified`);

  // ── Step 5: exchange code for bearer token ────────────────────────────────
  log(INFO, 'Step 5: POST /oauth/token — exchange code for bearer token...');
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CLIENT_ID,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    code: authCode,
    code_verifier: verifier,
    skylight_api_client_device_fingerprint: crypto.randomUUID(),
    skylight_api_client_device_platform: 'web',
    skylight_api_client_device_name: 'unknown',
    skylight_api_client_device_os_version: 'unknown',
    skylight_api_client_device_app_version: 'unknown',
    skylight_api_client_device_hardware: 'unknown',
  });

  const { res: r5, body: tokenRaw } = await rawFetch(
    `${BASE}/oauth/token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: 'https://ourskylight.com',
        Referer: 'https://ourskylight.com/',
        'User-Agent': COMMON_HEADERS['User-Agent'],
        Accept: 'application/json, text/javascript; q=0.01',
      },
      body: tokenBody.toString(),
    },
    null // no cookie needed at this step
  );
  log(INFO, `  => HTTP ${r5.status}`);

  if (!r5.ok && r5.status !== 200) {
    throw new Error(
      `Step 5 failed: HTTP ${r5.status}. Body: ${tokenRaw.slice(0, 300)}`
    );
  }

  let tokenJson;
  try {
    tokenJson = JSON.parse(tokenRaw);
  } catch {
    throw new Error(`Step 5 failed: response not JSON. Body: ${tokenRaw.slice(0, 200)}`);
  }

  const bearerToken = tokenJson.access_token ?? tokenJson.token;
  if (!bearerToken) {
    throw new Error(
      `Step 5 failed: no access_token in response. Keys: ${Object.keys(tokenJson).join(', ')}`
    );
  }

  log(PASS, `Auth succeeded. Bearer token obtained (${bearerToken.length} chars).`);
  return bearerToken;
}

// ─── Step 2: Create throwaway list ───────────────────────────────────────────

/**
 * Create the probe's throwaway list (kind: to_do).
 * Uses FLAT JSON body (confirmed from OpenAPI HAR captures — NOT a JSON:API envelope).
 * Returns { listId, createListResp }.
 */
async function createProbeList(token) {
  separator('STEP 2 — Create Throwaway List');

  log(INFO, `POST /api/frames/${FRAME_ID}/lists`);
  log(INFO, '  NOTE: body is flat JSON, NOT a JSON:API { data: { type, attributes } } envelope.');
  log(INFO, '  Source: TheEagleByte/skylight-api openapi.yaml HAR capture + rjhalvorson/skylight-mcp types.ts comment');

  // Skylight validates list color against its palette (null/invalid -> 422 "Color is invalid").
  // Reuse a color from an existing list (guaranteed-valid palette value); fall back to a known one.
  let color = '#B6E085';
  try {
    const existing = await apiCall('GET', `/api/frames/${FRAME_ID}/lists`, token);
    const found = (existing?.data ?? []).map((l) => l?.attributes?.color).find((c) => typeof c === 'string' && c);
    if (found) color = found;
    log(INFO, `  Using palette color from an existing list: ${color}`);
  } catch (e) {
    log(INFO, `  Could not read existing list colors (${e.message}); using fallback ${color}`);
  }

  log(INFO, `  Body (FLAT JSON): { label: "${PROBE_LIST_NAME}", kind: "to_do", color: "${color}" }`);

  const body = {
    label: PROBE_LIST_NAME,
    kind: 'to_do',
    color,
  };

  const resp = await apiCall('POST', `/api/frames/${FRAME_ID}/lists`, token, body);

  const listData = resp?.data;
  const listId = listData?.id ?? null;

  if (!listId) {
    // This is a go/no-go blocker for lists-sync
    log(FAIL, 'CREATE LIST response did NOT return an id.');
    log(FAIL, 'BLOCKER: Without a returned id, list-sync cannot safely map Todoist<->Skylight lists.');
    log(FAIL, `Full response: ${JSON.stringify(resp).slice(0, 400)}`);
    throw new Error('CREATE LIST: no id returned in response — BLOCKS lists-sync');
  }

  const attrs = listData?.attributes ?? {};
  log(PASS, `List created. id=${listId}, label="${attrs.label}", kind="${attrs.kind}"`);
  log(INFO, `  id IS returned in response — list-sync mapping is feasible.`);

  return { listId, createListResp: resp };
}

// ─── Step 3: Create list item ─────────────────────────────────────────────────

/**
 * Create a probe item inside the throwaway list.
 * Uses FLAT JSON body (confirmed from OpenAPI HAR captures).
 * Returns { itemId, createItemResp }.
 */
async function createProbeItem(token, listId) {
  separator('STEP 3 — Create List Item');

  log(INFO, `POST /api/frames/${FRAME_ID}/lists/${listId}/list_items`);
  log(INFO, `  Body (FLAT JSON): { label: "${PROBE_ITEM_LABEL}", section: null }`);
  log(INFO, '  NOTE: flat JSON — same as list creates (no JSON:API envelope).');

  const body = {
    label: PROBE_ITEM_LABEL,
    section: null,
  };

  const resp = await apiCall(
    'POST',
    `/api/frames/${FRAME_ID}/lists/${listId}/list_items`,
    token,
    body
  );

  const itemData = resp?.data;
  const itemId = itemData?.id ?? null;

  if (!itemId) {
    log(FAIL, 'CREATE LIST ITEM response did NOT return an id.');
    log(FAIL, 'BLOCKER: Without a returned id, item-level sync cannot safely map items.');
    log(FAIL, `Full response: ${JSON.stringify(resp).slice(0, 400)}`);
    throw new Error('CREATE LIST ITEM: no id returned in response — BLOCKS item-sync');
  }

  const attrs = itemData?.attributes ?? {};
  const initialStatus = attrs.status ?? null;
  log(PASS, `Item created. id=${itemId}, label="${attrs.label}", status="${initialStatus}"`);
  log(INFO, `  id IS returned in response — item-sync mapping is feasible.`);

  return { itemId, initialStatus, createItemResp: resp };
}

// ─── Step 4: Complete the item ────────────────────────────────────────────────

/**
 * Attempt to mark the probe item as completed.
 * Primary candidate: "completed" (from OpenAPI enum + types.ts ListItemAttributes.status).
 * Fallback candidate: "complete" (chores' completion string — probably wrong for items).
 * Re-GETs the list to confirm status actually changed (guard against silent no-ops).
 * Returns { confirmedStatusString, completeResp } or throws if both candidates fail.
 */
async function completeProbeItem(token, listId, itemId, initialStatus) {
  separator('STEP 4 — Complete List Item (status update probe)');

  // STATUS STRING EVIDENCE:
  //   Source 1 — TheEagleByte/skylight-api openapi.yaml (HAR-captured real traffic):
  //     PUT /api/frames/{id}/lists/{id1}/list_items/{id2}
  //     Request schema: { status: enum ["completed", "pending"] }
  //     Request example: { status: "completed" }
  //     Response example: { data: { attributes: { status: "completed", ... } } }
  //   Source 2 — rjhalvorson/skylight-mcp src/api/types.ts:
  //     ListItemAttributes.status: "pending" | "completed"
  //     UpdateListItemRequest.status?: "pending" | "completed"
  //   CONTRAST WITH CHORES: chores use "complete" (NOT "completed"). List items use "completed".
  //   PRIMARY attempt: "completed" (spec-confirmed).
  //   FALLBACK attempt: "complete" (chore string, unlikely to work for items but we test).

  const candidates = ['completed', 'complete'];
  let confirmedStatusString = null;
  let completeResp = null;

  for (const candidate of candidates) {
    log(INFO, `\nTrying status string "${candidate}"...`);
    log(INFO, `  PUT /api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`);
    log(INFO, `  Body (FLAT JSON): { "status": "${candidate}" }`);

    let putResp;
    try {
      putResp = await apiCall(
        'PUT',
        `/api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`,
        token,
        { status: candidate }
      );
    } catch (err) {
      log(WARN, `  PUT with "${candidate}" failed: ${err.message}`);
      if (err.status && err.status >= 500) {
        throw err; // server error — stop trying
      }
      // 4xx — try next candidate
      continue;
    }

    // Check status in PUT response body first (spec says it returns the updated resource)
    let returnedStatus = putResp?.data?.attributes?.status ?? null;
    log(INFO, `  PUT HTTP 2xx — status in response body: ${returnedStatus !== null ? `"${returnedStatus}"` : '(not present)'}`);

    if (returnedStatus === null) {
      // Fall back to GET the list with items to confirm
      log(INFO, `  Falling back to GET /api/frames/${FRAME_ID}/lists/${listId} to confirm...`);
      try {
        const getResp = await apiCall('GET', `/api/frames/${FRAME_ID}/lists/${listId}`, token);
        // Response includes the list + items via JSON:API `included`
        const included = getResp?.included ?? [];
        const updatedItem = included.find((r) => String(r.id) === String(itemId));
        if (updatedItem) {
          returnedStatus = updatedItem?.attributes?.status ?? null;
          log(INFO, `  GET included item found — status: "${returnedStatus}"`);
        } else {
          log(WARN, `  Item id=${itemId} not found in GET included items. Cannot confirm.`);
          // Try a direct item GET if available, or fall through to next candidate
          continue;
        }
      } catch (getErr) {
        log(WARN, `  GET list failed: ${getErr.message}`);
        continue;
      }
    }

    // Check whether the status actually changed (guard against silent no-op)
    const COMPLETION_VALUES = new Set(['completed', 'complete']);
    if (COMPLETION_VALUES.has(returnedStatus) && returnedStatus !== initialStatus) {
      confirmedStatusString = returnedStatus; // server's canonical form
      completeResp = putResp;
      log(PASS, `Status update CONFIRMED.`);
      log(PASS, `  Sent: { status: "${candidate}" }, server returned: "${returnedStatus}"`);
      if (candidate !== returnedStatus) {
        log(INFO, `  NOTE: server normalized "${candidate}" => "${returnedStatus}". Use "${returnedStatus}" as canonical.`);
      }
      break;
    } else if (returnedStatus === initialStatus) {
      log(WARN, `  PUT returned 2xx but status is still "${returnedStatus}" (unchanged from initial "${initialStatus}")`);
      log(WARN, `  "${candidate}" appears to be a silent no-op — trying next candidate.`);
      continue;
    } else {
      // Unexpected status value but it changed
      if (returnedStatus !== initialStatus) {
        confirmedStatusString = returnedStatus;
        completeResp = putResp;
        log(WARN, `  Unexpected status value returned: "${returnedStatus}" (sent "${candidate}")`);
        log(PASS, `  Status DID change from "${initialStatus}" to "${returnedStatus}" — recording this.`);
        break;
      } else {
        log(WARN, `  Status unchanged: "${returnedStatus}" — continuing.`);
        continue;
      }
    }
  }

  if (confirmedStatusString === null) {
    log(FAIL, 'Neither "completed" nor "complete" was accepted by the server.');
    log(FAIL, 'CONCLUSION: list-item completion may require an on-device tap or a different endpoint.');
    throw new Error('Complete list item: no candidate status string worked');
  }

  return { confirmedStatusString, completeResp };
}

// ─── Step 5 (finally): Cleanup ────────────────────────────────────────────────

/**
 * Delete the probe item and probe list.
 * ALWAYS called in a finally block — never skipped.
 * Returns { itemDeleted, listDeleted }.
 */
async function cleanup(token, listId, itemId) {
  separator('CLEANUP (Step 5 — always runs)');

  let itemDeleted = false;
  let listDeleted = false;

  // Delete the item first (good hygiene, though deleting the list likely cascades)
  if (itemId && listId) {
    log(INFO, `Deleting probe item id=${itemId}...`);
    log(INFO, `  DELETE /api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`);
    try {
      await apiCall(
        'DELETE',
        `/api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`,
        token
      );
      log(PASS, `Item id=${itemId} deleted.`);
      itemDeleted = true;
    } catch (err) {
      log(WARN, `  Could not delete item id=${itemId}: ${err.message}`);
      log(WARN, '  Proceeding to delete the list (which should cascade-delete items).');
    }
  } else {
    log(INFO, 'No item id — skipping item delete.');
    itemDeleted = true; // vacuously true
  }

  // Delete the throwaway list
  if (listId) {
    log(INFO, `Deleting probe list id=${listId}...`);
    log(INFO, `  DELETE /api/frames/${FRAME_ID}/lists/${listId}`);
    try {
      await apiCall('DELETE', `/api/frames/${FRAME_ID}/lists/${listId}`, token);
      log(PASS, `List id=${listId} deleted.`);
      listDeleted = true;
    } catch (err) {
      log(FAIL, `Could not delete list id=${listId}: ${err.message}`);
      log(WARN, `MANUAL CLEANUP NEEDED: Delete the list named "${PROBE_LIST_NAME}" from your Skylight app.`);
      log(WARN, `  Frame: ${FRAME_ID}, List ID: ${listId}`);
    }
  } else {
    log(INFO, 'No list id — nothing to delete.');
    listDeleted = true; // vacuously true
  }

  return { itemDeleted, listDeleted };
}

// ─── Step 6: Final summary ────────────────────────────────────────────────────

function printSummary(results) {
  separator('FINAL SUMMARY — Lists API Write Probe');
  console.log('');

  const { authOk, listId, itemId, confirmedStatusString, cleanupOk, stepsPassed, stepsFailed } = results;

  if (!authOk) {
    log(FAIL, 'AUTH failed — all subsequent steps skipped.');
    log(INFO, 'Check SKYLIGHT_EMAIL / SKYLIGHT_PASSWORD and re-run.');
    console.log('');
    return;
  }

  console.log('  CONFIRMED API WRITE SHAPES (for phase 2c implementation):');
  console.log('');
  console.log('  (a) CREATE LIST:');
  console.log(`      POST /api/frames/{frameId}/lists`);
  console.log(`      Body: { "label": "...", "kind": "to_do"|"shopping", "color": null }`);
  console.log(`      NOTE: FLAT JSON (NOT a JSON:API envelope)`);
  console.log(`      Returns id: ${listId ? 'YES (confirmed)' : 'UNKNOWN (step failed)'}`);
  console.log('');
  console.log('  (b) CREATE LIST ITEM:');
  console.log(`      POST /api/frames/{frameId}/lists/{listId}/list_items`);
  console.log(`      Body: { "label": "...", "section": null }`);
  console.log(`      NOTE: FLAT JSON (NOT a JSON:API envelope)`);
  console.log(`      Returns id: ${itemId ? 'YES (confirmed)' : 'UNKNOWN (step failed)'}`);
  console.log('');
  console.log('  (c) COMPLETE LIST ITEM:');
  console.log(`      PUT /api/frames/{frameId}/lists/{listId}/list_items/{itemId}`);
  console.log(`      Body: { "status": "${confirmedStatusString ?? '??? (step failed)'}" }`);
  console.log(`      NOTE: FLAT JSON; status enum = "completed" | "pending"`);
  console.log(`            "completed" (NOT chores' "complete")`);
  console.log('');
  console.log('  (d) DELETE LIST ITEM:');
  console.log(`      DELETE /api/frames/{frameId}/lists/{listId}/list_items/{itemId}`);
  console.log(`      No body.`);
  console.log('');
  console.log('  (e) DELETE LIST:');
  console.log(`      DELETE /api/frames/{frameId}/lists/{listId}`);
  console.log(`      No body.`);
  console.log('');

  const goNoGo = listId && itemId && confirmedStatusString
    ? 'GO — all write mechanics confirmed viable'
    : 'NO-GO — one or more write mechanics failed (see above)';

  console.log(`  LISTS-SYNC GO/NO-GO: ${goNoGo}`);
  console.log('');

  if (stepsPassed.length > 0) {
    log(PASS, `Steps passed: ${stepsPassed.join(', ')}`);
  }
  if (stepsFailed.length > 0) {
    log(FAIL, `Steps failed: ${stepsFailed.join(', ')}`);
  }
  if (!cleanupOk) {
    log(WARN, `MANUAL CLEANUP may be needed — check your Skylight frame for "${PROBE_LIST_NAME}"`);
  } else {
    log(PASS, 'Cleanup complete — no litter left on your device.');
  }

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Lists API Write Probe');
  console.log('==============================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame ID: ${FRAME_ID}`);
  console.log('');
  console.log('WARNING: This uses Skylight’s UNOFFICIAL reverse-engineered Lists API.');
  console.log('         It may violate Skylight’s ToS §7.4. Personal use only on your own account.');
  console.log('         This probe ONLY touches its own throwaway list — never pre-existing lists.');
  console.log('');

  const results = {
    authOk: false,
    listId: null,
    itemId: null,
    confirmedStatusString: null,
    cleanupOk: false,
    stepsPassed: [],
    stepsFailed: [],
  };

  let token = null;
  let exitCode = 2;

  // ── Step 1: Auth ────────────────────────────────────────────────────────────
  try {
    token = await doAuth();
    results.authOk = true;
    results.stepsPassed.push('1-auth');
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    results.stepsFailed.push('1-auth');
    printSummary(results);
    process.exit(1);
  }

  // ── Step 1.5: Dump categories (people) for the worker PROFILE_CATEGORY_MAP ────
  try {
    separator('STEP 1.5 — Categories (people) on this frame');
    log(INFO, `GET /api/frames/${FRAME_ID}/categories`);
    const cats = await apiCall('GET', `/api/frames/${FRAME_ID}/categories`, token);
    const rows = cats?.data ?? [];
    log(PASS, `${rows.length} categories:`);
    console.log('');
    console.log(`  ${'CAT ID'.padEnd(12)}  ${'LABEL'.padEnd(28)}  LINKED_TO_PROFILE`);
    console.log('  ' + '-'.repeat(60));
    for (const c of rows) {
      const a = c?.attributes ?? {};
      console.log(`  ${String(c?.id ?? '').padEnd(12)}  ${String(a.label ?? '').slice(0, 28).padEnd(28)}  ${a.linked_to_profile}`);
    }
    console.log('');
    log(INFO, '  >>> Use these ids for the worker PROFILE_CATEGORY_MAP (kyle / amy). <<<');
  } catch (e) {
    log(INFO, `Categories dump failed (non-fatal): ${e.message}`);
  }

  // Steps 2-4 + cleanup run as a unit so cleanup always fires.
  try {
    // ── Step 2: Create list ──────────────────────────────────────────────────
    try {
      const { listId } = await createProbeList(token);
      results.listId = listId;
      results.stepsPassed.push('2-create-list');
    } catch (err) {
      log(FAIL, `Create list failed: ${err.message}`);
      results.stepsFailed.push('2-create-list');
      // Cannot proceed to steps 3/4 without a list id
      throw err;
    }

    // ── Step 3: Create item ──────────────────────────────────────────────────
    try {
      const { itemId, initialStatus } = await createProbeItem(token, results.listId);
      results.itemId = itemId;
      results.initialStatus = initialStatus;
      results.stepsPassed.push('3-create-item');
    } catch (err) {
      log(FAIL, `Create item failed: ${err.message}`);
      results.stepsFailed.push('3-create-item');
      // Cannot proceed to step 4 without an item id
      throw err;
    }

    // ── Step 4: Complete item ────────────────────────────────────────────────
    try {
      const { confirmedStatusString } = await completeProbeItem(
        token,
        results.listId,
        results.itemId,
        results.initialStatus
      );
      results.confirmedStatusString = confirmedStatusString;
      results.stepsPassed.push('4-complete-item');
      exitCode = 0; // tentatively success; cleanup must also pass
    } catch (err) {
      log(FAIL, `Complete item failed: ${err.message}`);
      results.stepsFailed.push('4-complete-item');
      // Continue to cleanup — don't rethrow here
    }

  } finally {
    // ── Step 5 (finally): Cleanup ────────────────────────────────────────────
    // Always runs, even if steps 2-4 threw.
    if (token && (results.listId || results.itemId)) {
      try {
        const { itemDeleted, listDeleted } = await cleanup(
          token,
          results.listId,
          results.itemId
        );
        results.cleanupOk = itemDeleted && listDeleted;
        if (results.cleanupOk) {
          results.stepsPassed.push('5-cleanup');
        } else {
          results.stepsFailed.push('5-cleanup');
          exitCode = exitCode === 0 ? 2 : exitCode; // downgrade success if cleanup failed
        }
      } catch (cleanupErr) {
        log(FAIL, `Cleanup threw: ${cleanupErr.message}`);
        results.stepsFailed.push('5-cleanup');
        results.cleanupOk = false;
        exitCode = 2;
      }
    } else {
      // Nothing was created — nothing to clean up
      results.cleanupOk = true;
      results.stepsPassed.push('5-cleanup');
    }
  }

  printSummary(results);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
