/**
 * FAIRPLAY · Skylight Read-Only Diagnostic Probe
 * ================================================
 * PURPOSE
 *   Diagnose why GET /api/frames/{frame}/chores returns 0 results even when
 *   chores exist on the account.  Runs a labeled series of list-endpoint
 *   variations (different query-param combinations) and dumps what each one
 *   returns, so we can determine which query unlocks real chore data and prove
 *   (or rule out) the inbound Skylight→FairPlay direction.
 *
 *   Also fully enumerates the task_box/items endpoint and hunts for completed
 *   items created on the device.
 *
 * READ-ONLY GUARANTEE
 *   This script issues ONLY GET requests after authentication.
 *   It does NOT create, update, complete, or delete anything.
 *   Safe to run at any time; no cleanup required.
 *
 * LEGAL / RISK CAVEAT (read before running)
 *   Skylight exposes NO public API.  This script uses a reverse-engineered
 *   OAuth flow and undocumented endpoints discovered by reading third-party
 *   source code (github.com/rjhalvorson/skylight-mcp,
 *   github.com/TheEagleByte/skylight-api).
 *   Using this API almost certainly violates Skylight's Terms of Service §7.4
 *   ("you may not... reverse engineer... any portion of the Service").
 *   It is intended strictly for the OWNER of the Skylight account being tested,
 *   for PERSONAL USE on their own device, and may break without notice.
 *   USE AT YOUR OWN RISK.
 *
 * HOW TO RUN
 *   (Add a chore on the physical Skylight device first, then:)
 *
 *   SKYLIGHT_EMAIL="you@example.com" \
 *   SKYLIGHT_PASSWORD="yourpass" \
 *   SKYLIGHT_FRAME_ID="5381689" \
 *   node scripts/skylight-read-probe.mjs
 *
 *   Optional env vars:
 *     SKYLIGHT_PROFILE_ID       — per-person profile id (from Skylight web
 *                                 URL ?profileId=<id>) to test profile-scoped
 *                                 queries
 *     SKYLIGHT_KNOWN_CHORE_ID   — a chore id from the Skylight device (integer
 *                                 string); if set, the script also fetches
 *                                 GET /api/frames/{frame}/chores/{id} directly
 *                                 so we can confirm single-fetch works even
 *                                 when list queries return nothing
 *
 * HYPOTHESES BEING TESTED (ordered most-likely-first per research)
 *   H1 filter=linked_to_profile (DEFAULT behaviour)
 *      The OpenAPI spec (TheEagleByte/skylight-api, HAR-derived) shows the
 *      real web client ALWAYS sends filter=linked_to_profile.  Without this
 *      param the API may return nothing; with it, only categories that have
 *      linked_to_profile:true appear.  Kyle/Amy both have
 *      selected_for_chore_chart:false — they likely also have
 *      linked_to_profile:false, so the default filter suppresses them.
 *      FIX: send filter=linked_to_profile to match the real client, OR omit
 *           the filter entirely to get all categories.
 *   H2 Date-window semantics
 *      Spec examples show after=before (single-day window).  We test narrow,
 *      wide, and no-date-params variations.
 *   H3 include_late (string "true", not boolean)
 *      The skylight-mcp client sends include_late as a JS boolean that
 *      gets stringified to "true".  Omitting it may hide overdue chores.
 *   H4 task_box/items endpoint
 *      Chores created from certain UI paths may end up as task_box_items
 *      rather than chores.  We query that endpoint too.  Per OpenAPI spec
 *      (TheEagleByte/skylight-api), task_box/items is NOT paginated — the
 *      response is a flat array with no links/meta/cursor.  The spec example
 *      shows exactly 17 items which matches live results.  task_box_item
 *      objects have NO status or completed_on field; completing one converts
 *      it into a chore (type:"chore") visible in the /chores endpoint.
 *   H5 Single-chore GET
 *      Even if the list is broken, GET /api/frames/{frame}/chores/{id} may
 *      still return data for SKYLIGHT_KNOWN_CHORE_ID.
 *   H6 Completed items hunt
 *      Per spec + rjhalvorson/skylight-mcp source: there is NO dedicated
 *      completed/history/archive endpoint.  Completed task_box items become
 *      chores with status:"complete" and completed_on set.  We hunt for them
 *      by querying /chores WITHOUT filter=linked_to_profile (which might hide
 *      newly-created chores), and also with status=complete if the API
 *      accepts that param.
 *
 * EXIT CODES
 *   0  at least one variation returned ≥1 chore
 *   1  missing required env vars (auth not attempted)
 *   2  auth failed
 *   3  auth succeeded but EVERY variation returned 0 results / errored
 */

// ─── Env ──────────────────────────────────────────────────────────────────────

const EMAIL    = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;
const FRAME_ID = process.env.SKYLIGHT_FRAME_ID;

// Optional
const PROFILE_ID       = process.env.SKYLIGHT_PROFILE_ID    ?? null;
const KNOWN_CHORE_ID   = process.env.SKYLIGHT_KNOWN_CHORE_ID ?? null;

// Hard-coded known category ids for this account (from prior probe results)
const KYLE_CATEGORY_ID = '20976592';
const AMY_CATEGORY_ID  = '20976818';

if (!EMAIL || !PASSWORD || !FRAME_ID) {
  console.error('USAGE:');
  console.error('  SKYLIGHT_EMAIL="..." SKYLIGHT_PASSWORD="..." SKYLIGHT_FRAME_ID="..." \\');
  console.error('  node scripts/skylight-read-probe.mjs');
  console.error('');
  console.error('Optional: SKYLIGHT_PROFILE_ID="..." SKYLIGHT_KNOWN_CHORE_ID="..."');
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE         = 'https://app.ourskylight.com';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID    = 'skylight-mobile';
const SCOPE        = 'everything';

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

// ─── Date helpers ─────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function offsetDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

// ─── PKCE helpers (copied verbatim from skylight-probe.mjs) ──────────────────

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

// ─── Cookie jar (copied verbatim from skylight-probe.mjs) ────────────────────

class CookieJar {
  #store = new Map();

  ingest(headers) {
    if (!headers) return;
    const vals = [];
    if (typeof headers.getSetCookie === 'function') {
      vals.push(...headers.getSetCookie());
    } else if (typeof headers.get === 'function') {
      const v = headers.get('set-cookie');
      if (v) vals.push(v);
    }
    for (const raw of vals) {
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

  size() { return this.#store.size; }
}

// ─── Fetch helpers (copied verbatim from skylight-probe.mjs) ─────────────────

async function rawFetch(url, opts, jar) {
  const res  = await fetch(url, { ...opts, redirect: 'manual' });
  if (jar) jar.ingest(res.headers);
  const body = await res.text().catch(() => '');
  return { res, body };
}

// ─── Logging ──────────────────────────────────────────────────────────────────

const PASS = '[PASS]';
const FAIL = '[FAIL]';
const INFO = '[INFO]';
const WARN = '[WARN]';

function log(level, msg) { console.log(`${level} ${msg}`); }

function separator(title) {
  const line = '─'.repeat(64);
  console.log(`\n${line}`);
  if (title) { console.log(`  ${title}`); console.log(line); }
}

// ─── Auth (5-step PKCE — copied verbatim from skylight-probe.mjs) ─────────────

async function doAuth() {
  separator('AUTH — 5-step PKCE OAuth');

  const jar       = new CookieJar();
  const verifier  = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state     = generateState();

  log(INFO, `PKCE verifier length: ${verifier.length} chars`);
  log(INFO, `State: ${state}`);

  // Step 1
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

  const { res: r1, body: b1 } = await rawFetch(authorizeUrl, { headers: COMMON_HEADERS }, jar);
  log(INFO, `  => HTTP ${r1.status}, cookies: ${jar.size()}`);

  const loginFormUrl = r1.headers.get('location');
  if (!loginFormUrl && !b1.includes('authenticity_token')) {
    throw new Error(`Step 1 failed: HTTP ${r1.status}, no redirect and no form`);
  }

  // Step 2
  log(INFO, 'Step 2: GET login form...');
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
      `Step 2 failed: no authenticity_token. HTTP ${r2.status}. ` +
      `Body: ${formHtml.slice(0, 200)}`
    );
  }
  const authenticityToken = tokenMatch[1];
  log(INFO, `  authenticity_token: ${authenticityToken.length} chars`);

  // Step 3
  log(INFO, 'Step 3: POST credentials...');
  const formBody = new URLSearchParams({
    authenticity_token: authenticityToken,
    email:    EMAIL,
    password: PASSWORD,
  });

  const { res: r3 } = await rawFetch(
    `${BASE}/auth/session`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:  BASE,
        Referer: `${BASE}/auth/session/new`,
        Cookie:  jar.header(),
      },
      body: formBody.toString(),
    },
    jar
  );
  log(INFO, `  => HTTP ${r3.status}`);

  if (r3.status !== 302 && r3.status !== 301) {
    throw new Error(`Step 3 failed: expected 302, got ${r3.status}. Wrong password?`);
  }
  const oauthRedirectUrl = r3.headers.get('location');
  if (!oauthRedirectUrl) throw new Error('Step 3 failed: no Location header');

  // Step 4
  log(INFO, 'Step 4: Follow /oauth/authorize for auth code...');
  const step4Url = oauthRedirectUrl.startsWith('/')
    ? `${BASE}${oauthRedirectUrl}` : oauthRedirectUrl;

  const { res: r4 } = await rawFetch(
    step4Url,
    { headers: { ...COMMON_HEADERS, Cookie: jar.header() } },
    jar
  );
  log(INFO, `  => HTTP ${r4.status}`);

  const codeRedirect = r4.headers.get('location');
  if (!codeRedirect) {
    throw new Error(`Step 4 failed: HTTP ${r4.status}, no Location`);
  }

  let codeUrl;
  try {
    codeUrl = new URL(
      codeRedirect.startsWith('/') ? `${BASE}${codeRedirect}` : codeRedirect
    );
  } catch {
    throw new Error(`Step 4: could not parse redirect URL: ${codeRedirect}`);
  }

  const authCode      = codeUrl.searchParams.get('code');
  const returnedState = codeUrl.searchParams.get('state');

  if (!authCode) throw new Error(`Step 4: no "code" in redirect: ${codeRedirect}`);
  if (returnedState !== state) {
    throw new Error(`Step 4: state mismatch! sent "${state}", got "${returnedState}"`);
  }
  log(INFO, `  Auth code received (${authCode.length} chars), state OK`);

  // Step 5
  log(INFO, 'Step 5: Exchange code for bearer token...');
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
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin:     'https://ourskylight.com',
        Referer:    'https://ourskylight.com/',
        'User-Agent': COMMON_HEADERS['User-Agent'],
        Accept:     'application/json, text/javascript; q=0.01',
      },
      body: tokenBody.toString(),
    },
    null
  );
  log(INFO, `  => HTTP ${r5.status}`);

  if (!r5.ok) {
    throw new Error(`Step 5 failed: HTTP ${r5.status}. Body: ${tokenRaw.slice(0, 300)}`);
  }

  let tokenJson;
  try { tokenJson = JSON.parse(tokenRaw); }
  catch { throw new Error(`Step 5: response not JSON. Body: ${tokenRaw.slice(0, 200)}`); }

  const token = tokenJson.access_token ?? tokenJson.token;
  if (!token) {
    throw new Error(
      `Step 5: no access_token. Keys: ${Object.keys(tokenJson).join(', ')}`
    );
  }

  log(PASS, `Auth succeeded. Bearer token obtained (${token.length} chars).`);
  return token;
}

// ─── Generic GET helper ───────────────────────────────────────────────────────

/**
 * Issue a single authenticated GET, return { status, ok, json, text }.
 * Never throws — errors are captured in the return value.
 */
async function apiGet(token, path) {
  const url = `${BASE}${path}`;
  let status, ok, text, json;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        ...API_HEADERS_BASE,
        Authorization: `Bearer ${token}`,
      },
    });
    status = res.status;
    ok     = res.ok;
    text   = await res.text().catch(() => '');
    try { json = JSON.parse(text); } catch { json = null; }
  } catch (err) {
    status = 0;
    ok     = false;
    text   = String(err);
    json   = null;
  }
  return { url, status, ok, text, json };
}

// ─── Chore dump helpers ───────────────────────────────────────────────────────

/**
 * Print a compact one-line summary per chore and return the chore array.
 * For recurring chores the id is a composite string; the category id comes
 * from relationships.category.data.id.
 */
function dumpChores(chores) {
  if (!Array.isArray(chores) || chores.length === 0) {
    log(INFO, '  (no chores in data array)');
    return [];
  }

  const pad  = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
  const rpad = (s, n) => String(s ?? '').slice(0, n).padStart(n);

  console.log('');
  console.log(
    `  ${ pad('ID',           18) }  ${ pad('SUMMARY',      28) }  ` +
    `${ pad('STATUS',   10) }  ${ pad('START',    10) }  ` +
    `${ pad('COMPL_ON', 10) }  ${ pad('CAT_ID',   12) }  ` +
    `${ rpad('RECUR', 6) }`
  );
  console.log('  ' + '-'.repeat(110));

  for (const c of chores) {
    const a      = c.attributes ?? {};
    const catId  = c.relationships?.category?.data?.id ?? 'none';
    const isCompleted = a.status === 'complete' || (a.completed_on != null && a.completed_on !== 'null');
    const completedFlag = isCompleted ? ' [COMPLETED]' : '';
    console.log(
      `  ${ pad(c.id,             18) }  ${ pad(a.summary,    28) }  ` +
      `${ pad(a.status,    10) }  ${ pad(a.start,     10) }  ` +
      `${ pad(a.completed_on ?? 'null', 10) }  ${ pad(catId, 12) }  ` +
      `${ rpad(a.recurring ? 'yes' : 'no', 6) }${ completedFlag }`
    );
  }
  console.log('');
  return chores;
}

/**
 * Run one variation: GET the given path, print results, return chore count.
 */
async function runVariation(token, label, hypothesis, path) {
  separator(`${label} — ${hypothesis}`);
  log(INFO, `GET ${BASE}${path}`);

  const { url, status, ok, json, text } = await apiGet(token, path);

  log(ok ? PASS : FAIL, `HTTP ${status}`);

  if (!ok) {
    log(WARN, `  Request failed. Response snippet:`);
    console.log('  ' + text.slice(0, 500));
    return { count: 0, chores: [], ok: false };
  }

  const data    = json?.data;
  const chores  = Array.isArray(data) ? data : (data ? [data] : []);
  const count   = chores.length;

  log(INFO, `  Items in data[]: ${count}`);

  // If the response has an "included" array (sideloaded categories), show it
  const included = json?.included;
  if (Array.isArray(included) && included.length > 0) {
    log(INFO, `  Included (sideloaded) resources: ${included.length}`);
    for (const inc of included.slice(0, 5)) {
      const a = inc.attributes ?? {};
      log(INFO,
        `    type=${inc.type} id=${inc.id} label=${a.label ?? '?'} ` +
        `linked_to_profile=${a.linked_to_profile ?? '?'} ` +
        `selected_for_chore_chart=${a.selected_for_chore_chart ?? '?'}`
      );
    }
  }

  dumpChores(chores);

  // Raw JSON dump — full, no truncation
  const rawSnippet = JSON.stringify(json, null, 2);
  log(INFO, `  Raw JSON (full, ${rawSnippet.length} chars):`);
  console.log(rawSnippet);

  return { count, chores, ok: true };
}

// ─── Main diagnostic run ─────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Read-Only Diagnostic Probe');
  console.log('================================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame ID: ${FRAME_ID}`);
  if (PROFILE_ID)      console.log(`Profile ID (env):      ${PROFILE_ID}`);
  if (KNOWN_CHORE_ID)  console.log(`Known chore ID (env):  ${KNOWN_CHORE_ID}`);
  console.log('');
  console.log('WARNING: Unofficial reverse-engineered API. Personal use only. ToS risk.');
  console.log('READ-ONLY: no writes will be performed.');
  console.log('');

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token;
  try {
    token = await doAuth();
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    process.exit(2);
  }

  // ── Build variations ──────────────────────────────────────────────────────

  // Date windows
  const today   = offsetDate(0);
  const tm30    = offsetDate(-30);
  const tp90    = offsetDate(90);
  const tm365   = offsetDate(-365);
  const tp365   = offsetDate(365);
  const tm1     = offsetDate(-1);
  const tp1     = offsetDate(1);

  // Summary tracking
  const results = [];

  function qs(params) {
    const p = new URLSearchParams(params);
    return p.toString() ? `?${p}` : '';
  }

  // ── V1: Baseline (what the original probe was sending) ───────────────────
  //    after=today-30d&before=today+90d, no filter, no include_late
  //    HYPOTHESIS H2: is the date window the problem?
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm30, before: tp90 });
    const r = await runVariation(token,
      'V1 BASELINE',
      'after=today-30d, before=today+90d — original probe query (no filter, no include_late)',
      path
    );
    results.push({ label: 'V1 BASELINE', ...r, path });
  }

  // ── V2: Explicit filter=linked_to_profile (what the real web client sends) ─
  //    HYPOTHESIS H1 (primary suspect): the API requires this param to return
  //    anything; without it, the response is empty.  This matches real HAR
  //    captures in TheEagleByte/skylight-api where the web app always sends
  //    filter=linked_to_profile.
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm30, before: tp90, filter: 'linked_to_profile', include_late: 'true' });
    const r = await runVariation(token,
      'V2 filter=linked_to_profile (real web-client params)',
      'H1: web client always sends this; without it API may return nothing',
      path
    );
    results.push({ label: 'V2 filter=linked_to_profile', ...r, path });
  }

  // ── V3: include_late=true only (no filter) ───────────────────────────────
  //    HYPOTHESIS H3: include_late is required as a STRING "true"
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm30, before: tp90, include_late: 'true' });
    const r = await runVariation(token,
      'V3 include_late=true (no filter)',
      'H3: include_late required as string "true" to surface overdue chores',
      path
    );
    results.push({ label: 'V3 include_late=true', ...r, path });
  }

  // ── V4: Very wide window — today-365d to today+365d ──────────────────────
  //    HYPOTHESIS H2b: the chore's start date is outside the window
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, include_late: 'true' });
    const r = await runVariation(token,
      'V4 VERY WIDE WINDOW (±365 days)',
      'H2b: chore start is outside today±30/+90 window',
      path
    );
    results.push({ label: 'V4 wide window ±365d', ...r, path });
  }

  // ── V5: Wide window WITH filter=linked_to_profile ───────────────────────
  //    Combined H1+H2 test
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, filter: 'linked_to_profile', include_late: 'true' });
    const r = await runVariation(token,
      'V5 WIDE WINDOW + filter=linked_to_profile',
      'H1+H2 combined: wide date range AND the web-client filter param',
      path
    );
    results.push({ label: 'V5 wide+filter', ...r, path });
  }

  // ── V6: NO date params at all ────────────────────────────────────────────
  //    See if omitting after/before causes a 422, or returns everything
  {
    const path = `/api/frames/${FRAME_ID}/chores`;
    const r = await runVariation(token,
      'V6 NO DATE PARAMS',
      'H2c: date params may be optional; omitting them may return all chores',
      path
    );
    results.push({ label: 'V6 no dates', ...r, path });
  }

  // ── V7: NO date params + filter=linked_to_profile ───────────────────────
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ filter: 'linked_to_profile', include_late: 'true' });
    const r = await runVariation(token,
      'V7 NO DATE PARAMS + filter=linked_to_profile',
      'H1+H2c combined: no dates, but include the web-client filter',
      path
    );
    results.push({ label: 'V7 no dates+filter', ...r, path });
  }

  // ── V8: Single-day window for today ─────────────────────────────────────
  //    The spec examples show after=before (same date)
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: today, before: today, include_late: 'true' });
    const r = await runVariation(token,
      'V8 TODAY SINGLE-DAY (after=before=today)',
      'H2d: spec examples show single-day windows; chore due today',
      path
    );
    results.push({ label: 'V8 today single-day', ...r, path });
  }

  // ── V9: Single-day window for today with filter ──────────────────────────
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: today, before: today, filter: 'linked_to_profile', include_late: 'true' });
    const r = await runVariation(token,
      'V9 TODAY SINGLE-DAY + filter=linked_to_profile',
      'H1+H2d: single-day window AND the filter the web client sends',
      path
    );
    results.push({ label: 'V9 today single-day+filter', ...r, path });
  }

  // ── V10: Category-scoped queries (KYLE) ──────────────────────────────────
  //    If there is a category_id / person_id / profile_id query param that
  //    scopes results to one person, test it.  The web URL has profileId; the
  //    research found no such API param in the spec, but worth trying common
  //    param names to detect an undocumented filter.
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, include_late: 'true', category_id: KYLE_CATEGORY_ID });
    const r = await runVariation(token,
      `V10 category_id=${KYLE_CATEGORY_ID} (Kyle)`,
      'H4a: undocumented category_id param for per-person scoping',
      path
    );
    results.push({ label: `V10 category_id=${KYLE_CATEGORY_ID}`, ...r, path });
  }

  // ── V11: Profile-scoped query (env SKYLIGHT_PROFILE_ID, if set) ──────────
  if (PROFILE_ID) {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, include_late: 'true', profile_id: PROFILE_ID });
    const r = await runVariation(token,
      `V11 profile_id=${PROFILE_ID} (env SKYLIGHT_PROFILE_ID)`,
      'H4b: undocumented profile_id param matching web URL ?profileId=',
      path
    );
    results.push({ label: `V11 profile_id=${PROFILE_ID}`, ...r, path });
  }

  // ── V12: task_box/items endpoint — FULL ENUMERATION ─────────────────────
  //    Per OpenAPI spec (TheEagleByte/skylight-api) this endpoint is NOT
  //    paginated: the response is a flat JSON:API array with no links/meta/
  //    cursor block.  The spec example shows exactly 17 items (Laundry,
  //    Dishes, etc.) which matches live results — so a single GET returns all.
  //    task_box_item objects have NO status/completed_on field; completing one
  //    converts it into a chore in the /chores endpoint.
  {
    const path = `/api/frames/${FRAME_ID}/task_box/items`;
    separator('V12 task_box/items — FULL ENUMERATION (not paginated per spec)');
    log(INFO, 'H4: task_box_items have no status field — completing one creates a chore.');
    log(INFO, 'NOTE: spec confirms no pagination (no links/meta/cursor); single GET returns all items.');
    log(INFO, `GET ${BASE}${path}`);

    const { status, ok, json, text } = await apiGet(token, path);
    log(ok ? PASS : FAIL, `HTTP ${status}`);

    if (!ok) {
      log(WARN, `  Failed. Snippet: ${text.slice(0, 300)}`);
      results.push({ label: 'V12 task_box', count: 0, chores: [], ok: false, path });
    } else {
      const items = Array.isArray(json?.data) ? json.data : (json?.data ? [json.data] : []);
      const count = items.length;
      log(INFO, `  TOTAL items in data[]: ${count}`);

      // Print a clean numbered table: # | ID | SUMMARY | EMOJI | ROUTINE | REWARD_PTS
      if (count > 0) {
        const pad  = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
        const rpad = (s, n) => String(s ?? '').slice(0, n).padStart(n);
        console.log('');
        console.log(
          `  ${ rpad('#', 3) }  ${ pad('ID', 12) }  ${ pad('SUMMARY', 32) }  ` +
          `${ pad('EMOJI', 6) }  ${ pad('ROUTINE', 7) }  ${ rpad('REWARD_PTS', 10) }`
        );
        console.log('  ' + '-'.repeat(82));
        items.forEach((item, idx) => {
          const a = item.attributes ?? {};
          console.log(
            `  ${ rpad(String(idx + 1), 3) }  ${ pad(item.id, 12) }  ${ pad(a.summary, 32) }  ` +
            `${ pad(a.emoji_icon ?? '', 6) }  ${ pad(String(a.routine ?? false), 7) }  ` +
            `${ rpad(String(a.reward_points ?? 'null'), 10) }`
          );
        });
        console.log('');
      }

      // Full raw JSON — no truncation
      const rawSnippet = JSON.stringify(json, null, 2);
      log(INFO, `  Raw JSON (full, ${rawSnippet.length} chars):`);
      console.log(rawSnippet);
      // Store items in chores array for search step (using summary field)
      results.push({ label: 'V12 task_box', count, chores: items, ok: true, path });
    }
  }

  // ── V13: Single-chore GET (SKYLIGHT_KNOWN_CHORE_ID) ──────────────────────
  if (KNOWN_CHORE_ID) {
    separator(`V13 SINGLE CHORE GET — id=${KNOWN_CHORE_ID}`);
    log(INFO, 'H5: single-fetch may work even when list queries return nothing');

    const path = `/api/frames/${FRAME_ID}/chores/${KNOWN_CHORE_ID}`;
    log(INFO, `GET ${BASE}${path}`);

    const { status, ok, json, text } = await apiGet(token, path);
    log(ok ? PASS : FAIL, `HTTP ${status}`);

    if (!ok) {
      log(WARN, `  Failed. Snippet: ${text.slice(0, 300)}`);
      results.push({ label: `V13 single id=${KNOWN_CHORE_ID}`, count: 0, chores: [], ok: false, path });
    } else {
      const rawSnippet = JSON.stringify(json, null, 2);
      log(INFO, `  Raw JSON (full, ${rawSnippet.length} chars):`);
      console.log(rawSnippet);

      const attrs = json?.data?.attributes ?? {};
      log(INFO, `  summary="${attrs.summary}" status="${attrs.status}" start="${attrs.start}" completed_on="${attrs.completed_on ?? 'null'}"`);
      const singleChore = json?.data ? [json.data] : [];
      results.push({ label: `V13 single id=${KNOWN_CHORE_ID}`, count: singleChore.length, chores: singleChore, ok: true, path });
    }
  }

  // ── V14: Categories endpoint (confirm linked_to_profile values) ───────────
  //    This is the definitive check for H1: if both Kyle and Amy have
  //    linked_to_profile:false, then filter=linked_to_profile will always
  //    return 0 results for this account, and we must omit the filter.
  {
    separator('V14 CATEGORIES (confirm linked_to_profile flags)');
    log(INFO, 'H1 check: are Kyle/Amy categories linked_to_profile:false? If so,');
    log(INFO, '          filter=linked_to_profile will ALWAYS return 0 chores.');

    const path = `/api/frames/${FRAME_ID}/categories`;
    log(INFO, `GET ${BASE}${path}`);

    const { status, ok, json, text } = await apiGet(token, path);
    log(ok ? PASS : FAIL, `HTTP ${status}`);

    if (!ok) {
      log(WARN, `  Failed. Snippet: ${text.slice(0, 300)}`);
    } else {
      const cats = json?.data ?? [];
      log(INFO, `  ${cats.length} categories returned`);

      const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
      console.log('');
      console.log(
        `  ${pad('CAT ID', 12)}  ${pad('LABEL', 24)}  ${pad('linked_to_profile', 18)}  ${pad('selected_for_chore_chart', 24)}`
      );
      console.log('  ' + '-'.repeat(84));
      for (const c of cats) {
        const a = c.attributes ?? {};
        console.log(
          `  ${pad(c.id, 12)}  ${pad(a.label, 24)}  ` +
          `${pad(String(a.linked_to_profile), 18)}  ` +
          `${pad(String(a.selected_for_chore_chart), 24)}`
        );
      }
      console.log('');

      // Diagnosis
      const linkedCats = cats.filter(c => c.attributes?.linked_to_profile === true);
      const unlinkedCats = cats.filter(c => c.attributes?.linked_to_profile !== true);
      if (linkedCats.length === 0) {
        log(WARN, '  DIAGNOSIS: ALL categories have linked_to_profile:false (or missing).');
        log(WARN, '  If filter=linked_to_profile is required, it will ALWAYS return 0.');
        log(WARN, '  The fix is to omit the filter param entirely.');
      } else {
        log(INFO, `  ${linkedCats.length} categories with linked_to_profile:true — those should appear with filter=linked_to_profile`);
        log(INFO, `  ${unlinkedCats.length} categories with linked_to_profile:false — those need filter omitted`);
      }
    }
  }

  // ── L1: Lists endpoint — enumerate ALL lists + items (sideloaded) ────────
  //
  //    SOURCE: rjhalvorson/skylight-mcp src/api/endpoints/lists.ts,
  //            TheEagleByte/skylight-api openapi.yaml
  //
  //    GET /api/frames/{frameId}/lists returns ALL lists for the frame plus
  //    ALL list items sideloaded in a top-level "included" array.  No query
  //    params, no profile scoping, no pagination.  A single call returns
  //    everything.
  //
  //    List kinds: "shopping" (grocery/store) | "to_do" (general checklist)
  //    List item attributes: { label, status ("pending"|"completed"),
  //      section (string|null), position (int), created_at (ISO8601) }
  //    List item has NO due_date and NO profile_id field — items are
  //    frame-scoped and shared.
  //
  //    Amy's items ("Mail" x2, "Groceries", "Coffee Prepped", "Laundry",
  //    "Dishes") are expected here, not in /chores.
  //    Kyle's "Inbound test delete" MAY also be here if it was added via
  //    the Lists surface (not the Tasks button with a due-date).

  let allListItems = [];    // collected for the search step below
  let allListsData = null;  // raw /lists response

  {
    separator('L1 LISTS — GET /api/frames/{frame}/lists (all lists + items sideloaded)');
    log(INFO, 'SOURCE: rjhalvorson/skylight-mcp src/api/endpoints/lists.ts');
    log(INFO, 'EXPECT: Amy\'s items (Mail, Groceries, Coffee Prepped, Laundry, Dishes)');
    log(INFO, '        Kyle\'s "Inbound test delete" may also be here (if via Lists surface)');
    log(INFO, 'SHAPE: data[]=lists, included[]=list_items (both pending + completed together)');

    const path = `/api/frames/${FRAME_ID}/lists`;
    log(INFO, `GET ${BASE}${path}`);

    const { status, ok, json, text } = await apiGet(token, path);
    log(ok ? PASS : FAIL, `HTTP ${status}`);
    results.push({ label: 'L1 lists', count: 0, chores: [], ok, path });

    if (!ok) {
      log(WARN, `  Failed. Snippet: ${text.slice(0, 500)}`);
    } else {
      allListsData = json;
      const lists  = Array.isArray(json?.data) ? json.data : [];
      const items  = Array.isArray(json?.included)
        ? json.included.filter(x => x.type === 'list_item')
        : [];

      allListItems = items;   // stash for search step
      results[results.length - 1].count = items.length;

      log(INFO, `  Lists returned: ${lists.length}`);
      log(INFO, `  List items (in included[]): ${items.length}`);

      // Print lists table
      if (lists.length > 0) {
        const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
        console.log('');
        console.log(`  ${pad('LIST_ID', 12)}  ${pad('LABEL', 28)}  ${pad('KIND', 10)}  ${pad('DEFAULT_GROCERY', 16)}  ${pad('HIDE_ON_DEVICE', 14)}`);
        console.log('  ' + '-'.repeat(88));
        for (const lst of lists) {
          const a = lst.attributes ?? {};
          console.log(
            `  ${pad(lst.id, 12)}  ${pad(a.label, 28)}  ${pad(a.kind, 10)}  ` +
            `${pad(String(a.default_grocery_list ?? false), 16)}  ${pad(String(a.hide_on_device ?? false), 14)}`
          );
        }
        console.log('');
      }

      // Print list items table
      if (items.length > 0) {
        const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
        console.log(`  LIST ITEMS (${items.length} total):`);
        console.log('');
        console.log(
          `  ${pad('ITEM_ID', 12)}  ${pad('LABEL', 30)}  ${pad('STATUS', 10)}  ` +
          `${pad('LIST_ID', 12)}  ${pad('SECTION', 16)}  ${pad('CREATED_AT', 28)}`
        );
        console.log('  ' + '-'.repeat(116));
        for (const item of items) {
          const a      = item.attributes ?? {};
          const listId = item.relationships?.list?.data?.id ?? 'none';
          const checkmark = a.status === 'completed' ? ' [CHECKED]' : '';
          console.log(
            `  ${pad(item.id, 12)}  ${pad(a.label, 30)}  ${pad(a.status, 10)}  ` +
            `${pad(listId, 12)}  ${pad(a.section ?? '', 16)}  ${pad(a.created_at ?? '', 28)}${checkmark}`
          );
        }
        console.log('');

        // Identify which list each item belongs to (join by id)
        const listById = new Map(lists.map(l => [l.id, l.attributes?.label ?? l.id]));
        console.log('  LIST MEMBERSHIP SUMMARY:');
        const byList = new Map();
        for (const item of items) {
          const listId = item.relationships?.list?.data?.id ?? 'none';
          if (!byList.has(listId)) byList.set(listId, []);
          byList.get(listId).push(item.attributes?.label ?? item.id);
        }
        for (const [listId, labels] of byList) {
          const listName = listById.get(listId) ?? listId;
          log(INFO, `  List "${listName}" (id=${listId}): ${labels.join(', ')}`);
        }
        console.log('');
      }

      // Raw JSON — cap at 2000 chars as instructed
      const rawSnippet = JSON.stringify(json, null, 2);
      log(INFO, `  Raw JSON (capped 2000 chars of ${rawSnippet.length} total):`);
      console.log(rawSnippet.slice(0, 2000) + (rawSnippet.length > 2000 ? '\n  ...[truncated]' : ''));
    }
  }

  // ── L2: Individual list drill-down (for each list found in L1) ───────────
  //
  //    GET /api/frames/{frameId}/lists/{listId}
  //    Same shape as L1 but scoped to a single list.  Only run if L1 found
  //    lists; otherwise skip.

  {
    const lists = Array.isArray(allListsData?.data) ? allListsData.data : [];

    if (lists.length === 0) {
      separator('L2 LIST DRILL-DOWN — skipped (L1 returned no lists)');
      log(INFO, '  Skipping: no lists were returned in L1.');
    } else {
      separator(`L2 LIST DRILL-DOWN — fetching each list individually (${lists.length} lists)`);
      log(INFO, 'SOURCE: rjhalvorson/skylight-mcp src/api/endpoints/lists.ts');
      log(INFO, 'GET /api/frames/{frame}/lists/{listId} — one call per list');

      for (const lst of lists) {
        const listName = lst.attributes?.label ?? lst.id;
        const path     = `/api/frames/${FRAME_ID}/lists/${lst.id}`;
        log(INFO, `\n  --- List "${listName}" (id=${lst.id}) ---`);
        log(INFO, `  GET ${BASE}${path}`);

        const { status, ok, json, text } = await apiGet(token, path);
        log(ok ? PASS : FAIL, `  HTTP ${status}`);

        if (!ok) {
          log(WARN, `  Failed. Snippet: ${text.slice(0, 300)}`);
          results.push({ label: `L2 list ${lst.id}`, count: 0, chores: [], ok: false, path });
          continue;
        }

        const items = Array.isArray(json?.included)
          ? json.included.filter(x => x.type === 'list_item')
          : [];

        log(INFO, `  Items in this list: ${items.length}`);

        const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
        if (items.length > 0) {
          console.log('');
          console.log(
            `    ${pad('ITEM_ID', 12)}  ${pad('LABEL', 30)}  ${pad('STATUS', 10)}  ` +
            `${pad('SECTION', 16)}  ${pad('CREATED_AT', 28)}`
          );
          console.log('    ' + '-'.repeat(100));
          for (const item of items) {
            const a = item.attributes ?? {};
            const checkmark = a.status === 'completed' ? ' [CHECKED]' : '';
            console.log(
              `    ${pad(item.id, 12)}  ${pad(a.label, 30)}  ${pad(a.status, 10)}  ` +
              `${pad(a.section ?? '', 16)}  ${pad(a.created_at ?? '', 28)}${checkmark}`
            );
          }
          console.log('');
        }

        // Merge any new items not in L1 allListItems
        const knownIds = new Set(allListItems.map(i => i.id));
        const newItems = items.filter(i => !knownIds.has(i.id));
        if (newItems.length > 0) {
          log(INFO, `  ${newItems.length} items not seen in L1 (adding to search set)`);
          allListItems.push(...newItems);
        }

        const rawSnippet = JSON.stringify(json, null, 2);
        log(INFO, `  Raw JSON (capped 2000 chars of ${rawSnippet.length} total):`);
        console.log(rawSnippet.slice(0, 2000) + (rawSnippet.length > 2000 ? '\n  ...[truncated]' : ''));

        results.push({ label: `L2 list ${lst.id}`, count: items.length, chores: [], ok: true, path });
      }
    }
  }

  // ── P1: Per-profile chore queries — Kyle (category 20976592) ─────────────
  //
  //    Research conclusion: there is NO category_id / profile_id query param
  //    on GET /api/frames/{frame}/chores.  Per-profile scoping is done CLIENT-
  //    SIDE by filtering on relationships.category.data.id.  We still test
  //    common param names (profile_id, person_id) to rule out undocumented
  //    filters.  The real per-profile work is done client-side below by
  //    filtering the V4 results (wide window, no filter param) by category id.
  //
  //    SOURCE: per-profile-scoping investigation findings

  let allChoresToday = [];   // collected for search step

  {
    separator('P1 PER-PROFILE CHORES — Kyle (category/profile 20976592)');
    log(INFO, 'SOURCE: per-profile scoping research (no server-side profile_id param exists)');
    log(INFO, 'APPROACH: query chores with wide window (no filter), filter client-side on');
    log(INFO, `  relationships.category.data.id === "${KYLE_CATEGORY_ID}"`);
    log(INFO, `  Also testing undocumented params: profile_id, person_id`);

    // P1a: wide window, no filter, client-side filter by Kyle's category id
    {
      const path = `/api/frames/${FRAME_ID}/chores` +
        qs({ after: tm365, before: tp365, include_late: 'true' });
      log(INFO, `\n  P1a: GET ${BASE}${path}`);

      const { status, ok, json, text } = await apiGet(token, path);
      log(ok ? PASS : FAIL, `  HTTP ${status}`);

      if (!ok) {
        log(WARN, `  Failed. Snippet: ${text.slice(0, 300)}`);
        results.push({ label: 'P1a Kyle wide-no-filter', count: 0, chores: [], ok: false, path });
      } else {
        const all = Array.isArray(json?.data) ? json.data : [];
        const kyleChores = all.filter(c =>
          c.relationships?.category?.data?.id === KYLE_CATEGORY_ID
        );
        const amyChores = all.filter(c =>
          c.relationships?.category?.data?.id === AMY_CATEGORY_ID
        );
        const otherChores = all.filter(c => {
          const cid = c.relationships?.category?.data?.id;
          return cid !== KYLE_CATEGORY_ID && cid !== AMY_CATEGORY_ID;
        });

        allChoresToday = all;   // stash for search step

        log(INFO, `  Total chores: ${all.length} | Kyle: ${kyleChores.length} | Amy: ${amyChores.length} | Other: ${otherChores.length}`);

        if (kyleChores.length > 0) {
          log(INFO, `\n  KYLE'S CHORES (cat=${KYLE_CATEGORY_ID}):`);
          dumpChores(kyleChores);
        } else {
          log(INFO, `  No chores found for Kyle (cat=${KYLE_CATEGORY_ID})`);
        }

        if (amyChores.length > 0) {
          log(INFO, `\n  AMY'S CHORES (cat=${AMY_CATEGORY_ID}):`);
          dumpChores(amyChores);
        } else {
          log(INFO, `  No chores found for Amy (cat=${AMY_CATEGORY_ID})`);
        }

        if (otherChores.length > 0) {
          log(INFO, `\n  OTHER/UNASSIGNED CHORES:`);
          dumpChores(otherChores);
        }

        const rawSnippet = JSON.stringify(json, null, 2);
        log(INFO, `  Raw JSON (capped 2000 chars of ${rawSnippet.length} total):`);
        console.log(rawSnippet.slice(0, 2000) + (rawSnippet.length > 2000 ? '\n  ...[truncated]' : ''));

        results.push({ label: 'P1a Kyle/Amy wide-no-filter (client-side split)', count: all.length, chores: all, ok: true, path });
      }
    }

    // P1b: undocumented profile_id param (expect same result as no param, or 422)
    {
      const path = `/api/frames/${FRAME_ID}/chores` +
        qs({ after: tm365, before: tp365, include_late: 'true', profile_id: KYLE_CATEGORY_ID });
      log(INFO, `\n  P1b (undocumented profile_id param): GET ${BASE}${path}`);

      const { status, ok, json, text } = await apiGet(token, path);
      log(ok ? PASS : FAIL, `  HTTP ${status}`);
      const items = ok ? (Array.isArray(json?.data) ? json.data : []) : [];
      log(INFO, `  Items returned: ${items.length} (404/422 = param unknown/rejected)`);
      if (!ok) log(INFO, `  Snippet: ${text.slice(0, 200)}`);
      results.push({ label: 'P1b undoc profile_id param Kyle', count: items.length, chores: items, ok, path });
    }

    // P1c: undocumented person_id param (same test)
    {
      const path = `/api/frames/${FRAME_ID}/chores` +
        qs({ after: tm365, before: tp365, include_late: 'true', person_id: KYLE_CATEGORY_ID });
      log(INFO, `\n  P1c (undocumented person_id param): GET ${BASE}${path}`);

      const { status, ok, json, text } = await apiGet(token, path);
      log(ok ? PASS : FAIL, `  HTTP ${status}`);
      const items = ok ? (Array.isArray(json?.data) ? json.data : []) : [];
      log(INFO, `  Items returned: ${items.length} (404/422 = param unknown/rejected)`);
      if (!ok) log(INFO, `  Snippet: ${text.slice(0, 200)}`);
      results.push({ label: 'P1c undoc person_id param Kyle', count: items.length, chores: items, ok, path });
    }
  }

  // ── P2: Per-profile chore queries — Amy (category 20976818) ──────────────
  //    Same approach as P1 but for Amy's undocumented-param tests.
  //    (Client-side Amy split was already printed in P1a above.)

  {
    separator('P2 PER-PROFILE CHORES — Amy (category/profile 20976818)');
    log(INFO, 'NOTE: Amy client-side split was already printed in P1a.');
    log(INFO, 'Here we only test undocumented server-side params for Amy.');

    // P2a: undocumented profile_id=Amy
    {
      const path = `/api/frames/${FRAME_ID}/chores` +
        qs({ after: tm365, before: tp365, include_late: 'true', profile_id: AMY_CATEGORY_ID });
      log(INFO, `\n  P2a (undocumented profile_id param): GET ${BASE}${path}`);

      const { status, ok, json, text } = await apiGet(token, path);
      log(ok ? PASS : FAIL, `  HTTP ${status}`);
      const items = ok ? (Array.isArray(json?.data) ? json.data : []) : [];
      log(INFO, `  Items returned: ${items.length}`);
      if (!ok) log(INFO, `  Snippet: ${text.slice(0, 200)}`);
      results.push({ label: 'P2a undoc profile_id param Amy', count: items.length, chores: items, ok, path });
    }

    // P2b: undocumented person_id=Amy
    {
      const path = `/api/frames/${FRAME_ID}/chores` +
        qs({ after: tm365, before: tp365, include_late: 'true', person_id: AMY_CATEGORY_ID });
      log(INFO, `\n  P2b (undocumented person_id param): GET ${BASE}${path}`);

      const { status, ok, json, text } = await apiGet(token, path);
      log(ok ? PASS : FAIL, `  HTTP ${status}`);
      const items = ok ? (Array.isArray(json?.data) ? json.data : []) : [];
      log(INFO, `  Items returned: ${items.length}`);
      if (!ok) log(INFO, `  Snippet: ${text.slice(0, 200)}`);
      results.push({ label: 'P2b undoc person_id param Amy', count: items.length, chores: items, ok, path });
    }
  }

  // ── COMPLETED-ITEM HUNT ───────────────────────────────────────────────────
  //
  //    Background (from spec + rjhalvorson/skylight-mcp source):
  //      - task_box_item objects have NO status/completed_on field.
  //      - Completing a task_box item CONVERTS it into a chore object of
  //        type "chore" with status:"complete" and completed_on set.
  //      - There is NO dedicated completed/history/archive endpoint in the API.
  //      - Therefore, completed items MUST be in the /chores endpoint.
  //
  //    We run three exploratory attempts to surface the 2 tasks the user
  //    created on-device (1 completed, 1 pending):
  //
  //    C1: Wide window, NO filter param — omit filter=linked_to_profile
  //        entirely.  If the newly-created chores were created under a
  //        category with linked_to_profile:false (e.g. the default device
  //        category), the filter would hide them.
  //
  //    C2: Wide window, filter=linked_to_profile — explicitly surface any
  //        chore with status:complete.  (This is the same as V5 but we re-run
  //        it here labelled as a "completed hunt" for clarity, and explicitly
  //        print a [COMPLETED] flag from dumpChores.)
  //
  //    C3: Wide window + status=complete param (exploratory — undocumented).
  //        The spec does NOT document a status query param; trying it to see if
  //        the API accepts it as an undocumented filter.  A 422/400 is
  //        informative.

  separator('COMPLETED-ITEM HUNT (C1–C3) — finding device-created/completed tasks');
  log(INFO, 'BACKGROUND: task_box_items have NO status field. Completing one creates a chore.');
  log(INFO, 'There is NO dedicated completed/history endpoint — completed items are in /chores.');
  log(INFO, 'The 2 tasks you created on-device should appear as chores below.');
  console.log('');

  // C1: No filter — don't restrict by linked_to_profile
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, include_late: 'true' });
    const r = await runVariation(token,
      'C1 COMPLETED HUNT — wide window, NO filter param (catches all categories)',
      'H6: newly-created device chores may be under a category not linked_to_profile',
      path
    );
    results.push({ label: 'C1 completed-hunt no-filter', ...r, path });
  }

  // C2: With filter=linked_to_profile — same as V5 but labelled for completed hunt
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, filter: 'linked_to_profile', include_late: 'true' });
    const r = await runVariation(token,
      'C2 COMPLETED HUNT — wide window + filter=linked_to_profile (check for [COMPLETED] flags)',
      'H6: completed items from device appear as chores with status:complete, completed_on set',
      path
    );
    results.push({ label: 'C2 completed-hunt with-filter', ...r, path });
  }

  // C3: Undocumented status=complete param (exploratory)
  {
    const path = `/api/frames/${FRAME_ID}/chores` +
      qs({ after: tm365, before: tp365, status: 'complete', include_late: 'true' });

    separator('C3 COMPLETED HUNT [EXPLORATORY] — undocumented status=complete param');
    log(INFO, 'EXPLORATORY: status= is NOT in the API spec. Testing if the server accepts it.');
    log(INFO, `GET ${BASE}${path}`);

    const { status, ok, json, text } = await apiGet(token, path);
    log(ok ? PASS : FAIL, `HTTP ${status}`);

    if (!ok) {
      log(status === 422 || status === 400
        ? INFO
        : WARN,
        `  HTTP ${status} — param likely rejected or ignored. Snippet: ${text.slice(0, 300)}`
      );
      results.push({ label: 'C3 status=complete param', count: 0, chores: [], ok: false, path });
    } else {
      const data   = json?.data;
      const chores = Array.isArray(data) ? data : (data ? [data] : []);
      log(INFO, `  Items in data[]: ${chores.length}`);
      dumpChores(chores);
      const rawSnippet = JSON.stringify(json, null, 2);
      log(INFO, `  Raw JSON (full, ${rawSnippet.length} chars):`);
      console.log(rawSnippet);
      results.push({ label: 'C3 status=complete param', count: chores.length, chores, ok: true, path });
    }
  }

  // ── SEARCH STEP: scan ALL items for "Inbound test" (case-insensitive) ────
  //
  //    Scans every item returned by every endpoint queried in this run:
  //      - chores (all variations V1–V14, C1–C3, P1–P2)
  //      - list items (L1, L2)
  //      - task_box items (V12)
  //
  //    Reports WHERE the string was found (which endpoint/variation) and
  //    prints the full object.  This directly answers: "which surface holds
  //    Kyle's tasks — the chores endpoint or the lists endpoint?"

  separator('SEARCH STEP — scanning ALL returned items for "Inbound test" (case-insensitive)');
  log(INFO, 'Scanning chores (all variations), list items (L1/L2), and task_box items.');
  log(INFO, 'Search string: "Inbound test" (case-insensitive)');
  console.log('');

  const SEARCH_RE = /inbound test/i;

  // Build a unified search corpus:
  //   { source: string, item: object, nameField: string }
  const searchCorpus = [];

  // 1. Chores from all results that tracked chore arrays
  const uniqueChoreIdsForSearch = new Set();
  for (const r of results) {
    if (r.ok && Array.isArray(r.chores)) {
      for (const c of r.chores) {
        if (!uniqueChoreIdsForSearch.has(c.id)) {
          uniqueChoreIdsForSearch.add(c.id);
          searchCorpus.push({ source: r.label, item: c, nameField: c.attributes?.summary ?? '' });
        }
      }
    }
  }

  // 2. List items collected in L1 + L2
  const uniqueListItemIds = new Set();
  for (const item of allListItems) {
    if (!uniqueListItemIds.has(item.id)) {
      uniqueListItemIds.add(item.id);
      searchCorpus.push({ source: 'L1/L2 lists', item, nameField: item.attributes?.label ?? '' });
    }
  }

  // 3. Task box items — re-parse from V12 result if present
  //    (V12 doesn't store items in r.chores so we look for the raw result)
  //    We query it again only if there were items — captured in results array
  //    The V12 result has count > 0 but chores=[] so items aren't accessible.
  //    We keep a separate reference by re-querying V12 here only if corpus is thin.
  //    Actually the items were printed but not stored — skip re-fetch; task_box
  //    summaries are visible in V12 output above.  Only note if task_box re-query
  //    is needed.

  const totalCorpusSize = searchCorpus.length;
  log(INFO, `Search corpus size: ${totalCorpusSize} unique items (${uniqueChoreIdsForSearch.size} chores + ${uniqueListItemIds.size} list items)`);
  console.log('');

  const searchHits = searchCorpus.filter(entry => SEARCH_RE.test(entry.nameField));

  if (searchHits.length === 0) {
    log(WARN, '"Inbound test" NOT FOUND in any item across all queried endpoints.');
    log(INFO, 'POSSIBLE REASONS:');
    log(INFO, '  1. The task was DELETED after completion (no longer in /chores).');
    log(INFO, '  2. It is in a list that was NOT returned by L1 (L1 failed or list is empty).');
    log(INFO, '  3. The mobile Tasks button creates chores with a different start-date field');
    log(INFO, '     that falls outside the ±365-day window used here.');
    log(INFO, '  4. The task lives under an undiscovered endpoint not yet queried.');
    log(INFO, '  5. Task was added to a profile/surface not reachable via this API.');
    log(INFO, '  6. The search string doesn\'t match (check spelling / completion renamed it).');
    console.log('');
  } else {
    log(PASS, `"Inbound test" FOUND in ${searchHits.length} item(s):`);
    console.log('');
    for (const hit of searchHits) {
      log(PASS, `  FOUND IN: ${hit.source}`);
      log(PASS, `  Name/summary: "${hit.nameField}"`);
      log(PASS, `  Full object:`);
      console.log(JSON.stringify(hit.item, null, 4).split('\n').map(l => '    ' + l).join('\n'));
      console.log('');
    }
  }

  // Also search for any item matching Amy's known item names
  const AMY_ITEMS_RE = /groceries|coffee prepped|coffee prep|laundry|dishes|^mail$/i;
  const amyHits = searchCorpus.filter(entry => AMY_ITEMS_RE.test(entry.nameField));
  if (amyHits.length > 0) {
    log(INFO, `Amy's named items found in corpus: ${amyHits.length} hit(s)`);
    for (const hit of amyHits) {
      log(INFO, `  "${hit.nameField}" in ${hit.source} (id=${hit.item.id}, type=${hit.item.type})`);
    }
    console.log('');
  } else {
    log(INFO, 'Amy\'s named items (Groceries, Coffee Prepped, Laundry, Dishes, Mail) not found in corpus.');
    log(INFO, '  If L1 failed, these items are likely in the Lists surface but were not returned.');
    console.log('');
  }

  // ─── FINAL SUMMARY ────────────────────────────────────────────────────────

  separator('FINAL SUMMARY');
  console.log('');

  const successful = results.filter(r => r.ok && r.count > 0);
  const failed     = results.filter(r => !r.ok);
  const empty      = results.filter(r => r.ok && r.count === 0);

  log(INFO, `Total variations run:          ${results.length}`);
  log(INFO, `Variations with HTTP errors:   ${failed.length}`);
  log(INFO, `Variations returning 0 items:  ${empty.length}`);
  log(INFO, `Variations returning ≥1 item:  ${successful.length}`);
  log(INFO, `List items found (L1/L2):      ${allListItems.length}`);
  log(INFO, `"Inbound test" search hits:    ${searchHits.length}`);
  console.log('');

  // Collect all chores seen across every variation that returned data
  const allChoresSeen = results
    .filter(r => r.ok && Array.isArray(r.chores))
    .flatMap(r => r.chores);

  // Deduplicate by id (same chore may appear in multiple variations)
  const uniqueChoresById = new Map();
  for (const c of allChoresSeen) {
    if (!uniqueChoresById.has(c.id)) uniqueChoresById.set(c.id, c);
  }
  const uniqueChores = [...uniqueChoresById.values()];
  const completedChores = uniqueChores.filter(c => {
    const a = c.attributes ?? {};
    return a.status === 'complete' || (a.completed_on != null && a.completed_on !== 'null');
  });

  if (completedChores.length > 0) {
    log(PASS, `COMPLETED CHORES FOUND across all variations: ${completedChores.length}`);
    for (const c of completedChores) {
      const a = c.attributes ?? {};
      const catId = c.relationships?.category?.data?.id ?? 'none';
      log(PASS, `  [COMPLETED] id=${c.id} summary="${a.summary}" completed_on=${a.completed_on} cat=${catId}`);
    }
    console.log('');
  }

  // Report list items summary
  if (allListItems.length > 0) {
    const pendingItems    = allListItems.filter(i => i.attributes?.status !== 'completed');
    const completedItems  = allListItems.filter(i => i.attributes?.status === 'completed');
    log(PASS, `LIST ITEMS FOUND (L1/L2): ${allListItems.length} total (${pendingItems.length} pending, ${completedItems.length} completed)`);
    for (const item of allListItems.slice(0, 20)) {
      const a      = item.attributes ?? {};
      const listId = item.relationships?.list?.data?.id ?? 'none';
      const flag   = a.status === 'completed' ? ' [CHECKED]' : '';
      log(PASS, `  "${a.label}"  status=${a.status}  list=${listId}${flag}`);
    }
    if (allListItems.length > 20) log(INFO, `  ... and ${allListItems.length - 20} more list items`);
    console.log('');
  }

  if (successful.length > 0) {
    log(PASS, 'WINNING VARIATIONS (returned items):');
    for (const r of successful) {
      log(PASS, `  ${r.label} → ${r.count} item(s)  [${BASE}${r.path}]`);
    }
    console.log('');

    // Pick the best chore variation (most chores) among chore endpoints only
    const choreResults = successful.filter(r => r.path.includes('/chores'));
    if (choreResults.length > 0) {
      const best = choreResults.reduce((a, b) => (b.count > a.count ? b : a));
      log(INFO, `Best chore variation: ${best.label} (${best.count} chores)`);
      console.log('');
      log(INFO, 'INBOUND SYNC ATTRIBUTES (from winning variation):');
      log(INFO, '  Pending chore:   attributes.status = "pending",  attributes.completed_on = null');
      log(INFO, '  Completed chore: attributes.status = "complete", attributes.completed_on = "YYYY-MM-DD"');
      log(INFO, '  Category:        relationships.category.data.id = "<category_id>"');
      log(INFO, '  Recurring ID:    "{templateId}-YYYY-MM-DD-HHMM" (occurrence), group = templateId');
      log(INFO, '  One-time ID:     plain integer string e.g. "12345678"');
      log(INFO, '');
    }

    if (allListItems.length > 0) {
      log(INFO, 'LISTS SURFACE ATTRIBUTES:');
      log(INFO, '  List item pending:   attributes.status = "pending"');
      log(INFO, '  List item completed: attributes.status = "completed"');
      log(INFO, '  List kind:           "shopping" (grocery) or "to_do" (general checklist)');
      log(INFO, '  No due_date, no profile_id on list items — frame-scoped + shared');
      log(INFO, '');
    }

    log(INFO, 'COMPLETED-ITEM HUNT NOTE: if the 2 device-created tasks are still missing,');
    log(INFO, '  check whether they appear under a DIFFERENT category id than Kyle/Amy.');
    log(INFO, '  Also check: did you complete the task from the task_box on the device?');
    log(INFO, '  If so, it should appear as a chore with status:complete in the chores list.');
    log(INFO, '  If "Inbound test" was added via Lists (not Tasks button), it will be in L1.');

    process.exit(0);

  } else if (allListItems.length > 0) {
    log(PASS, 'NO CHORES returned, but LIST ITEMS were found (L1/L2).');
    log(INFO, 'CONCLUSION: User items live in the Lists surface, not the chores endpoint.');
    log(INFO, '  The inbound sync should query GET /api/frames/{frame}/lists for list items.');
    process.exit(0);

  } else {
    log(FAIL, 'NO variation returned any chores or list items.');
    console.log('');
    log(FAIL, 'CONCLUSION: Inbound direction (Skylight→FairPlay) cannot be confirmed yet.');
    log(INFO, 'WHAT WAS TRIED:');
    for (const r of results) {
      const status = r.ok ? `HTTP 200, 0 items` : `HTTP error (${r.ok})`;
      log(INFO, `  ${r.label}: ${status}`);
    }
    console.log('');
    log(INFO, 'POSSIBLE CAUSES:');
    log(INFO, '  1. The chore was added on the device AFTER this script authenticated.');
    log(INFO, '     (Skylight may not expose device-initiated chores via this API path.)');
    log(INFO, '  2. The chore lives under a profile_id / linked_to_profile:true filter');
    log(INFO, '     and this account has no such categories.  Set SKYLIGHT_PROFILE_ID');
    log(INFO, '     (from the web URL ?profileId=<id>) and re-run.');
    log(INFO, '  3. The API may require specific session headers beyond the bearer token.');
    log(INFO, '  4. Device-side chores may be stored in a different data path not yet');
    log(INFO, '     reverse-engineered (e.g. a mobile-specific endpoint).');
    log(INFO, '  5. SKYLIGHT_KNOWN_CHORE_ID was not set — set it to confirm single-fetch.');
    log(INFO, '  6. The 2 device-created tasks may be in a different category — check V14');
    log(INFO, '     output for categories and compare with C1 results (no filter).');
    log(INFO, '  7. L1 (/lists) also returned nothing — check if L1 got HTTP 200 or an error.');

    process.exit(3);
  }
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
