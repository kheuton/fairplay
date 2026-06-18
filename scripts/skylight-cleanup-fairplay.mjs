/**
 * FAIRPLAY · Skylight Sync Worker Cleanup
 * =========================================
 * PURPOSE
 *   Deletes ONLY items created by the FairPlay sync worker on the "heutoncal"
 *   Skylight frame (id 5356033).  Nothing else is touched.
 *
 * SAFETY CONTRACT — two selectors, no others:
 *   1. CHORES  — deleted only when attributes.description starts with "FPSYNC|"
 *                (the marker the sync worker stamps on every chore it creates).
 *   2. LISTS   — deleted only when attributes.label === "▸ FairPlay"
 *                (the dedicated bridge list the sync worker creates for to-do items).
 *   Any chore without the FPSYNC| prefix and any list with a different label
 *   are NEVER touched, even if they happen to share a category or date range.
 *
 * HOW TO RUN
 *   SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" \
 *     node scripts/skylight-cleanup-fairplay.mjs
 *
 * EXIT CODES
 *   0  clean run (all targeted items deleted or already gone)
 *   1  auth failed / missing env vars
 *   2  cleanup partially or fully failed (see [FAIL] lines for ids needing manual follow-up)
 */

// ─── Env / usage ──────────────────────────────────────────────────────────────

const EMAIL    = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('USAGE:');
  console.error(
    '  SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-cleanup-fairplay.mjs'
  );
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE      = 'https://app.ourskylight.com';
const FRAME_ID  = '5356033';                 // heutoncal — hardcoded per spec
const BRIDGE_LIST_LABEL = '▸ FairPlay';      // exact label the sync worker uses
const FPSYNC_PREFIX     = 'FPSYNC|';         // marker prefix on every sync-worker chore

// Wide window: capture anything the worker could have ever scheduled
const CHORES_AFTER  = '2026-01-01';
const CHORES_BEFORE = '2027-01-01';

const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID    = 'skylight-mobile';
const SCOPE        = 'everything';

const COMMON_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept:  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: 'https://ourskylight.com/',
};

const API_HEADERS_BASE = {
  'User-Agent':         'SkylightMobile (web)',
  Accept:               'application/json',
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
  const data    = encoder.encode(verifier);
  const digest  = await crypto.subtle.digest('SHA-256', data);
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
      const eq   = part.indexOf('=');
      if (eq === -1) continue;
      const name  = part.slice(0, eq).trim();
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
  const res  = await fetch(url, { ...opts, redirect: 'manual' });
  if (jar) jar.ingest(res.headers);
  const body = await res.text().catch(() => '');
  return { res, body };
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name   = 'ApiError';
    this.status = status;
  }
}

/**
 * Authenticated API call.  Returns parsed JSON (or raw text) on 2xx.
 * On non-2xx: if allow404 is true and status is 404, returns null silently.
 * Otherwise throws ApiError.
 */
async function apiCall(method, path, token, bodyObj, { allow404 = false } = {}) {
  const url     = `${BASE}${path}`;
  const headers = {
    ...API_HEADERS_BASE,
    Authorization: `Bearer ${token}`,
  };
  const opts = { method, headers };
  if (bodyObj !== undefined) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(bodyObj);
  }
  const res  = await fetch(url, opts);
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    if (allow404 && res.status === 404) return null;
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

// ─── Logging helpers (verbatim from skylight-probe.mjs) ──────────────────────

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

// ─── Auth (verbatim from skylight-probe.mjs doAuth) ──────────────────────────

async function doAuth() {
  separator('STEP 1 — OAuth Login (5-step PKCE)');

  const jar       = new CookieJar();
  const verifier  = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state     = generateState();

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
      'Step 2 failed: could not extract authenticity_token from login form. ' +
      `HTTP ${r2.status}. Body snippet: ${formHtml.slice(0, 200)}`
    );
  }
  const authenticityToken = tokenMatch[1];
  log(INFO, `  authenticity_token extracted (${authenticityToken.length} chars)`);

  // Step 3: POST credentials
  log(INFO, 'Step 3: POST credentials to /auth/session...');
  const formBody = new URLSearchParams({
    authenticity_token: authenticityToken,
    email:    EMAIL,
    password: PASSWORD,
  });

  const { res: r3 } = await rawFetch(
    `${BASE}/auth/session`,
    {
      method:  'POST',
      headers: {
        ...COMMON_HEADERS,
        Accept:         'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:         BASE,
        Referer:        `${BASE}/auth/session/new`,
        Cookie:         jar.header(),
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

  // Step 4: follow /oauth/authorize
  log(INFO, 'Step 4: Follow /oauth/authorize redirect to capture auth code...');
  const step4Url = oauthRedirectUrl.startsWith('/')
    ? `${BASE}${oauthRedirectUrl}`
    : oauthRedirectUrl;

  const { res: r4 } = await rawFetch(
    step4Url,
    {
      headers: {
        ...COMMON_HEADERS,
        Accept:  'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Cookie:  jar.header(),
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

  const authCode      = codeUrl.searchParams.get('code');
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
    grant_type:    'authorization_code',
    client_id:     CLIENT_ID,
    scope:         SCOPE,
    redirect_uri:  REDIRECT_URI,
    code:          authCode,
    code_verifier: verifier,
    skylight_api_client_device_fingerprint: crypto.randomUUID(),
    skylight_api_client_device_platform:    'web',
    skylight_api_client_device_name:        'unknown',
    skylight_api_client_device_os_version:  'unknown',
    skylight_api_client_device_app_version: 'unknown',
    skylight_api_client_device_hardware:    'unknown',
  });

  const { res: r5, body: tokenRaw } = await rawFetch(
    `${BASE}/oauth/token`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:         'https://ourskylight.com',
        Referer:        'https://ourskylight.com/',
        'User-Agent':   COMMON_HEADERS['User-Agent'],
        Accept:         'application/json, text/javascript; q=0.01',
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

// ─── STEP 2: Delete FPSYNC-marked chores ─────────────────────────────────────

/**
 * Query the wide chore window, collect every chore whose description starts with
 * "FPSYNC|", and delete each one.  Returns counts for the summary.
 */
async function cleanChores(token) {
  separator('STEP 2 — Delete FPSYNC-marked chores');

  const qs = new URLSearchParams({
    after:               CHORES_AFTER,
    before:              CHORES_BEFORE,
    include_late:        'true',
    include_up_for_grabs:'true',
    filter:              'linked_to_profile',
  });
  const path = `/api/frames/${FRAME_ID}/chores?${qs}`;
  log(INFO, `GET ${path}`);

  let chores;
  try {
    const data = await apiCall('GET', path, token);
    chores = data?.data ?? [];
  } catch (err) {
    log(FAIL, `Could not fetch chores: ${err.message}`);
    return { attempted: 0, deleted: 0, alreadyGone: 0, errors: [] };
  }
  log(INFO, `  ${chores.length} chores returned in window.`);

  // Select ONLY chores whose description starts with the FPSYNC| marker
  const fpsync = chores.filter((c) => {
    const desc = c?.attributes?.description;
    return typeof desc === 'string' && desc.startsWith(FPSYNC_PREFIX);
  });

  log(INFO, `  ${fpsync.length} chore(s) match the FPSYNC| marker.`);
  if (fpsync.length === 0) {
    log(INFO, '  Nothing to delete.');
    return { attempted: 0, deleted: 0, alreadyGone: 0, errors: [] };
  }

  // Print a short table of matched chores
  console.log('');
  const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  console.log(`  ${pad('ID', 14)}  ${pad('SUMMARY', 40)}  DESCRIPTION`);
  console.log(`  ${'-'.repeat(14)}  ${'-'.repeat(40)}  ${'-'.repeat(30)}`);
  for (const c of fpsync) {
    const a = c.attributes ?? {};
    console.log(`  ${pad(c.id, 14)}  ${pad(a.summary, 40)}  ${String(a.description ?? '').slice(0, 60)}`);
  }
  console.log('');

  let deleted = 0;
  let alreadyGone = 0;
  const errors = [];

  for (const chore of fpsync) {
    const choreId = chore.id;
    const deletePath = `/api/frames/${FRAME_ID}/chores/${choreId}`;
    try {
      const result = await apiCall('DELETE', deletePath, token, undefined, { allow404: true });
      if (result === null) {
        // 404 — already gone
        log(INFO, `  [GONE]    id=${choreId} — already deleted (404)`);
        alreadyGone++;
      } else {
        log(PASS, `  [DELETED] id=${choreId} — "${(chore.attributes?.summary ?? '').slice(0, 50)}"`);
        deleted++;
      }
    } catch (err) {
      log(FAIL, `  [ERROR]   id=${choreId} — ${err.message}`);
      errors.push({ type: 'chore', id: choreId, error: err.message });
    }
  }

  log(INFO, `  Chores: ${deleted} deleted, ${alreadyGone} already gone, ${errors.length} error(s).`);
  return { attempted: fpsync.length, deleted, alreadyGone, errors };
}

// ─── STEP 3: Delete "▸ FairPlay" lists ───────────────────────────────────────

/**
 * GET /api/frames/{FRAME_ID}/lists, find every list whose label is exactly
 * "▸ FairPlay", delete all items in each, then delete the list itself.
 */
async function cleanLists(token) {
  separator('STEP 3 — Delete "▸ FairPlay" bridge lists');

  const listsPath = `/api/frames/${FRAME_ID}/lists`;
  log(INFO, `GET ${listsPath}`);

  let allLists;
  try {
    const data = await apiCall('GET', listsPath, token);
    allLists = data?.data ?? [];
  } catch (err) {
    log(FAIL, `Could not fetch lists: ${err.message}`);
    return { listsFound: 0, listsDeleted: 0, itemsDeleted: 0, errors: [] };
  }
  log(INFO, `  ${allLists.length} list(s) on frame.`);

  // Select ONLY lists with our exact bridge-list label
  const bridgeLists = allLists.filter(
    (l) => l?.attributes?.label === BRIDGE_LIST_LABEL
  );
  log(INFO, `  ${bridgeLists.length} list(s) with label "${BRIDGE_LIST_LABEL}".`);

  if (bridgeLists.length === 0) {
    log(INFO, '  Nothing to delete.');
    return { listsFound: 0, listsDeleted: 0, itemsDeleted: 0, errors: [] };
  }

  let listsDeleted = 0;
  let itemsDeleted = 0;
  const errors = [];

  for (const list of bridgeLists) {
    const listId    = list.id;
    const listLabel = list.attributes?.label ?? '';
    log(INFO, `\n  Processing list id=${listId} label="${listLabel}"...`);

    // Fetch list detail to get items (in included[])
    let items = [];
    try {
      const detail = await apiCall('GET', `/api/frames/${FRAME_ID}/lists/${listId}`, token);
      items = detail?.included ?? [];
      log(INFO, `  ${items.length} item(s) in list.`);
    } catch (err) {
      log(WARN, `  Could not fetch list detail (id=${listId}): ${err.message} — will still attempt list delete.`);
    }

    // Delete items first
    for (const item of items) {
      const itemId = item.id;
      const deletePath = `/api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`;
      try {
        const result = await apiCall('DELETE', deletePath, token, undefined, { allow404: true });
        if (result === null) {
          log(INFO, `    [GONE]    item id=${itemId} — already deleted (404)`);
        } else {
          log(PASS, `    [DELETED] item id=${itemId}`);
          itemsDeleted++;
        }
      } catch (err) {
        log(FAIL, `    [ERROR]   item id=${itemId} — ${err.message}`);
        errors.push({ type: 'list_item', listId, id: itemId, error: err.message });
      }
    }

    // Delete the list itself
    const listDeletePath = `/api/frames/${FRAME_ID}/lists/${listId}`;
    try {
      const result = await apiCall('DELETE', listDeletePath, token, undefined, { allow404: true });
      if (result === null) {
        log(INFO, `  [GONE]    list id=${listId} — already deleted (404)`);
      } else {
        log(PASS, `  [DELETED] list id=${listId} ("${listLabel}")`);
        listsDeleted++;
      }
    } catch (err) {
      log(FAIL, `  [ERROR]   list id=${listId} — ${err.message}`);
      errors.push({ type: 'list', id: listId, error: err.message });
    }
  }

  log(INFO, `\n  Lists: ${listsDeleted}/${bridgeLists.length} deleted, ${itemsDeleted} item(s) deleted, ${errors.length} error(s).`);
  return { listsFound: bridgeLists.length, listsDeleted, itemsDeleted, errors };
}

// ─── Final summary ────────────────────────────────────────────────────────────

function printSummary(choreResult, listResult) {
  separator('FINAL SUMMARY');
  console.log('');

  const allErrors = [...choreResult.errors, ...listResult.errors];

  log(INFO, `CHORES:  ${choreResult.deleted} FPSYNC-marked chore(s) deleted` +
    (choreResult.alreadyGone > 0 ? `, ${choreResult.alreadyGone} already gone` : ''));
  log(INFO, `LISTS:   ${listResult.listsDeleted} "▸ FairPlay" list(s) deleted, ` +
    `${listResult.itemsDeleted} item(s) deleted`);

  if (allErrors.length === 0) {
    log(PASS, 'Clean run — no errors.');
    console.log('');
  } else {
    log(FAIL, `${allErrors.length} error(s) need manual follow-up:`);
    for (const e of allErrors) {
      if (e.type === 'chore') {
        log(FAIL, `  chore id=${e.id}: ${e.error}`);
      } else if (e.type === 'list') {
        log(FAIL, `  list id=${e.id}: ${e.error}`);
      } else if (e.type === 'list_item') {
        log(FAIL, `  list_item id=${e.id} (in list ${e.listId}): ${e.error}`);
      }
    }
    console.log('');
  }

  return allErrors.length === 0 ? 0 : 2;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Sync Worker Cleanup');
  console.log('=========================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame:    ${FRAME_ID}  (heutoncal)`);
  console.log(`Selects:  chores where description starts with "${FPSYNC_PREFIX}"`);
  console.log(`          lists where label === "${BRIDGE_LIST_LABEL}"`);
  console.log('');

  // Auth
  let token;
  try {
    token = await doAuth();
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    process.exit(1);
  }

  // Chores
  const choreResult = await cleanChores(token);

  // Lists
  const listResult  = await cleanLists(token);

  // Summary + exit
  const exitCode = printSummary(choreResult, listResult);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
