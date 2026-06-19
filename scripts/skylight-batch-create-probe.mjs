/**
 * FAIRPLAY · Skylight Batch Chore Create Probe
 * =============================================
 * PURPOSE
 *   Empirically determine the correct request body shape for creating MULTIPLE
 *   chores in a single POST to /api/frames/{frameId}/chores/create_multiple.
 *
 *   The sync worker currently creates chores one-per-POST, burning Cloudflare's
 *   free-plan 50-subrequest limit on a 21-item sync. This probe tries four
 *   candidate body shapes and reports which one (if any) succeeds, plus exactly
 *   how the API maps created chores back in the response (order-preserving?
 *   description-echoed?).
 *
 * SAFETY
 *   Uses TEST frame 5381689 ("thehd") and category 20976592 (Kyle on test frame)
 *   ONLY. Never touches the real frame 5356033 ("heutoncal").
 *   All probe chores are deleted after each attempt; a final safety sweep removes
 *   any FPSYNC|probe chores that may have leaked.
 *
 * HOW TO RUN
 *   SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-batch-create-probe.mjs
 *
 * EXIT CODES
 *   0  a working batch shape was found
 *   1  missing env vars or auth failed
 *   2  auth succeeded but no working batch shape found (critical finding)
 */

// ─── Env / usage ──────────────────────────────────────────────────────────────

const EMAIL = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('USAGE:');
  console.error(
    '  SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-batch-create-probe.mjs'
  );
  process.exit(1);
}

// ─── Constants (TEST frame only — NEVER change these to the real frame) ───────

const FRAME_ID   = '5381689';   // "thehd" test frame
const CATEGORY_ID = '20976592'; // Kyle on test frame

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

// ─── PKCE helpers (copied verbatim from skylight-probe.mjs) ──────────────────

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

// ─── Cookie jar (copied verbatim from skylight-probe.mjs) ────────────────────

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

// ─── Fetch helpers (copied verbatim from skylight-probe.mjs) ─────────────────

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
    const snippet = text.slice(0, 500);
    throw new ApiError(`${method} ${path} => ${res.status} ${res.statusText}: ${snippet}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Non-throwing variant: returns { ok, status, body (parsed or text) }
async function apiCallRaw(method, path, token, bodyObj) {
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
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed, rawText: text };
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
  const line = '─'.repeat(64);
  if (title) {
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(line);
  } else {
    console.log(line);
  }
}

// ─── Auth (copied verbatim from skylight-probe.mjs) ──────────────────────────

async function doAuth() {
  separator('STEP 1 — OAuth Login (5-step PKCE)');

  const jar = new CookieJar();
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state = generateState();

  log(INFO, `PKCE verifier length: ${verifier.length} chars`);
  log(INFO, `State: ${state}`);

  // Step 1: initiate OAuth, capture session cookies
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

  // Step 2: load login form, extract authenticity_token
  log(INFO, 'Step 2: GET login form page...');
  const formUrl = loginFormUrl ?? authorizeUrl;
  const { res: r2, body: formHtml } = await rawFetch(
    formUrl,
    {
      headers: {
        ...COMMON_HEADERS,
        Cookie: jar.header(),
      },
    },
    jar
  );
  log(INFO, `  => HTTP ${r2.status}`);

  const tokenMatch = formHtml.match(
    /name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i
  ) ?? formHtml.match(
    /value=["']([^"']+)["'][^>]*name=["']authenticity_token["']/i
  );

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
      codeRedirect.startsWith('/')
        ? `${BASE}${codeRedirect}`
        : codeRedirect
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

// ─── Chores list helper ───────────────────────────────────────────────────────

function choresListPath(frameId, afterDate, beforeDate) {
  const qs = new URLSearchParams({
    after: afterDate,
    before: beforeDate,
    include_late: 'true',
    include_up_for_grabs: 'true',
    filter: 'linked_to_profile',
  });
  return `/api/frames/${frameId}/chores?${qs}`;
}

// ─── Delete helper ────────────────────────────────────────────────────────────

/**
 * Delete a single chore by id. Tolerates 404 (already gone). Returns true if
 * deleted (or already gone), false on other errors.
 */
async function deleteChore(token, choreId) {
  const path = `/api/frames/${FRAME_ID}/chores/${choreId}`;
  try {
    await apiCall('DELETE', path, token);
    return true;
  } catch (err) {
    if (err.status === 404) {
      log(INFO, `  DELETE id=${choreId} => 404 (already gone — OK)`);
      return true;
    }
    log(WARN, `  DELETE id=${choreId} failed: ${err.message}`);
    return false;
  }
}

/**
 * Delete a list of chore ids, logging each. Collects and returns the ids that
 * failed.
 */
async function deleteChores(token, ids) {
  const failed = [];
  for (const id of ids) {
    const ok = await deleteChore(token, id);
    if (ok) {
      log(INFO, `  [DELETED] id=${id}`);
    } else {
      failed.push(id);
    }
  }
  return failed;
}

// ─── Chore body builder ───────────────────────────────────────────────────────

/**
 * Build the flat chore body for a single chore (confirmed working shape from
 * skylight-probe.mjs). The start date is set 7 days from now so chores appear
 * in a standard list window.
 */
function makeChoreBody(summaryLabel, descriptionTag, startDate) {
  return {
    summary:      summaryLabel,
    start:        startDate,
    start_time:   null,
    recurring:    false,
    reward_points: null,
    emoji_icon:   null,
    category_id:  CATEGORY_ID,
    category_ids: [CATEGORY_ID],
    description:  `FPSYNC|${descriptionTag}`,
  };
}

// ─── Batch shape candidates ───────────────────────────────────────────────────

/**
 * Returns the four candidate body shapes to try, in the order specified.
 * Each shape is { label, body }.
 */
function buildCandidates(choreA, choreB) {
  return [
    {
      label: '(a) { chores: [choreA, choreB] }',
      body: { chores: [choreA, choreB] },
    },
    {
      label: '(b) top-level JSON array [choreA, choreB]',
      body: [choreA, choreB],
    },
    {
      label: '(c) { data: [choreA, choreB] }',
      body: { data: [choreA, choreB] },
    },
    {
      label: '(d) { chores_attributes: [choreA, choreB] }',
      body: { chores_attributes: [choreA, choreB] },
    },
    {
      label: '(e) { chore: [choreA, choreB] }',
      body: { chore: [choreA, choreB] },
    },
  ];
}

// ─── Response analysis ────────────────────────────────────────────────────────

/**
 * Inspect a successful (2xx) response and determine:
 *   - How many chores are in data[]
 *   - Whether each entry carries the expected description (FPSYNC marker)
 *   - The ids of all created chores
 *   - Whether response order matches request order (by description)
 *   - A quoted structure excerpt for the first entry
 *
 * Returns { count, ids, descriptionEchoed, orderPreserved, structureExcerpt }
 */
function analyzeResponse(respBody, choreA, choreB) {
  const data = respBody?.data;
  if (!Array.isArray(data)) {
    return {
      count: 0,
      ids: [],
      descriptionEchoed: false,
      orderPreserved: false,
      structureExcerpt: null,
      note: `data[] is not an array — top-level keys: ${Object.keys(respBody ?? {}).join(', ')}`,
    };
  }

  const count = data.length;
  const ids = data.map((e) => e?.id).filter(Boolean);

  // Check whether description is echoed back in each entry
  const descriptionEchoed = data.every(
    (e) => typeof (e?.attributes?.description ?? e?.description) === 'string'
  );

  // Check order preservation: entry 0 should match choreA's description, entry 1 = choreB
  const descA = choreA.description;
  const descB = choreB.description;
  const getDesc = (e) => e?.attributes?.description ?? e?.description ?? '';
  const orderPreserved =
    count >= 2 &&
    getDesc(data[0]) === descA &&
    getDesc(data[1]) === descB;

  // Quote the structure of data[0] (truncated for readability)
  const structureExcerpt = JSON.stringify(data[0], null, 2).slice(0, 800);

  return { count, ids, descriptionEchoed, orderPreserved, structureExcerpt, note: null };
}

// ─── Safety sweep (always run at end) ────────────────────────────────────────

/**
 * GET all chores on the test frame in a wide window, delete any whose
 * description starts with "FPSYNC|probe". Returns the count of remaining
 * FPSYNC|probe chores after sweep.
 */
async function safetySweep(token) {
  separator('CLEANUP — Safety Sweep');
  const now = new Date();
  const afterDate = new Date(now);
  afterDate.setDate(afterDate.getDate() - 7);
  const beforeDate = new Date(now);
  beforeDate.setDate(beforeDate.getDate() + 30);
  const after  = afterDate.toISOString().slice(0, 10);
  const before = beforeDate.toISOString().slice(0, 10);

  log(INFO, `GET chores on test frame (${after} to ${before}) for FPSYNC|probe sweep...`);
  let chores;
  try {
    const resp = await apiCall('GET', choresListPath(FRAME_ID, after, before), token);
    chores = resp?.data ?? [];
  } catch (err) {
    log(WARN, `  Could not GET chores for safety sweep: ${err.message}`);
    log(WARN, '  Frame cleanliness is UNVERIFIED — check manually.');
    return -1;
  }

  const probes = chores.filter((c) => {
    const desc = c?.attributes?.description ?? '';
    return desc.startsWith('FPSYNC|probe');
  });

  log(INFO, `  Total chores found: ${chores.length}, FPSYNC|probe chores: ${probes.length}`);

  if (probes.length === 0) {
    log(PASS, 'Safety sweep: no FPSYNC|probe chores found — frame is clean.');
    return 0;
  }

  log(INFO, `  Deleting ${probes.length} FPSYNC|probe chore(s)...`);
  for (const c of probes) {
    const ok = await deleteChore(token, c.id);
    if (ok) log(INFO, `  [SWEPT] id=${c.id} summary="${c.attributes?.summary}"`);
  }

  // Re-GET to confirm
  let remaining = -1;
  try {
    const resp2 = await apiCall('GET', choresListPath(FRAME_ID, after, before), token);
    const probes2 = (resp2?.data ?? []).filter((c) =>
      (c?.attributes?.description ?? '').startsWith('FPSYNC|probe')
    );
    remaining = probes2.length;
    if (remaining === 0) {
      log(PASS, `Safety sweep: re-GET confirms 0 FPSYNC|probe chores remain — frame is clean.`);
    } else {
      log(FAIL, `Safety sweep: ${remaining} FPSYNC|probe chore(s) still remain after sweep!`);
      log(WARN, '  Manual cleanup may be needed.');
    }
  } catch (err) {
    log(WARN, `  Could not re-GET for confirmation: ${err.message}`);
  }

  return remaining;
}

// ─── Main batch probe ─────────────────────────────────────────────────────────

async function runBatchProbe(token) {
  separator('STEP 2 — Build Probe Chores');

  // Use a date 7 days from now (well within any standard list window)
  const startDate = new Date();
  startDate.setDate(startDate.getDate() + 7);
  const start = startDate.toISOString().slice(0, 10);

  const choreA = makeChoreBody('FP batch probe 1', 'probe-batch-1', start);
  const choreB = makeChoreBody('FP batch probe 2', 'probe-batch-2', start);

  log(INFO, `Probe chore A: summary="${choreA.summary}", description="${choreA.description}", start=${start}`);
  log(INFO, `Probe chore B: summary="${choreB.summary}", description="${choreB.description}", start=${start}`);
  log(INFO, `Category: ${CATEGORY_ID} (Kyle on test frame)`);
  log(INFO, `Frame: ${FRAME_ID} (thehd — TEST ONLY)`);

  const candidates = buildCandidates(choreA, choreB);
  const createPath = `/api/frames/${FRAME_ID}/chores/create_multiple`;

  // Track ALL created ids across all attempts for final cleanup
  const allCreatedIds = new Set();

  let workingShape = null;
  let workingAnalysis = null;

  separator('STEP 3 — Try Candidate Batch Body Shapes');

  for (let i = 0; i < candidates.length; i++) {
    const { label, body } = candidates[i];
    console.log('');
    log(INFO, `─── Candidate ${label} ───`);
    log(INFO, `POST ${createPath}`);
    log(INFO, `Body: ${JSON.stringify(body).slice(0, 300)}`);

    const result = await apiCallRaw('POST', createPath, token, body);

    log(INFO, `HTTP ${result.status}`);

    if (!result.ok) {
      // 4xx/5xx — log error body and move on
      const errorSnippet = typeof result.body === 'string'
        ? result.body.slice(0, 500)
        : JSON.stringify(result.body).slice(0, 500);
      log(WARN, `  Non-2xx response (${result.status}). Error body: ${errorSnippet}`);
      // A 500/4xx on ONE shape says nothing about the others — try them ALL.
      continue;
    }

    // 2xx — analyze
    const analysis = analyzeResponse(result.body, choreA, choreB);

    log(INFO, `  data[] count: ${analysis.count}`);
    log(INFO, `  ids from response: [${analysis.ids.join(', ')}]`);
    log(INFO, `  description echoed in response: ${analysis.descriptionEchoed}`);
    if (analysis.note) log(WARN, `  NOTE: ${analysis.note}`);

    // Collect all returned ids for cleanup regardless of success
    for (const id of analysis.ids) allCreatedIds.add(id);

    if (analysis.count === 2 && analysis.ids.length === 2) {
      log(PASS, `Candidate ${i + 1} returned 2 chores — this is the WORKING shape!`);
      workingShape = { label, body };
      workingAnalysis = analysis;

      // Delete these chores before reporting (clean frame)
      log(INFO, '  Deleting the 2 created chores (cleanup before reporting)...');
      await deleteChores(token, analysis.ids);
      // Remove from allCreatedIds since we already deleted them
      for (const id of analysis.ids) allCreatedIds.delete(id);

      break; // Stop at first working candidate
    } else if (analysis.count === 1) {
      log(WARN, `  Only 1 chore created (not 2) — this shape may be single-only. Continuing.`);
      // Still delete what was created
      log(INFO, '  Deleting the created chore before next attempt...');
      await deleteChores(token, analysis.ids);
      for (const id of analysis.ids) allCreatedIds.delete(id);
    } else {
      log(WARN, `  Unexpected count=${analysis.count} — continuing.`);
      if (analysis.ids.length > 0) {
        log(INFO, '  Deleting any created chores before next attempt...');
        await deleteChores(token, analysis.ids);
        for (const id of analysis.ids) allCreatedIds.delete(id);
      }
    }
  }

  // ─── Final cleanup of any leaked ids ──────────────────────────────────────
  if (allCreatedIds.size > 0) {
    separator('CLEANUP — Deleting Any Remaining Probe Chores');
    log(INFO, `Deleting ${allCreatedIds.size} chore(s) not yet cleaned up: [${[...allCreatedIds].join(', ')}]`);
    await deleteChores(token, [...allCreatedIds]);
  }

  // ─── Safety sweep ──────────────────────────────────────────────────────────
  const remainingCount = await safetySweep(token);

  // ─── Final summary ─────────────────────────────────────────────────────────
  separator('FINAL SUMMARY');
  console.log('');

  if (!workingShape) {
    log(FAIL, 'CRITICAL FINDING: NONE of the 4 candidate batch shapes created 2 chores.');
    log(FAIL, 'create_multiple may only accept a single flat chore body (current behavior).');
    log(INFO, '');
    log(INFO, 'Candidates tried:');
    for (const c of candidates) log(INFO, `  - ${c.label}`);
    log(INFO, '');
    log(INFO, 'RECOMMENDATION: The sync worker cannot be batched via create_multiple.');
    log(INFO, '  Consider: sub-request counting audit, or a queue-based approach.');
    console.log('');
    return false;
  }

  log(PASS, `WORKING BATCH SHAPE: ${workingShape.label}`);
  console.log('');
  log(INFO, 'Verbatim JSON skeleton for the working body:');
  console.log(JSON.stringify(workingShape.body, (key, val) => {
    // Replace the actual chore objects with a skeleton placeholder
    if (typeof val === 'object' && val !== null && !Array.isArray(val) && val.summary) {
      return { '...': '(flat chore object — see makeChoreBody above)' };
    }
    return val;
  }, 2));
  console.log('');

  log(INFO, `Response mapping:`);
  log(INFO, `  data[] count:               ${workingAnalysis.count} (expected 2)`);
  log(INFO, `  order preserved (A then B): ${workingAnalysis.orderPreserved}`);
  log(INFO, `  description echoed:         ${workingAnalysis.descriptionEchoed}`);
  log(INFO, '');
  log(INFO, 'Structure of data[0] from the successful response:');
  console.log(workingAnalysis.structureExcerpt ?? '(unavailable)');
  console.log('');

  if (workingAnalysis.orderPreserved) {
    log(PASS, 'Chores are ORDER-PRESERVED — safe to match by position in data[].');
  } else {
    log(WARN, 'Order is NOT preserved (or could not be verified) — match by description (FPSYNC marker).');
  }

  if (workingAnalysis.descriptionEchoed) {
    log(PASS, 'description IS echoed in response — FPSYNC marker match is reliable.');
  } else {
    log(WARN, 'description is NOT echoed — cannot match chores by description in response; use position only.');
  }

  console.log('');
  if (remainingCount === 0) {
    log(PASS, `Cleanup: frame is confirmed clean (0 FPSYNC|probe chores remain).`);
  } else if (remainingCount > 0) {
    log(FAIL, `Cleanup: ${remainingCount} FPSYNC|probe chore(s) remain — manual cleanup needed.`);
  } else {
    log(WARN, 'Cleanup: could not confirm frame cleanliness (GET failed).');
  }

  console.log('');
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Batch Chore Create Probe');
  console.log('=============================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame:    ${FRAME_ID} (thehd — TEST ONLY)`);
  console.log(`Category: ${CATEGORY_ID} (Kyle on test frame)`);
  console.log('');
  console.log('WARNING: This uses Skylight\'s UNOFFICIAL reverse-engineered API.');
  console.log('         Personal use only on your own account.');
  console.log('');

  // Auth
  let token;
  try {
    token = await doAuth();
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    process.exit(1);
  }

  // Batch probe
  let success = false;
  try {
    success = await runBatchProbe(token);
  } catch (err) {
    log(FAIL, `Batch probe encountered an unexpected error: ${err.message}`);
    console.error(err.stack);
    // Still try safety sweep on unexpected error
    try {
      await safetySweep(token);
    } catch (sweepErr) {
      log(WARN, `Safety sweep also failed: ${sweepErr.message}`);
    }
    process.exit(2);
  }

  process.exit(success ? 0 : 2);
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
