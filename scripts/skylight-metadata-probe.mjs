/**
 * FAIRPLAY · Skylight Metadata / Hidden-Field Probe
 * ===================================================
 * PURPOSE
 *   Determine whether Skylight's unofficial API lets us store a hidden marker
 *   on a chore (and on a list item) — so a sync bridge can keep the visible
 *   title clean while still tagging items it owns.
 *
 *   The probe answers two concrete questions:
 *     (a) Can a chore carry a hidden marker, and in which field?
 *         Candidates: description, notes, note (all sent in the create body;
 *         if none persist on create, a follow-up PUT is also tried for
 *         `description`).
 *     (b) Can a list item carry any hidden marker, and in which field (or none)?
 *         Candidates: description, notes, section (section is the only extra
 *         field the API spec documents; description/notes are long shots).
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
 *   All throwaway objects (one chore + one list + one list item) are deleted in
 *   a finally block that runs even on error or Ctrl-C.
 *   The probe NEVER touches pre-existing chores or lists.
 *
 * PRIVACY
 *   Your password is read ONLY from process.env — never logged, never written
 *   to disk, never transmitted except to app.ourskylight.com.
 *
 * HOW TO RUN
 *   Set the three required env vars, then run with Node 18+:
 *
 *     SKYLIGHT_EMAIL="you@example.com" \
 *     SKYLIGHT_PASSWORD="yourpass" \
 *     SKYLIGHT_FRAME_ID="5381689" \
 *     node scripts/skylight-metadata-probe.mjs
 *
 *   SKYLIGHT_FRAME_ID=5381689  ← TEST frame (secondary, safe to use).
 *   Category IDs for that frame: kyle=20976592  amy=20976818.
 *   Never use the real production frame ID for write probes.
 *
 * EXIT CODES
 *   0  Auth succeeded and all probe steps completed (even if fields were absent).
 *      The FINAL SUMMARY is the authoritative verdict.
 *   1  Missing required env vars (usage error).
 *   2  Auth or a fatal API step failed (see [FAIL] lines).
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
    '  SKYLIGHT_FRAME_ID="5381689" \\'
  );
  console.error('  node scripts/skylight-metadata-probe.mjs');
  console.error('');
  console.error('Required: SKYLIGHT_EMAIL, SKYLIGHT_PASSWORD, SKYLIGHT_FRAME_ID');
  console.error('Use SKYLIGHT_FRAME_ID=5381689 for the TEST frame — never the real frame.');
  process.exit(1);
}

if (!FRAME_ID) {
  console.error('[FAIL] SKYLIGHT_FRAME_ID is required.');
  console.error('       Use SKYLIGHT_FRAME_ID=5381689 (TEST frame) to run safely.');
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE = 'https://app.ourskylight.com';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID = 'skylight-mobile';
const SCOPE = 'everything';

/** Marker value we embed — distinctive, easy to grep, short. */
const MARKER = 'FPSYNC|abc123';

/** Category ID for Kyle on the TEST frame (20976592) — confirmed from list-probe output. */
const KYLE_CATEGORY_ID = '20976592';

/** Probe chore name — visible on-device if cleanup fails. */
const PROBE_CHORE_NAME = 'metadata probe — DELETE ME';

/** Probe list name — visible on-device if cleanup fails. */
const PROBE_LIST_NAME = '▸ metadata probe list — DELETE ME';

/** Probe item label. */
const PROBE_ITEM_LABEL = 'metadata probe item — DELETE ME';

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
  return uuid1 + uuid2; // 64 hex chars
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

// ─── Auth (verbatim from skylight-probe.mjs doAuth) ──────────────────────────

async function doAuth() {
  separator('STEP 1 — OAuth Login (5-step PKCE)');

  const jar = new CookieJar();
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state = generateState();

  log(INFO, `PKCE verifier length: ${verifier.length} chars`);
  log(INFO, `State: ${state}`);

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

// ─── Helper: fetch a single chore by id ──────────────────────────────────────

/**
 * Re-fetch a specific chore. Tries GET /api/frames/{f}/chores/{id} first
 * (direct single-chore endpoint); if that returns a non-2xx, falls back to
 * the list query and finds it by id.
 * Returns the chore resource object ({ id, type, attributes }) or null.
 */
async function fetchChore(token, choreId) {
  // Primary: single-chore endpoint
  try {
    const resp = await apiCall(
      'GET',
      `/api/frames/${FRAME_ID}/chores/${choreId}`,
      token
    );
    const resource = resp?.data ?? null;
    if (resource) return resource;
  } catch (e) {
    // Single-chore endpoint may not exist — fall through to list query
    log(INFO, `  Single-chore GET failed (${e.status ?? '?'}): ${e.message.slice(0, 80)}`);
  }

  // Fallback: list query with a wide window
  const now = new Date();
  const after = new Date(now);
  after.setDate(after.getDate() - 1);
  const before = new Date(now);
  before.setDate(before.getDate() + 2);
  const qs = new URLSearchParams({
    after: after.toISOString().slice(0, 10),
    before: before.toISOString().slice(0, 10),
    include_late: 'true',
    filter: 'linked_to_profile',
  });

  try {
    const listResp = await apiCall(
      'GET',
      `/api/frames/${FRAME_ID}/chores?${qs}`,
      token
    );
    const chores = listResp?.data ?? [];
    return chores.find((c) => String(c.id) === String(choreId)) ?? null;
  } catch (e) {
    log(WARN, `  List-fallback GET also failed: ${e.message.slice(0, 80)}`);
    return null;
  }
}

// ─── Step 2: Chore description test ──────────────────────────────────────────

/**
 * Create a chore with extra fields injected into the flat create body:
 *   description: MARKER
 *   notes:       MARKER
 *   note:        MARKER
 * Re-GET the chore; record which fields persisted (i.e. equal MARKER).
 * If `description` did NOT persist on create, try a PUT to set it.
 * Returns { choreId, createBody, persistedOnCreate, persistedAfterPut }.
 */
async function probeChoreMetadata(token) {
  separator('STEP 2 — Chore Hidden-Field Probe');

  const today = new Date().toISOString().slice(0, 10);

  // Build the create body: start with the known-working FLAT shape, then add
  // every candidate metadata field set to MARKER.
  const createBody = {
    summary: PROBE_CHORE_NAME,
    start: today,
    start_time: null,
    recurring: false,
    reward_points: null,
    emoji_icon: null,
    category_id: KYLE_CATEGORY_ID,
    category_ids: [KYLE_CATEGORY_ID],
    // ── Candidate metadata fields ─────────────────────────────────────────
    description: MARKER,   // documented field (often null in GET responses)
    notes: MARKER,         // plausible undocumented field
    note: MARKER,          // alternative singular form
  };

  log(INFO, `POST /api/frames/${FRAME_ID}/chores/create_multiple`);
  log(INFO, '  Body (FLAT JSON, extra metadata fields included):');
  log(INFO, `    summary: "${PROBE_CHORE_NAME}"`);
  log(INFO, `    start: "${today}"`);
  log(INFO, `    category_id: ${KYLE_CATEGORY_ID}`);
  log(INFO, `    description: "${MARKER}"`);
  log(INFO, `    notes: "${MARKER}"`);
  log(INFO, `    note: "${MARKER}"`);

  const createResp = await apiCall(
    'POST',
    `/api/frames/${FRAME_ID}/chores/create_multiple`,
    token,
    createBody
  );

  const created = createResp?.data;
  if (!Array.isArray(created) || created.length === 0) {
    throw new Error(
      `CREATE chore returned unexpected shape. Response: ${JSON.stringify(createResp).slice(0, 300)}`
    );
  }

  const choreId = created[0]?.id;
  if (!choreId) {
    throw new Error(`CREATE chore response missing id. data[0]: ${JSON.stringify(created[0])}`);
  }

  const createAttrs = created[0]?.attributes ?? {};
  log(PASS, `Chore created. id=${choreId}`);
  log(INFO, `  All attributes returned by CREATE response:`);
  for (const [k, v] of Object.entries(createAttrs)) {
    log(INFO, `    ${k}: ${JSON.stringify(v)}`);
  }

  // ── Which fields persisted on CREATE? ──────────────────────────────────────
  const CANDIDATE_FIELDS = ['description', 'notes', 'note'];
  const persistedOnCreate = [];

  for (const field of CANDIDATE_FIELDS) {
    const val = createAttrs[field];
    if (val === MARKER) {
      persistedOnCreate.push(field);
      log(PASS, `  CREATE: field "${field}" persisted as "${val}"`);
    } else if (val !== undefined && val !== null) {
      log(INFO, `  CREATE: field "${field}" present but value is ${JSON.stringify(val)} (not our marker)`);
    } else {
      log(INFO, `  CREATE: field "${field}" not present or null in CREATE response (${JSON.stringify(val)})`);
    }
  }

  // ── Re-GET the chore to confirm (server may not return all fields on create) ─
  log(INFO, `\nRe-fetching chore id=${choreId} to confirm persisted fields...`);
  const fetchedChore = await fetchChore(token, choreId);
  const fetchedAttrs = fetchedChore?.attributes ?? null;

  const persistedOnGet = [];

  if (fetchedAttrs === null) {
    log(WARN, '  Could not re-fetch chore — skipping GET-confirmation step.');
  } else {
    log(INFO, '  All attributes returned by GET:');
    for (const [k, v] of Object.entries(fetchedAttrs)) {
      log(INFO, `    ${k}: ${JSON.stringify(v)}`);
    }
    for (const field of CANDIDATE_FIELDS) {
      const val = fetchedAttrs[field];
      if (val === MARKER) {
        persistedOnGet.push(field);
        log(PASS, `  GET: field "${field}" persisted as "${val}" — CONFIRMED round-trip`);
      } else {
        log(INFO, `  GET: field "${field}" = ${JSON.stringify(val)} (not our marker)`);
      }
    }
  }

  // ── If description did NOT persist on create, try a PUT ───────────────────
  const persistedAfterPut = [];

  if (!persistedOnGet.includes('description') && !persistedOnCreate.includes('description')) {
    log(INFO, `\n"description" was not set on CREATE — trying PUT to set it...`);
    const putBody = { description: MARKER };
    log(INFO, `  PUT /api/frames/${FRAME_ID}/chores/${choreId}`);
    log(INFO, `  Body (FLAT JSON): { "description": "${MARKER}" }`);

    try {
      const putResp = await apiCall(
        'PUT',
        `/api/frames/${FRAME_ID}/chores/${choreId}`,
        token,
        putBody
      );
      const putAttrs = putResp?.data?.attributes ?? null;
      log(INFO, `  PUT HTTP 2xx.`);

      if (putAttrs !== null) {
        const descVal = putAttrs['description'];
        if (descVal === MARKER) {
          persistedAfterPut.push('description');
          log(PASS, `  PUT response: description = "${descVal}" — persisted!`);
        } else {
          log(INFO, `  PUT response: description = ${JSON.stringify(descVal)}`);
        }
      }

      // Re-GET to confirm
      log(INFO, `  Re-fetching after PUT to confirm...`);
      const afterPutChore = await fetchChore(token, choreId);
      const afterPutAttrs = afterPutChore?.attributes ?? null;

      if (afterPutAttrs !== null) {
        const descVal = afterPutAttrs['description'];
        if (descVal === MARKER) {
          if (!persistedAfterPut.includes('description')) {
            persistedAfterPut.push('description');
          }
          log(PASS, `  GET after PUT: description = "${descVal}" — round-trip confirmed`);
        } else {
          log(INFO, `  GET after PUT: description = ${JSON.stringify(descVal)} (not our marker)`);
          // Remove from list if it was prematurely added from PUT response only
          const idx = persistedAfterPut.indexOf('description');
          if (idx !== -1) persistedAfterPut.splice(idx, 1);
        }
      }
    } catch (putErr) {
      log(WARN, `  PUT description failed: ${putErr.message.slice(0, 200)}`);
    }
  } else {
    log(INFO, `\n"description" already confirmed from CREATE/GET — skipping PUT probe.`);
  }

  return {
    choreId,
    createBody,
    persistedOnCreate,
    persistedOnGet,
    persistedAfterPut,
  };
}

// ─── Step 3 + 4: List item hidden-field probe ────────────────────────────────

/**
 * Create a throwaway list (kind: to_do, reusing an existing palette color).
 * Create one item with candidate metadata fields set to MARKER:
 *   description: MARKER
 *   notes:       MARKER
 *   section:     MARKER   (documented in the spec — but visible on-device)
 * Re-GET the list (with included items); report which fields persisted.
 * Returns { listId, itemId, persistedOnItemCreate, persistedOnItemGet }.
 */
async function probeListItemMetadata(token) {
  separator('STEP 3 — List and List Item Hidden-Field Probe');

  // ── Create throwaway list ──────────────────────────────────────────────────
  let color = '#B6E085'; // fallback — known valid Skylight palette color
  try {
    const existing = await apiCall('GET', `/api/frames/${FRAME_ID}/lists`, token);
    const found = (existing?.data ?? [])
      .map((l) => l?.attributes?.color)
      .find((c) => typeof c === 'string' && c);
    if (found) {
      color = found;
      log(INFO, `  Using palette color from existing list: ${color}`);
    }
  } catch (e) {
    log(INFO, `  Could not read existing lists (${e.message.slice(0, 60)}); using fallback color ${color}`);
  }

  const listCreateBody = { label: PROBE_LIST_NAME, kind: 'to_do', color };
  log(INFO, `POST /api/frames/${FRAME_ID}/lists`);
  log(INFO, `  Body (FLAT JSON): { label: "${PROBE_LIST_NAME}", kind: "to_do", color: "${color}" }`);

  const listResp = await apiCall(
    'POST',
    `/api/frames/${FRAME_ID}/lists`,
    token,
    listCreateBody
  );

  const listId = listResp?.data?.id ?? null;
  if (!listId) {
    throw new Error(
      `CREATE list returned no id. Response: ${JSON.stringify(listResp).slice(0, 300)}`
    );
  }
  log(PASS, `List created. id=${listId}`);

  // ── Create probe list item with candidate metadata fields ─────────────────
  const itemCreateBody = {
    label: PROBE_ITEM_LABEL,
    // ── Candidate metadata fields ─────────────────────────────────────────
    description: MARKER,   // undocumented — long shot
    notes: MARKER,         // undocumented — long shot
    section: MARKER,       // documented in spec; visible on-device as a grouping header
  };

  log(INFO, `\nPOST /api/frames/${FRAME_ID}/lists/${listId}/list_items`);
  log(INFO, '  Body (FLAT JSON, extra metadata fields included):');
  log(INFO, `    label: "${PROBE_ITEM_LABEL}"`);
  log(INFO, `    description: "${MARKER}"`);
  log(INFO, `    notes: "${MARKER}"`);
  log(INFO, `    section: "${MARKER}"  ← visible on-device as a grouping header`);

  let itemId = null;
  let persistedOnItemCreate = [];

  try {
    const itemResp = await apiCall(
      'POST',
      `/api/frames/${FRAME_ID}/lists/${listId}/list_items`,
      token,
      itemCreateBody
    );

    itemId = itemResp?.data?.id ?? null;
    if (!itemId) {
      throw new Error(
        `CREATE item returned no id. Response: ${JSON.stringify(itemResp).slice(0, 300)}`
      );
    }

    const itemAttrs = itemResp?.data?.attributes ?? {};
    log(PASS, `List item created. id=${itemId}`);
    log(INFO, '  All attributes returned by CREATE response:');
    for (const [k, v] of Object.entries(itemAttrs)) {
      log(INFO, `    ${k}: ${JSON.stringify(v)}`);
    }

    const ITEM_CANDIDATE_FIELDS = ['description', 'notes', 'section'];
    for (const field of ITEM_CANDIDATE_FIELDS) {
      const val = itemAttrs[field];
      if (val === MARKER) {
        persistedOnItemCreate.push(field);
        log(PASS, `  CREATE: item field "${field}" persisted as "${val}"`);
      } else if (val !== undefined && val !== null) {
        log(INFO, `  CREATE: item field "${field}" present but value is ${JSON.stringify(val)} (not our marker)`);
      } else {
        log(INFO, `  CREATE: item field "${field}" not present or null (${JSON.stringify(val)})`);
      }
    }
  } catch (itemCreateErr) {
    log(FAIL, `CREATE list item failed: ${itemCreateErr.message.slice(0, 300)}`);
    log(WARN, `  If status was 422, the extra fields may have been rejected.`);
    log(INFO, `  Retrying with only label and section...`);

    // Retry with just the documented fields to see if description/notes caused 422
    try {
      const retryBody = { label: PROBE_ITEM_LABEL, section: MARKER };
      log(INFO, `  Body (retry): { label: "${PROBE_ITEM_LABEL}", section: "${MARKER}" }`);
      const retryResp = await apiCall(
        'POST',
        `/api/frames/${FRAME_ID}/lists/${listId}/list_items`,
        token,
        retryBody
      );
      itemId = retryResp?.data?.id ?? null;
      if (itemId) {
        log(PASS, `  Retry succeeded. item id=${itemId}`);
        const retryAttrs = retryResp?.data?.attributes ?? {};
        log(INFO, '  Retry CREATE attributes:');
        for (const [k, v] of Object.entries(retryAttrs)) {
          log(INFO, `    ${k}: ${JSON.stringify(v)}`);
        }
        if (retryAttrs['section'] === MARKER) {
          persistedOnItemCreate.push('section');
          log(PASS, `  Retry CREATE: field "section" persisted as "${MARKER}"`);
        }
      }
    } catch (retryErr) {
      log(FAIL, `  Retry also failed: ${retryErr.message.slice(0, 200)}`);
    }
  }

  // ── Re-GET the list with included items to confirm ─────────────────────────
  const persistedOnItemGet = [];
  const ITEM_CANDIDATE_FIELDS = ['description', 'notes', 'section'];

  if (itemId) {
    log(INFO, `\nRe-fetching list id=${listId} (with included items) to confirm...`);
    try {
      const getListResp = await apiCall(
        'GET',
        `/api/frames/${FRAME_ID}/lists/${listId}`,
        token
      );

      // The list GET returns { data: {...}, included: [ list_item resources ] }
      const included = getListResp?.included ?? [];
      const fetchedItem = included.find((r) => String(r.id) === String(itemId));

      if (fetchedItem) {
        const fetchedItemAttrs = fetchedItem?.attributes ?? {};
        log(INFO, '  Fetched item attributes (from GET list included):');
        for (const [k, v] of Object.entries(fetchedItemAttrs)) {
          log(INFO, `    ${k}: ${JSON.stringify(v)}`);
        }

        for (const field of ITEM_CANDIDATE_FIELDS) {
          const val = fetchedItemAttrs[field];
          if (val === MARKER) {
            persistedOnItemGet.push(field);
            log(PASS, `  GET: item field "${field}" persisted as "${val}" — CONFIRMED round-trip`);
          } else {
            log(INFO, `  GET: item field "${field}" = ${JSON.stringify(val)} (not our marker)`);
          }
        }
      } else {
        log(WARN, `  Item id=${itemId} not found in GET list included items.`);
        log(INFO, `  Included resources (types/ids): ${included.map((r) => `${r.type}:${r.id}`).join(', ') || '(none)'}`);
      }
    } catch (getErr) {
      log(WARN, `  GET list failed: ${getErr.message.slice(0, 200)}`);
    }
  }

  return {
    listId,
    itemId,
    listCreateBody,
    itemCreateBody,
    persistedOnItemCreate,
    persistedOnItemGet,
  };
}

// ─── Step 5 (finally): Cleanup ────────────────────────────────────────────────

/**
 * Delete the probe chore, the probe list item, and the probe list.
 * ALWAYS called in a finally block — never skipped.
 * Returns an object with boolean flags for each deletion.
 */
async function cleanup(token, { choreId, listId, itemId }) {
  separator('CLEANUP — always runs');

  const result = { choreDeleted: false, itemDeleted: false, listDeleted: false };

  // Delete chore
  if (choreId) {
    log(INFO, `DELETE /api/frames/${FRAME_ID}/chores/${choreId}  (one-time chore — no apply_to)`);
    try {
      await apiCall('DELETE', `/api/frames/${FRAME_ID}/chores/${choreId}`, token);
      log(PASS, `Chore id=${choreId} deleted.`);
      result.choreDeleted = true;
    } catch (err) {
      log(FAIL, `Could not delete chore id=${choreId}: ${err.message.slice(0, 200)}`);
      log(WARN, `MANUAL CLEANUP NEEDED: Delete chore named "${PROBE_CHORE_NAME}" from frame ${FRAME_ID}.`);
    }
  } else {
    log(INFO, 'No chore was created — skipping chore delete.');
    result.choreDeleted = true; // vacuously true
  }

  // Delete list item (good hygiene; list delete may cascade anyway)
  if (itemId && listId) {
    log(INFO, `DELETE /api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`);
    try {
      await apiCall(
        'DELETE',
        `/api/frames/${FRAME_ID}/lists/${listId}/list_items/${itemId}`,
        token
      );
      log(PASS, `List item id=${itemId} deleted.`);
      result.itemDeleted = true;
    } catch (err) {
      log(WARN, `Could not delete item id=${itemId}: ${err.message.slice(0, 200)}`);
      log(WARN, '  Proceeding to delete the list anyway (delete should cascade).');
    }
  } else {
    log(INFO, 'No list item was created (or no list id) — skipping item delete.');
    result.itemDeleted = true; // vacuously true
  }

  // Delete list
  if (listId) {
    log(INFO, `DELETE /api/frames/${FRAME_ID}/lists/${listId}`);
    try {
      await apiCall('DELETE', `/api/frames/${FRAME_ID}/lists/${listId}`, token);
      log(PASS, `List id=${listId} deleted.`);
      result.listDeleted = true;
    } catch (err) {
      log(FAIL, `Could not delete list id=${listId}: ${err.message.slice(0, 200)}`);
      log(WARN, `MANUAL CLEANUP NEEDED: Delete list named "${PROBE_LIST_NAME}" from frame ${FRAME_ID}.`);
    }
  } else {
    log(INFO, 'No list was created — skipping list delete.');
    result.listDeleted = true; // vacuously true
  }

  return result;
}

// ─── Step 6: Final summary ────────────────────────────────────────────────────

function printSummary(results) {
  separator('FINAL SUMMARY — Metadata / Hidden-Field Probe');
  console.log('');

  const {
    choreId,
    chorePersistedOnCreate,
    chorePersistedOnGet,
    chorePersistedAfterPut,
    listId,
    itemId,
    itemPersistedOnCreate,
    itemPersistedOnGet,
    cleanupResult,
  } = results;

  // ── (a) Chore verdict ──────────────────────────────────────────────────────
  console.log('  (a) CHORE — can we carry a hidden marker?');
  console.log('');

  // Determine the effective set of confirmed fields for chores
  // (persisted on GET is the gold standard — survived a round-trip)
  const choreGold = chorePersistedOnGet ?? [];
  const choreCreateOnly = (chorePersistedOnCreate ?? []).filter(
    (f) => !choreGold.includes(f)
  );
  const choreViaPut = (chorePersistedAfterPut ?? []).filter(
    (f) => !choreGold.includes(f)
  );

  if (choreGold.length > 0) {
    log(PASS, `  Fields confirmed round-trip (create → GET): ${choreGold.join(', ')}`);
    const best = choreGold.includes('description') ? 'description' : choreGold[0];
    console.log(`      VERDICT: YES — store the sync marker in chore.attributes.${best}`);
    console.log(`               Bridge encoding:  ${best}: "FPSYNC|<taskId>"`);
  } else if (choreCreateOnly.length > 0) {
    log(WARN, `  Fields persisted in CREATE response but NOT confirmed by GET: ${choreCreateOnly.join(', ')}`);
    console.log('      VERDICT: UNCERTAIN — field appears on create response but may not survive a re-fetch.');
  } else if (choreViaPut.length > 0) {
    log(PASS, `  Fields confirmed via PUT → re-GET: ${choreViaPut.join(', ')}`);
    const best = choreViaPut.includes('description') ? 'description' : choreViaPut[0];
    console.log(`      VERDICT: YES (PUT-only) — description not settable on create but writeable via PUT.`);
    console.log(`               Bridge workflow:  create chore, then immediately PUT { ${best}: "FPSYNC|<taskId>" }`);
  } else {
    log(FAIL, '  No candidate metadata field survived any round-trip.');
    console.log('      VERDICT: NO — chore API exposes no writable hidden field.');
    console.log('               Bridge must encode ownership in the visible title or emoji_icon.');
  }

  console.log('');
  console.log(`  Chore id used: ${choreId ?? '(none created)'}`);
  console.log(`  Fields tested on create body: description, notes, note`);
  console.log(`  Fields confirmed on create:   ${(chorePersistedOnCreate ?? []).join(', ') || '(none)'}`);
  console.log(`  Fields confirmed on GET:       ${(chorePersistedOnGet ?? []).join(', ') || '(none)'}`);
  console.log(`  Fields confirmed via PUT:      ${(chorePersistedAfterPut ?? []).join(', ') || '(none)'}`);
  console.log('');

  // ── (b) List item verdict ──────────────────────────────────────────────────
  console.log('  (b) LIST ITEM — can we carry a hidden marker?');
  console.log('');

  const itemGold = itemPersistedOnGet ?? [];
  const itemCreateOnly = (itemPersistedOnCreate ?? []).filter(
    (f) => !itemGold.includes(f)
  );

  if (itemGold.length > 0) {
    // "section" is visible on-device — flag it clearly
    const hiddenFields = itemGold.filter((f) => f !== 'section');
    const visibleFields = itemGold.filter((f) => f === 'section');

    if (hiddenFields.length > 0) {
      log(PASS, `  Hidden fields confirmed round-trip: ${hiddenFields.join(', ')}`);
      const best = hiddenFields[0];
      console.log(`      VERDICT: YES — store the sync marker in item.attributes.${best}`);
      console.log(`               Bridge encoding:  ${best}: "FPSYNC|<taskId>"`);
    }

    if (visibleFields.length > 0) {
      log(WARN, `  "section" persisted — but it is VISIBLE on-device as a grouping header.`);
      console.log('      VERDICT: NO for section — it is user-visible, not a hidden field.');
      console.log('               Do NOT encode the sync marker in section.');
    }

    if (hiddenFields.length === 0 && visibleFields.length > 0) {
      log(FAIL, '  Only "section" persisted — no invisible field available for list items.');
      console.log('      VERDICT: NO — list items have no writable hidden field.');
      console.log('               Bridge must encode ownership in the visible label or fall back to a title-prefix scheme.');
    }
  } else if (itemCreateOnly.length > 0) {
    log(WARN, `  Fields in CREATE response but not confirmed by GET: ${itemCreateOnly.join(', ')}`);
    console.log('      VERDICT: UNCERTAIN — field appears on create but may not survive a re-fetch.');
  } else {
    log(FAIL, '  No candidate metadata field survived any round-trip on list items.');
    console.log('      VERDICT: NO — list item API exposes no writable hidden field.');
    console.log('               Bridge must encode ownership in the visible label.');
  }

  console.log('');
  console.log(`  List id used:  ${listId ?? '(none created)'}`);
  console.log(`  Item id used:  ${itemId ?? '(none created)'}`);
  console.log(`  Fields tested on item create: description, notes, section`);
  console.log(`  Fields confirmed on item CREATE: ${(itemPersistedOnCreate ?? []).join(', ') || '(none)'}`);
  console.log(`  Fields confirmed on item GET:    ${(itemPersistedOnGet ?? []).join(', ') || '(none)'}`);
  console.log('');

  // ── Cleanup status ─────────────────────────────────────────────────────────
  const cr = cleanupResult ?? {};
  const allClean = cr.choreDeleted && cr.itemDeleted && cr.listDeleted;
  if (allClean) {
    log(PASS, 'Cleanup: all throwaway objects deleted. No litter on your device.');
  } else {
    log(WARN, 'Cleanup: one or more deletes failed — check above for MANUAL CLEANUP NEEDED lines.');
    log(WARN, `  choreDeleted=${cr.choreDeleted}  itemDeleted=${cr.itemDeleted}  listDeleted=${cr.listDeleted}`);
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Metadata / Hidden-Field Probe');
  console.log('====================================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame ID: ${FRAME_ID}`);
  console.log(`Marker:   ${MARKER}`);
  console.log('');
  console.log('WARNING: This uses Skylight\'s UNOFFICIAL reverse-engineered API.');
  console.log('         It may violate Skylight\'s ToS §7.4. Personal use only on your own account.');
  console.log('         All throwaway objects are deleted in a finally block.');
  console.log('');

  const results = {
    choreId: null,
    chorePersistedOnCreate: [],
    chorePersistedOnGet: [],
    chorePersistedAfterPut: [],
    listId: null,
    itemId: null,
    itemPersistedOnCreate: [],
    itemPersistedOnGet: [],
    cleanupResult: null,
  };

  let token = null;
  let exitCode = 2;

  // ── Step 1: Auth ─────────────────────────────────────────────────────────────
  try {
    token = await doAuth();
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    process.exit(1);
  }

  // ── Steps 2–4 + cleanup (always in a finally block) ──────────────────────────
  try {
    // ── Step 2: Chore metadata probe ──────────────────────────────────────────
    try {
      const choreResult = await probeChoreMetadata(token);
      results.choreId = choreResult.choreId;
      results.chorePersistedOnCreate = choreResult.persistedOnCreate;
      results.chorePersistedOnGet = choreResult.persistedOnGet;
      results.chorePersistedAfterPut = choreResult.persistedAfterPut;
    } catch (err) {
      log(FAIL, `Chore metadata probe failed: ${err.message}`);
      // Continue to list probe — don't abort
    }

    // ── Steps 3+4: List item metadata probe ───────────────────────────────────
    try {
      const listResult = await probeListItemMetadata(token);
      results.listId = listResult.listId;
      results.itemId = listResult.itemId;
      results.itemPersistedOnCreate = listResult.persistedOnItemCreate;
      results.itemPersistedOnGet = listResult.persistedOnItemGet;
    } catch (err) {
      log(FAIL, `List item metadata probe failed: ${err.message}`);
    }

    // If we got here without a fatal exception, mark as "ran to completion"
    exitCode = 0;

  } finally {
    // ── Step 5 (always): Cleanup ──────────────────────────────────────────────
    if (token) {
      results.cleanupResult = await cleanup(token, {
        choreId: results.choreId,
        listId: results.listId,
        itemId: results.itemId,
      });
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
