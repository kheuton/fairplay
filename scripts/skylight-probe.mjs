/**
 * FAIRPLAY · Skylight API Validation Probe
 * ==========================================
 * PURPOSE
 *   This script validates whether Skylight's UNOFFICIAL, REVERSE-ENGINEERED
 *   private API supports the two-way sync needed for FairPlay integration.
 *   It tests authentication, read access, chore creation, status updates, and
 *   cleanup — producing a PASS/FAIL summary that answers whether two-way sync
 *   is viable on your account.
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
 * PRIVACY
 *   - Your password is read ONLY from process.env — never logged, never written
 *     to disk, never transmitted except to app.ourskylight.com.
 *   - Nothing is written to disk. The script runs entirely in memory.
 *
 * HOW TO RUN
 *   SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-probe.mjs
 *
 *   Optional: supply a known frame ID to skip frame discovery:
 *   SKYLIGHT_EMAIL=... SKYLIGHT_PASSWORD=... SKYLIGHT_FRAME_ID="12345" node scripts/skylight-probe.mjs
 *
 *   Optional: supply a known category ID to assign the probe chore to a person:
 *   SKYLIGHT_CATEGORY_ID="999" ...
 *   (If omitted, the script fetches GET /api/frames/{id}/categories and uses
 *    the first id found; if that also fails, falls back to up_for_grabs: true.)
 *
 * WHAT IT DOES (in order)
 *   Exp 2a — OAuth login (5-step PKCE flow) → bearer token
 *   Exp 2b — GET /api/frames/{id}/chores → proves read access; prints compact table
 *   Exp 3  — GET /api/frames/{id}/categories → prints id/label/person table;
 *             DELETE any leftover probe chores from prior runs →
 *             POST create throwaway chore (with category_ids or up_for_grabs) →
 *             PUT status update (FLAT body { status: "complete" } — evidence-backed) →
 *             GET confirm → user is asked to check physical device → DELETE cleanup
 *
 * EXIT CODES
 *   0  auth + read + at least one status string succeeded
 *   1  auth failed or missing env vars
 *   2  auth succeeded but read or write experiments failed
 */

// ─── Env / usage ──────────────────────────────────────────────────────────────

const EMAIL = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;
const FRAME_ID_ENV = process.env.SKYLIGHT_FRAME_ID ?? null;

// Optional env overrides for the chore-list date window (YYYY-MM-DD).
// Defaults: after = today − 30 days, before = today + 90 days.
const SKYLIGHT_AFTER = process.env.SKYLIGHT_AFTER ?? null;
const SKYLIGHT_BEFORE = process.env.SKYLIGHT_BEFORE ?? null;

// Optional: supply a known category ID to assign the probe chore to a person.
// If not set, doWriteProbe() will attempt GET /api/frames/{id}/categories first.
const SKYLIGHT_CATEGORY_ID_ENV = process.env.SKYLIGHT_CATEGORY_ID ?? null;

if (!EMAIL || !PASSWORD) {
  console.error('USAGE:');
  console.error(
    '  SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-probe.mjs'
  );
  console.error('');
  console.error('Optional:  SKYLIGHT_FRAME_ID="12345"  (skip frame discovery)');
  process.exit(1);
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BASE = 'https://app.ourskylight.com';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID = 'skylight-mobile';
const SCOPE = 'everything';

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

const PROBE_CHORE_NAME = 'FairPlay sync probe — SAFE TO DELETE';

// ─── PKCE helpers ─────────────────────────────────────────────────────────────

/**
 * Generate a 64-character PKCE code_verifier by concatenating two UUIDs
 * with hyphens removed, matching the rjhalvorson/skylight-mcp approach.
 */
function generateVerifier() {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return uuid1 + uuid2; // 64 hex chars
}

/**
 * Base64url-encode a Uint8Array (no padding, URL-safe chars).
 */
function base64url(bytes) {
  // btoa works on binary strings
  const binaryStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binaryStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SHA-256 PKCE challenge from verifier string.
 */
async function computeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

/**
 * 10-character random state string (alphanumeric, UUID-derived).
 */
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
    // headers is a Headers object or an iterable of [name, value] pairs
    if (!headers) return;
    const setCookieValues = [];
    if (typeof headers.getSetCookie === 'function') {
      // Node 18.14+ / undici
      setCookieValues.push(...headers.getSetCookie());
    } else if (typeof headers.get === 'function') {
      // Fallback: single header (won't work for multiple, but try)
      const v = headers.get('set-cookie');
      if (v) setCookieValues.push(v);
    }
    for (const raw of setCookieValues) {
      // raw = "name=value; Path=/; HttpOnly; ..."
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

// ─── Fetch helper ─────────────────────────────────────────────────────────────

/**
 * Perform a fetch call, ingest any Set-Cookie headers into jar (if supplied),
 * and return { res, body } where body is text.
 * Does NOT follow redirects — always redirect: 'manual'.
 */
async function rawFetch(url, opts, jar) {
  const res = await fetch(url, { ...opts, redirect: 'manual' });
  if (jar) jar.ingest(res.headers);
  const body = await res.text().catch(() => '');
  return { res, body };
}

/**
 * Authenticated API call (after bearer token is obtained).
 * Follows redirects normally. Returns parsed JSON or throws on non-2xx.
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
    throw new ApiError(`${method} ${path} => ${res.status} ${res.statusText}: ${snippet}`, res.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
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

// ─── Chores path helper ───────────────────────────────────────────────────────

/**
 * Build the chores list path for a frame, including the required date-window
 * query params `after` and `before` (format: YYYY-MM-DD).
 *
 * Defaults: after = today − 30 days, before = today + 90 days.
 * Override via env vars SKYLIGHT_AFTER / SKYLIGHT_BEFORE.
 */
function choresPath(frameId) {
  function isoDate(d) {
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
  }
  const now = new Date();
  const afterDate = new Date(now);
  afterDate.setDate(afterDate.getDate() - 30);
  const beforeDate = new Date(now);
  beforeDate.setDate(beforeDate.getDate() + 90);

  const after  = SKYLIGHT_AFTER  ?? isoDate(afterDate);
  const before = SKYLIGHT_BEFORE ?? isoDate(beforeDate);

  const qs = new URLSearchParams({ after, before });
  return `/api/frames/${frameId}/chores?${qs}`;
}

// ─── Auth (Experiment 2a) ─────────────────────────────────────────────────────

/**
 * Run the 5-step OAuth/PKCE login flow and return the bearer token string.
 * Throws on any failure; logs progress to stdout.
 */
async function doAuth() {
  separator('EXPERIMENT 2a — OAuth Login (5-step PKCE)');

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

  // Expect a 302 redirect to the login form
  const loginFormUrl = r1.headers.get('location');
  if (!loginFormUrl) {
    // Some server configs return 200 directly with the form
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

// ─── Read (Experiment 2b) ─────────────────────────────────────────────────────

/**
 * Discover the frame ID (from env or first frame found), then list chores.
 * Returns { frameId, chores }.
 */
async function doRead(token) {
  separator('EXPERIMENT 2b — Read Access (List Chores)');

  let frameId = FRAME_ID_ENV;

  if (frameId) {
    log(INFO, `Using SKYLIGHT_FRAME_ID from env: ${frameId}`);
    // Verify it exists
    try {
      const frame = await apiCall('GET', `/api/frames/${frameId}`, token);
      const attrs = frame?.data?.attributes ?? {};
      log(INFO, `  Frame verified: "${attrs.name ?? '(no name)'}" (id=${frameId})`);
    } catch (err) {
      log(WARN, `  Could not verify frame ${frameId}: ${err.message}`);
      log(WARN, '  Proceeding anyway — chore list will confirm whether the ID is valid.');
    }
  } else {
    log(INFO, 'No SKYLIGHT_FRAME_ID env var — frame ID must be supplied.');
    log(WARN, 'The Skylight API has no public /api/frames list endpoint.');
    log(WARN, 'Set SKYLIGHT_FRAME_ID to your frame ID to proceed with read/write tests.');
    log(WARN, '(Discover it by proxying the Skylight app network traffic.)');
    throw new Error(
      'SKYLIGHT_FRAME_ID is required. ' +
      'Set it in your environment: SKYLIGHT_FRAME_ID="<your-frame-id>" ...'
    );
  }

  log(INFO, `Fetching chores for frame ${frameId}...`);
  const data = await apiCall('GET', choresPath(frameId), token);
  const chores = data?.data ?? [];
  log(PASS, `Read succeeded. ${chores.length} chores returned.`);

  // Print compact table
  if (chores.length === 0) {
    log(INFO, '  (no chores found — frame may be empty)');
  } else {
    const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
    const rpad = (s, n) => String(s ?? '').slice(0, n).padStart(n);
    console.log('');
    console.log(
      `${pad('ID', 12)}  ${pad('SUMMARY', 36)}  ${pad('STATUS', 12)}  ${pad('START', 10)}  ${pad('RECURRING', 9)}`
    );
    console.log('-'.repeat(86));
    for (const c of chores.slice(0, 30)) {
      const a = c.attributes ?? {};
      console.log(
        `${pad(c.id, 12)}  ${pad(a.summary, 36)}  ${pad(a.status, 12)}  ${pad(a.start, 10)}  ${rpad(a.recurring ? 'yes' : 'no', 9)}`
      );
    }
    if (chores.length > 30) {
      log(INFO, `  ... and ${chores.length - 30} more (truncated for readability)`);
    }
  }

  return { frameId, chores };
}

// ─── Write + status-string probe (Experiment 3) ───────────────────────────────

/**
 * Fetch GET /api/frames/{frameId}/categories and print a compact table.
 * Returns the first category id found, or null on failure.
 * Never throws — logs WARN on error so the probe can continue.
 */
async function fetchCategories(token, frameId) {
  log(INFO, `Fetching categories for frame ${frameId}...`);
  log(INFO, `  GET /api/frames/${frameId}/categories`);
  try {
    const data = await apiCall('GET', `/api/frames/${frameId}/categories`, token);
    const cats = data?.data ?? [];
    if (cats.length === 0) {
      log(WARN, '  No categories returned — will fall back to up_for_grabs.');
      return null;
    }

    // Print compact table: id | label | linked_to_profile | selected_for_chore_chart
    const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
    console.log('');
    console.log(
      `${pad('CAT ID', 12)}  ${pad('LABEL', 24)}  ${pad('PERSON?', 8)}  ${pad('CHORE CHART?', 12)}`
    );
    console.log('-'.repeat(62));
    for (const c of cats) {
      const a = c.attributes ?? {};
      console.log(
        `${pad(c.id, 12)}  ${pad(a.label, 24)}  ${pad(a.linked_to_profile ? 'yes' : 'no', 8)}  ${pad(a.selected_for_chore_chart ? 'yes' : 'no', 12)}`
      );
    }
    console.log('');

    log(PASS, `Categories fetched. ${cats.length} categories found.`);
    return cats[0]?.id ?? null;
  } catch (err) {
    log(WARN, `  Could not fetch categories: ${err.message}`);
    log(WARN, '  Proceeding without category assignment (will use up_for_grabs).');
    return null;
  }
}

/**
 * Create a throwaway chore, test status update with both candidate strings,
 * confirm on re-GET, and return { choreId, confirmedStatusString }.
 * Always cleans up (DELETE) in a finally block.
 */
async function doWriteProbe(token, frameId) {
  separator('EXPERIMENT 3 — Write Probe (create + status update + cleanup)');

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let choreId = null;
  let confirmedStatusString = null;

  // ── Resolve category id for chore assignment ────────────────────────────
  // Priority: (1) SKYLIGHT_CATEGORY_ID env var, (2) first from GET categories,
  // (3) no category → fall back to up_for_grabs: true.
  let categoryId = null;
  if (SKYLIGHT_CATEGORY_ID_ENV) {
    categoryId = SKYLIGHT_CATEGORY_ID_ENV;
    log(INFO, `Using SKYLIGHT_CATEGORY_ID from env: ${categoryId}`);
    // Still fetch categories for the informational table
    await fetchCategories(token, frameId);
  } else {
    categoryId = await fetchCategories(token, frameId);
    if (categoryId) {
      log(INFO, `Using first category from GET /categories: id=${categoryId}`);
    } else {
      log(INFO, 'No category id available — chore will be created as up_for_grabs.');
    }
  }

  try {
    // ── Leftover cleanup: delete any probe chores from previous failed runs ─
    // Re-uses the corrected one-time DELETE (no apply_to) so prior leftovers
    // (e.g. id=88586931 left by the earlier broken run) are removed automatically.
    log(INFO, 'Scanning existing chores for leftover probe chores from prior runs...');
    try {
      const existingData = await apiCall('GET', choresPath(frameId), token);
      const existingChores = existingData?.data ?? [];
      const leftovers = existingChores.filter(
        (c) => (c.attributes?.summary ?? '') === PROBE_CHORE_NAME
      );
      if (leftovers.length === 0) {
        log(INFO, '  No leftover probe chores found.');
      } else {
        log(INFO, `  Found ${leftovers.length} leftover probe chore(s) — cleaning up...`);
        for (const lc of leftovers) {
          const lcId = lc.id;
          const lcRecurring = lc.attributes?.recurring ?? false;
          // Use apply_to only for recurring chores (compound ID path)
          const deletePath = lcRecurring
            ? `/api/frames/${frameId}/chores/${lcId}?apply_to=this`
            : `/api/frames/${frameId}/chores/${lcId}`;
          log(INFO, `  DELETE id=${lcId} (recurring=${lcRecurring}): ${deletePath}`);
          try {
            await apiCall('DELETE', deletePath, token);
            log(INFO, `  [CLEANED] Deleted leftover probe chore id=${lcId}`);
          } catch (err) {
            log(WARN, `  Could not delete leftover id=${lcId}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      log(WARN, `  Could not scan for leftovers: ${err.message} — continuing.`);
    }

    // ── Create throwaway chore ──────────────────────────────────────────────
    log(INFO, `Creating throwaway chore: "${PROBE_CHORE_NAME}"...`);
    log(INFO, `  POST /api/frames/${frameId}/chores/create_multiple`);

    // The Skylight API requires EITHER category_ids OR up_for_grabs (API returns
    // 422 if neither is present). Source: rjhalvorson/skylight-mcp chores.ts —
    // when categoryId is provided, both category_id and category_ids are sent.
    const createBody = {
      summary: PROBE_CHORE_NAME,
      start: today,
      start_time: null,
      recurring: false,
      reward_points: null,
      emoji_icon: null,
    };

    if (categoryId !== null) {
      createBody.category_id = categoryId;
      createBody.category_ids = [categoryId];
      log(INFO, `  Assignment: category_id=${categoryId} (category_ids=[${categoryId}])`);
    } else {
      createBody.up_for_grabs = true;
      log(INFO, '  Assignment: up_for_grabs=true (no category available)');
    }

    const createResp = await apiCall(
      'POST',
      `/api/frames/${frameId}/chores/create_multiple`,
      token,
      createBody
    );

    const created = createResp?.data;
    if (!Array.isArray(created) || created.length === 0) {
      throw new Error(
        `Create response did not return expected data array. ` +
        `Got: ${JSON.stringify(createResp).slice(0, 200)}`
      );
    }

    choreId = created[0]?.id;
    if (!choreId) {
      throw new Error(`Create response missing chore id. data[0]: ${JSON.stringify(created[0])}`);
    }
    const initialStatus = created[0]?.attributes?.status ?? null;
    log(PASS, `Chore created. id=${choreId}, start=${today}, initial status="${initialStatus}"`);

    // ── Status update probe ─────────────────────────────────────────────────
    // COMPLETION MECHANISM (evidence-backed):
    //   PUT /api/frames/{frameId}/chores/{choreId}
    //   Body: FLAT JSON  { "status": "complete" }   ← NOT a JSON:API envelope
    //
    // Evidence sources:
    //   • TheEagleByte/skylight-api openapi.yaml (HAR-derived, real captures):
    //     PUT /api/frames/{id}/chores/{id1} request schema = flat object with
    //     { status: string }. Example capture: { "status": "pending" }.
    //     GET response enum: ["pending", "complete"] — "complete" not "completed".
    //   • rjhalvorson/skylight-mcp CHANGELOG v2.0.0: "Chore and reward API formats:
    //     creation now sends the flat JSON body shape the Skylight API expects."
    //     The update (PUT) path in that MCP was NOT fixed and still wraps in
    //     { data: { type:"chore", attributes:{...} } } — that is why the prior
    //     probe's PUT was a silent no-op: the server received an unrecognised
    //     envelope and returned 200 without touching the record.
    //   • Enumeration from GET responses: completed chores show
    //     attributes.status = "complete" AND attributes.completed_on = "YYYY-MM-DD"
    //     (server-populated). Pending chores: status:"pending", completed_on:null.
    //
    // INBOUND DETECTION (for Phase 2 polling bridge):
    //   Poll GET /api/frames/{frameId}/chores?after=YYYY-MM-DD&before=YYYY-MM-DD
    //   A chore completed on-device appears with BOTH:
    //     attributes.status === "complete"
    //     attributes.completed_on !== null  (YYYY-MM-DD string, the completion date)
    //   There is NO separate per-date occurrence array or /complete sub-resource —
    //   completion state lives directly on the chore resource's attributes.
    //
    // PRIMARY attempt: flat body { status: "complete" } (spec-confirmed value + format)
    // FALLBACK attempt: flat body { status: "completed" } (prior probe used this)
    // If BOTH no-op, we report honestly: mark-complete appears unsupported/needs-device.
    //
    // A candidate is confirmed ONLY when the server-side status value differs from the
    // initial status — guards against 2xx silent no-ops.
    const COMPLETION_VALUES = new Set(['completed', 'complete']);
    // Try "complete" first (OpenAPI spec enum value); "completed" as fallback.
    const candidates = ['complete', 'completed'];
    let updateSuccess = false;

    for (const candidate of candidates) {
      log(INFO, `\nTrying status string "${candidate}" (flat body)...`);
      log(INFO, `  PUT /api/frames/${frameId}/chores/${choreId}`);
      log(INFO, `  Body: { "status": "${candidate}" }  (flat JSON — not JSON:API envelope)`);

      let putResp;
      try {
        // PRIMARY FIX: send a FLAT body — NOT { data: { type, attributes: { status } } }
        // The prior probe wrapped in a JSON:API envelope which the Skylight API silently ignores.
        putResp = await apiCall(
          'PUT',
          `/api/frames/${frameId}/chores/${choreId}`,
          token,
          { status: candidate }
        );
      } catch (err) {
        log(WARN, `  PUT with "${candidate}" => ${err.message}`);
        if (err.status && err.status >= 500) {
          // Server error — something is badly wrong, stop trying
          throw err;
        }
        // 4xx — try next candidate
        continue;
      }

      // PUT succeeded (2xx) — prefer to read the status from the PUT response body
      // (spec says updateStatus returns the chore resource with server-normalized status).
      // Fall back to a list GET only if the PUT body doesn't contain the chore resource.
      let returnedStatus = putResp?.data?.attributes?.status ?? null;
      log(INFO, `  PUT HTTP 2xx — status in response body: ${returnedStatus !== null ? `"${returnedStatus}"` : '(not present)'}`);

      if (returnedStatus === null) {
        // PUT body didn't include the chore resource — fall back to list GET
        log(INFO, `  Falling back to GET /api/frames/${frameId}/chores to confirm...`);
        const getResp = await apiCall('GET', choresPath(frameId), token);
        const updatedChore = (getResp?.data ?? []).find((c) => String(c.id) === String(choreId));
        if (updatedChore) {
          returnedStatus = updatedChore.attributes?.status ?? null;
          const completedOn = updatedChore.attributes?.completed_on ?? null;
          log(INFO, `  GET returned status: "${returnedStatus}", completed_on: ${completedOn ?? 'null'}`);
        } else {
          // Chore not found in list — may have been filtered out after completion
          log(WARN, `  Chore id=${choreId} not found in GET listing after PUT`);
          log(WARN, `  (Completed chores may be filtered by the date window — treating as INCONCLUSIVE for "${candidate}")`);
          // Do NOT break or mark success; continue to next candidate
          continue;
        }
      }

      // Verify a genuine transition: status must be a recognized completion value
      // AND must differ from the initial status (guards against silent no-op).
      if (COMPLETION_VALUES.has(returnedStatus) && returnedStatus !== initialStatus) {
        confirmedStatusString = returnedStatus; // server's canonical form
        updateSuccess = true;
        log(PASS, `Status update CONFIRMED. Sent: "${candidate}", server returned: "${returnedStatus}"`);
        if (candidate !== returnedStatus) {
          log(INFO, `  NOTE: server normalized "${candidate}" => "${returnedStatus}". Use "${returnedStatus}" as canonical.`);
        }
        break;
      } else if (returnedStatus === initialStatus) {
        // 2xx but status is unchanged — server silently ignored the update
        log(WARN, `  PUT returned 2xx but status is still "${returnedStatus}" (unchanged from initial "${initialStatus}")`);
        log(WARN, `  "${candidate}" flat-body PUT appears to be a silent no-op — trying next candidate`);
        // Do NOT set updateSuccess; continue to next candidate
        continue;
      } else {
        // Status changed but to an unexpected value — record and report
        log(WARN, `  Server returned unexpected status: "${returnedStatus}" after PUT with "${candidate}"`);
        // Only treat as confirmed if the status actually changed from initial
        if (returnedStatus !== initialStatus) {
          confirmedStatusString = returnedStatus;
          updateSuccess = true;
          log(PASS, `Status changed from "${initialStatus}" to "${returnedStatus}" (unexpected value — record this for the design doc)`);
          break;
        } else {
          log(WARN, `  Status did not change — continuing`);
          continue;
        }
      }
    }

    if (!updateSuccess) {
      log(FAIL, 'Neither "complete" nor "completed" (flat body) was accepted by the server.');
      log(FAIL, 'CONCLUSION: mark-complete appears unsupported/needs-device via this API endpoint.');
      log(INFO, '  Both the flat-body format and the correct enum value were tried.');
      log(INFO, '  If this still no-ops, Skylight may require an on-device tap to mark completion,');
      log(INFO, '  or there may be an undiscovered per-occurrence endpoint not in the HAR captures.');
    } else {
      console.log('');
      log(INFO, '>>> PLEASE CHECK YOUR PHYSICAL SKYLIGHT DEVICE <<<');
      log(INFO, `    Look for a chore named "${PROBE_CHORE_NAME}"`);
      log(INFO, `    It should appear as completed/checked.`);
      log(INFO, `    If you see it and it's checked: two-way sync is CONFIRMED viable.`);
      log(INFO, `    If you see it unchecked: status update may have failed silently.`);
      log(INFO, `    If you don't see it at all: chore visibility may be filtered.`);
    }

    return { choreId, confirmedStatusString, updateSuccess };

  } finally {
    // ── Cleanup: always attempt DELETE ─────────────────────────────────────
    separator('CLEANUP');
    if (choreId) {
      // DELETE rule (from OpenAPI spec + live probe):
      //   One-time (non-recurring) chores: DELETE /api/frames/{frameId}/chores/{id}
      //     with NO apply_to query param. The {id1} path in the spec has no apply_to.
      //   Recurring occurrences: DELETE /api/frames/{frameId}/chores/{occurrenceId}
      //     where occurrenceId = "{templateId}-{YYYY-MM-DD}-{HHMM}" compound string,
      //     with ?apply_to=this|this_and_following|all.
      //   The prior probe sent ?apply_to=this on a one-time chore → 400
      //   "one-time chores should not have a value for apply_to". Fixed below.
      log(INFO, `Deleting throwaway chore id=${choreId}...`);
      log(INFO, `  DELETE /api/frames/${frameId}/chores/${choreId}  (no apply_to — one-time chore)`);
      try {
        await apiCall('DELETE', `/api/frames/${frameId}/chores/${choreId}`, token);
        log(PASS, `Cleanup succeeded. Chore id=${choreId} deleted. No litter on your device.`);
      } catch (err) {
        log(FAIL, `Cleanup FAILED: ${err.message}`);
        log(WARN, `MANUAL ACTION NEEDED: Delete the chore named "${PROBE_CHORE_NAME}" from your Skylight app.`);
      }
    } else {
      log(INFO, 'No chore was created — nothing to clean up.');
    }
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

function printSummary(results) {
  separator('FINAL SUMMARY');
  console.log('');

  const { authOk, readOk, writeResult } = results;

  if (!authOk) {
    log(FAIL, 'AUTH failed.');
    log(INFO, 'RECOMMENDATION: Option B (two-way sync) is DEAD on your account.');
    log(INFO, '                Stick with the ICS feed (one-way, read-only).');
    console.log('');
    return;
  }
  log(PASS, 'AUTH:  OK');

  if (!readOk) {
    log(FAIL, 'READ:  FAILED — could not list chores');
    log(INFO, 'RECOMMENDATION: Provide SKYLIGHT_FRAME_ID env var and re-run.');
    console.log('');
    return;
  }
  log(PASS, 'READ:  OK — chore listing works');

  if (!writeResult || !writeResult.updateSuccess) {
    log(FAIL, 'WRITE: FAILED — could not create/update chore');
    log(INFO, 'RECOMMENDATION: Two-way sync is technically possible (auth+read work) but');
    log(INFO, '                write/status-update does not. Investigate API changes.');
    console.log('');
    return;
  }

  log(PASS, `WRITE: OK — create + status update both work`);

  const statusStr = writeResult.confirmedStatusString;
  if (statusStr) {
    log(PASS, `STATUS STRING ANSWER: use "${statusStr}" in PUT data.attributes.status`);
  }

  console.log('');
  log(PASS, 'ALL EXPERIMENTS PASSED.');
  log(INFO, 'RECOMMENDATION: Two-way sync (Option B) IS viable on this account.');
  log(INFO, `                Use Authorization: Bearer <token> + Skylight-Api-Version: 2026-03-01`);
  log(INFO, `                Status string for completion: "${statusStr ?? 'completed'}"`);
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight API Validation Probe');
  console.log('============================================');
  console.log(`Email: ${EMAIL}`);
  console.log('Password: [REDACTED]');
  if (FRAME_ID_ENV) console.log(`Frame ID: ${FRAME_ID_ENV}`);
  console.log('');
  console.log('WARNING: This uses Skylight’s UNOFFICIAL reverse-engineered API.');
  console.log('         It may violate Skylight’s ToS §7.4. Personal use only.');
  console.log('');

  const results = { authOk: false, readOk: false, writeResult: null };
  let exitCode = 2;

  // Experiment 2a: auth
  let token;
  try {
    token = await doAuth();
    results.authOk = true;
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    console.log('');
    log(INFO, 'Option B (two-way) is DEAD on your account — stay on the ICS feed.');
    printSummary(results);
    process.exit(1);
  }

  // Experiment 2b: read
  let frameId;
  try {
    const readResult = await doRead(token);
    frameId = readResult.frameId;
    results.readOk = true;
  } catch (err) {
    log(FAIL, `Read failed: ${err.message}`);
    printSummary(results);
    process.exit(2);
  }

  // Experiment 3: write probe
  try {
    results.writeResult = await doWriteProbe(token, frameId);
    if (results.writeResult?.updateSuccess) {
      exitCode = 0;
    }
  } catch (err) {
    log(FAIL, `Write probe failed: ${err.message}`);
    // still print summary — auth+read may have passed
  }

  printSummary(results);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
