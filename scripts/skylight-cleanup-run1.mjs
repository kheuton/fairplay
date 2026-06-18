/**
 * FAIRPLAY · Skylight Run-1 Cleanup + Diagnostic Script
 * =======================================================
 * PURPOSE
 *   Remove the chores, list items, and bridge list that a failed live sync
 *   run created on the real Skylight frame 5356033 ("heutoncal"), and confirm
 *   that the read-back fix direction is correct (chores ARE readable via the
 *   list endpoint on the real frame).
 *
 * WHAT IT DOES (in order)
 *   1. Auth — 5-step PKCE OAuth, same flow as skylight-probe.mjs.
 *   2. Diagnostic — GET the chore list for 2026-06-10 → 2026-07-05 BEFORE
 *      deleting anything. Tries two variants:
 *        (a) with    filter=linked_to_profile
 *        (b) without filter=linked_to_profile
 *      Reports how many of the 18 target chore ids appear in each response.
 *      "READ-BACK CHECK: N/18 target chores found via list"
 *   3. Delete chores — DELETE the 18 specific chore ids (one-time, NO apply_to).
 *      404 = already gone = OK.
 *   4. Delete list items — DELETE the 3 specific list item ids under list 6656381.
 *      404 = OK.
 *   5. Delete bridge list — DELETE list 6656381.
 *      404 = OK.
 *   6. Final summary — read-back check result, deletion tally, any errors.
 *
 * SAFETY GUARANTEE
 *   This script only ever touches the hardcoded ids below and list 6656381.
 *   It NEVER scans or bulk-deletes anything else on the frame.
 *
 * HOW TO RUN
 *   SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-cleanup-run1.mjs
 *
 * EXIT CODES
 *   0  All deletions succeeded (or already gone). No errors.
 *   1  Auth failed.
 *   2  One or more deletions errored (not 2xx / not 404). Manual follow-up needed.
 */

// ─── Env / usage ──────────────────────────────────────────────────────────────

const EMAIL = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('USAGE:');
  console.error(
    '  SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-cleanup-run1.mjs'
  );
  process.exit(1);
}

// ─── Hardcoded constants (never change these) ─────────────────────────────────

const FRAME = 5356033;

const TARGET_CHORE_IDS = [
  88685495, 88685496, 88685499, 88685500, 88685501, 88685502, 88685503, 88685504,
  88685505, 88685506, 88685507, 88685508, 88685509, 88685510, 88685511, 88685512,
  88685513, 88685519,
];

const BRIDGE_LIST_ID = 6656381;

const TARGET_LIST_ITEM_IDS = [195892821, 195892830, 195892834];

// Date window for the read-back diagnostic (covers all the created chores).
const DIAG_AFTER  = '2026-06-10';
const DIAG_BEFORE = '2026-07-05';

// ─── API constants (verbatim from skylight-probe.mjs) ─────────────────────────

const BASE        = 'https://app.ourskylight.com';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID   = 'skylight-mobile';
const SCOPE       = 'everything';

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

// ─── PKCE helpers (verbatim from skylight-probe.mjs) ─────────────────────────

function generateVerifier() {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return uuid1 + uuid2;
}

function base64url(bytes) {
  const binaryStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binaryStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function computeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

function generateState() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// ─── Cookie jar (verbatim from skylight-probe.mjs) ───────────────────────────

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

// ─── Fetch helpers (verbatim from skylight-probe.mjs) ────────────────────────

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
 * Authenticated API call. Returns parsed JSON or raw text on 2xx.
 * Throws ApiError on non-2xx.
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
    const snippet = text.slice(0, 300);
    throw new ApiError(
      `${method} ${path} => ${res.status} ${res.statusText}: ${snippet}`,
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
  console.log(`\n${line}`);
  if (title) {
    console.log(`  ${title}`);
    console.log(line);
  }
}

// ─── Auth (5-step PKCE — verbatim from skylight-probe.mjs doAuth()) ──────────

async function doAuth() {
  separator('STEP 1 — OAuth Login (5-step PKCE)');

  const jar = new CookieJar();
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state = generateState();

  log(INFO, `PKCE verifier length: ${verifier.length} chars`);
  log(INFO, `State: ${state}`);

  // Step 1: initiate OAuth
  log(INFO, 'Step 1: GET /oauth/authorize...');
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
  log(INFO, `  => HTTP ${r1.status}, cookies: ${jar.size()}`);

  const loginFormUrl = r1.headers.get('location');
  if (!loginFormUrl) {
    log(WARN, '  No Location header — checking body for login form...');
    if (!b1.includes('authenticity_token')) {
      throw new Error(
        `Step 1 failed: HTTP ${r1.status}, no redirect and no authenticity_token in body`
      );
    }
  }

  // Step 2: load login form
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
      `Step 2 failed: could not extract authenticity_token. HTTP ${r2.status}. ` +
      `Body snippet: ${formHtml.slice(0, 200)}`
    );
  }
  const authenticityToken = tokenMatch[1];
  log(INFO, `  authenticity_token extracted (${authenticityToken.length} chars)`);

  // Step 3: POST credentials
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
  log(INFO, '  Redirecting to oauth authorize...');

  // Step 4: follow /oauth/authorize to capture auth code
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
    throw new Error(`Step 4 failed: no "code" param in redirect URL: ${codeRedirect}`);
  }
  if (returnedState !== state) {
    throw new Error(
      `Step 4 failed: state mismatch! Sent "${state}", got "${returnedState}". CSRF risk.`
    );
  }
  log(INFO, `  Auth code received (${authCode.length} chars), state verified`);

  // Step 5: exchange code for bearer token
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
    null
  );
  log(INFO, `  => HTTP ${r5.status}`);

  if (!r5.ok && r5.status !== 200) {
    throw new Error(`Step 5 failed: HTTP ${r5.status}. Body: ${tokenRaw.slice(0, 300)}`);
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

// ─── Diagnostic: read-back check ─────────────────────────────────────────────

/**
 * GET the chore list for the diagnostic window, both with and without the
 * linked_to_profile filter. Report how many of the 18 target ids appear.
 * Returns { withFilter: Set<string>, withoutFilter: Set<string> }.
 */
async function doReadBackCheck(token) {
  separator('STEP 2 — DIAGNOSTIC: Read-Back Check (BEFORE deleting)');

  const targetSet = new Set(TARGET_CHORE_IDS.map(String));

  // Helper: fetch chores and return the ids present in data[]
  async function fetchChoreIds(label, path) {
    log(INFO, `  GET ${path}`);
    try {
      const resp = await apiCall('GET', path, token);
      const chores = resp?.data ?? [];
      const found = chores
        .map((c) => String(c.id))
        .filter((id) => targetSet.has(id));
      log(INFO, `  ${label}: ${chores.length} total chores returned, ${found.length}/18 target ids found`);
      if (found.length > 0) {
        log(INFO, `    Matched ids: ${found.join(', ')}`);
      }
      return new Set(found);
    } catch (err) {
      log(WARN, `  ${label}: request failed — ${err.message}`);
      return new Set();
    }
  }

  // (a) WITH filter=linked_to_profile
  const withFilterPath =
    `/api/frames/${FRAME}/chores` +
    `?after=${DIAG_AFTER}&before=${DIAG_BEFORE}` +
    `&include_late=true&include_up_for_grabs=true&filter=linked_to_profile`;
  const withFilter = await fetchChoreIds('WITH filter=linked_to_profile', withFilterPath);

  // (b) WITHOUT filter=linked_to_profile
  const withoutFilterPath =
    `/api/frames/${FRAME}/chores` +
    `?after=${DIAG_AFTER}&before=${DIAG_BEFORE}` +
    `&include_late=true&include_up_for_grabs=true`;
  const withoutFilter = await fetchChoreIds('WITHOUT filter=linked_to_profile', withoutFilterPath);

  console.log('');
  log(INFO, `READ-BACK CHECK: ${withFilter.size}/18 target chores found via list (with filter)`);
  log(INFO, `READ-BACK CHECK: ${withoutFilter.size}/18 target chores found via list (without filter)`);

  if (withFilter.size > 0 || withoutFilter.size > 0) {
    log(PASS, 'READ-BACK CHECK: At least some target chores are readable via the list endpoint.');
    log(INFO, '  This confirms that chores ARE visible via GET /chores — read-back fix direction is CORRECT.');
  } else {
    log(WARN, 'READ-BACK CHECK: 0/18 target chores found in either query variant.');
    log(WARN, '  Chores may have already been deleted, or a different date window / filter is needed.');
    log(WARN, '  The deletions will still proceed (they are idempotent; 404 = already gone = OK).');
  }

  return { withFilter, withoutFilter };
}

// ─── Delete helpers ───────────────────────────────────────────────────────────

/**
 * Attempt a single DELETE. Returns 'ok', 'already_gone', or 'error'.
 * Logs the outcome. Never throws.
 */
async function tryDelete(token, path, label) {
  try {
    await apiCall('DELETE', path, token);
    log(PASS, `Deleted ${label}`);
    return 'ok';
  } catch (err) {
    if (err.status === 404) {
      log(INFO, `Already gone (404): ${label}`);
      return 'already_gone';
    }
    log(FAIL, `Error deleting ${label}: ${err.message}`);
    return 'error';
  }
}

// ─── Delete chores ────────────────────────────────────────────────────────────

async function deleteChores(token) {
  separator('STEP 3 — Delete 18 Chores');
  log(INFO, `Target: ${TARGET_CHORE_IDS.length} chore ids`);
  log(INFO, `Path pattern: DELETE /api/frames/${FRAME}/chores/{id}  (no apply_to — one-time chores)`);
  console.log('');

  const tally = { ok: 0, already_gone: 0, error: 0, errorIds: [] };

  for (const id of TARGET_CHORE_IDS) {
    const path = `/api/frames/${FRAME}/chores/${id}`;
    const result = await tryDelete(token, path, `chore id=${id}`);
    tally[result]++;
    if (result === 'error') tally.errorIds.push(id);
  }

  console.log('');
  log(INFO, `Chore deletions: ${tally.ok} deleted, ${tally.already_gone} already gone, ${tally.error} errors`);
  if (tally.errorIds.length > 0) {
    log(WARN, `  Errored chore ids: ${tally.errorIds.join(', ')}`);
  }

  return tally;
}

// ─── Delete list items ────────────────────────────────────────────────────────

async function deleteListItems(token) {
  separator('STEP 4 — Delete 3 List Items (from bridge list 6656381)');
  log(INFO, `Target: ${TARGET_LIST_ITEM_IDS.length} list item ids`);
  log(INFO, `Path pattern: DELETE /api/frames/${FRAME}/lists/${BRIDGE_LIST_ID}/list_items/{id}`);
  console.log('');

  const tally = { ok: 0, already_gone: 0, error: 0, errorIds: [] };

  for (const id of TARGET_LIST_ITEM_IDS) {
    const path = `/api/frames/${FRAME}/lists/${BRIDGE_LIST_ID}/list_items/${id}`;
    const result = await tryDelete(token, path, `list_item id=${id}`);
    tally[result]++;
    if (result === 'error') tally.errorIds.push(id);
  }

  console.log('');
  log(INFO, `List item deletions: ${tally.ok} deleted, ${tally.already_gone} already gone, ${tally.error} errors`);
  if (tally.errorIds.length > 0) {
    log(WARN, `  Errored list item ids: ${tally.errorIds.join(', ')}`);
  }

  return tally;
}

// ─── Delete bridge list ───────────────────────────────────────────────────────

async function deleteBridgeList(token) {
  separator('STEP 5 — Delete Bridge List 6656381 ("▸ FairPlay")');
  log(INFO, `DELETE /api/frames/${FRAME}/lists/${BRIDGE_LIST_ID}`);
  console.log('');

  const result = await tryDelete(
    token,
    `/api/frames/${FRAME}/lists/${BRIDGE_LIST_ID}`,
    `list id=${BRIDGE_LIST_ID} ("▸ FairPlay")`
  );

  return result;
}

// ─── Final summary ────────────────────────────────────────────────────────────

function printFinalSummary(readBack, choreTally, itemTally, listResult) {
  separator('STEP 6 — FINAL SUMMARY');
  console.log('');

  // Read-back check
  log(INFO, '── Read-Back Check ──────────────────────────────────────');
  log(INFO, `  WITH    filter=linked_to_profile : ${readBack.withFilter.size}/18 target chores found`);
  log(INFO, `  WITHOUT filter=linked_to_profile : ${readBack.withoutFilter.size}/18 target chores found`);
  if (readBack.withFilter.size > 0 || readBack.withoutFilter.size > 0) {
    log(PASS, '  Read-back fix direction CONFIRMED — chores visible via GET /chores list endpoint.');
  } else {
    log(WARN, '  0/18 found in both variants — either already deleted before this run, or window/filter mismatch.');
  }

  console.log('');

  // Deletion tally
  log(INFO, '── Deletion Tally ───────────────────────────────────────');
  log(INFO, `  Chores     (18 ids): ${choreTally.ok} deleted, ${choreTally.already_gone} already gone, ${choreTally.error} errors`);
  log(INFO, `  List items  (3 ids): ${itemTally.ok} deleted, ${itemTally.already_gone} already gone, ${itemTally.error} errors`);
  log(INFO, `  Bridge list (1 id) : ${listResult === 'ok' ? 'deleted' : listResult === 'already_gone' ? 'already gone' : 'ERROR'}`);

  console.log('');

  // Any errors requiring manual follow-up
  const anyErrors =
    choreTally.error > 0 ||
    itemTally.error > 0 ||
    listResult === 'error';

  if (anyErrors) {
    log(FAIL, '── Manual follow-up required ────────────────────────────');
    if (choreTally.errorIds.length > 0) {
      log(WARN, `  Chore ids that errored: ${choreTally.errorIds.join(', ')}`);
      log(WARN, `  → DELETE /api/frames/${FRAME}/chores/{id}  (no apply_to)`);
    }
    if (itemTally.errorIds.length > 0) {
      log(WARN, `  List item ids that errored: ${itemTally.errorIds.join(', ')}`);
      log(WARN, `  → DELETE /api/frames/${FRAME}/lists/${BRIDGE_LIST_ID}/list_items/{id}`);
    }
    if (listResult === 'error') {
      log(WARN, `  Bridge list ${BRIDGE_LIST_ID} did not delete — retry:`);
      log(WARN, `  → DELETE /api/frames/${FRAME}/lists/${BRIDGE_LIST_ID}`);
    }
    console.log('');
    log(FAIL, 'RESULT: Completed with errors. See manual follow-up above.');
  } else {
    log(PASS, 'RESULT: All targets deleted (or confirmed already gone). Frame is clean.');
  }

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Run-1 Cleanup + Diagnostic');
  console.log('================================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame:    ${FRAME} (heutoncal)`);
  console.log('');
  console.log('Targets:');
  console.log(`  Chores     : ${TARGET_CHORE_IDS.length} ids`);
  console.log(`  List items : ${TARGET_LIST_ITEM_IDS.length} ids (in list ${BRIDGE_LIST_ID})`);
  console.log(`  Bridge list: id ${BRIDGE_LIST_ID} ("▸ FairPlay")`);
  console.log('');
  console.log('SAFETY: This script only touches the hardcoded ids above.');
  console.log('        It never scans or bulk-deletes anything else.');
  console.log('');

  // ── Step 1: Auth ──────────────────────────────────────────────────────────
  let token;
  try {
    token = await doAuth();
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    process.exit(1);
  }

  // ── Step 2: Diagnostic (read-back check) ──────────────────────────────────
  const readBack = await doReadBackCheck(token);

  // ── Step 3: Delete chores ─────────────────────────────────────────────────
  const choreTally = await deleteChores(token);

  // ── Step 4: Delete list items ─────────────────────────────────────────────
  const itemTally = await deleteListItems(token);

  // ── Step 5: Delete bridge list ────────────────────────────────────────────
  const listResult = await deleteBridgeList(token);

  // ── Step 6: Final summary ─────────────────────────────────────────────────
  printFinalSummary(readBack, choreTally, itemTally, listResult);

  const anyErrors =
    choreTally.error > 0 || itemTally.error > 0 || listResult === 'error';
  process.exit(anyErrors ? 2 : 0);
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
