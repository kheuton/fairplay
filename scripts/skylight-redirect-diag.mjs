/**
 * FAIRPLAY · Skylight Redirect Diagnostic
 * =========================================
 * PURPOSE
 *   Determines whether the Skylight unofficial API redirects each API call —
 *   the suspected cause of Cloudflare Workers burning ~2-3 subrequests per
 *   API call against the free-plan 50-subrequest cap (every followed redirect
 *   counts as a separate subrequest).
 *
 * WHAT IT PROBES
 *   For each representative Worker API call:
 *     (i)   GET  /api/frames/{frameId}/chores?...  (chore list)
 *     (ii)  POST /api/frames/{frameId}/chores/create_multiple  (create chore)
 *     (iii) GET  /api/frames/{frameId}/lists  (lists)
 *     (iv)  PUT  /api/frames/{frameId}/chores/{id}  (complete chore)
 *     (v)   GET  /api/frames/{frameId}/chores/{id}  (single-chore GET — expect 404)
 *     (vi)  DELETE /api/frames/{frameId}/chores/{id}  (delete chore)
 *
 *   For each call, logs:
 *     - REQUEST url (what we sent)
 *     - response.status (final HTTP status)
 *     - response.redirected (boolean — true if fetch followed at least one redirect)
 *     - response.url (final URL after any redirects)
 *     - [REDIRECT DETECTED] flag if requestUrl !== response.url OR response.redirected === true
 *
 *   Then repeats calls (i) and (ii) with redirect:'manual' to capture:
 *     - raw 3xx status
 *     - Location header (the canonical URL the server wants)
 *
 *   Also compares trailing-slash vs. no-slash on the chore-list path.
 *
 * SAFETY
 *   Uses ONLY test frame 5381689 ("thehd") and category 20976592 (Kyle, test).
 *   NEVER touches real frame 5356033.
 *   Cleans up all created chores in a finally block.
 *
 * USAGE
 *   SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" \
 *     node scripts/skylight-redirect-diag.mjs
 *
 * PRIVACY
 *   Password is read ONLY from process.env — never logged, never written to disk.
 */

// ─── Env / constants ──────────────────────────────────────────────────────────

const EMAIL    = process.env.SKYLIGHT_EMAIL;
const PASSWORD = process.env.SKYLIGHT_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('USAGE:');
  console.error(
    '  SKYLIGHT_EMAIL="you@example.com" SKYLIGHT_PASSWORD="yourpass" node scripts/skylight-redirect-diag.mjs'
  );
  process.exit(1);
}

const BASE       = 'https://app.ourskylight.com';
const FRAME_ID   = '5381689';   // TEST frame "thehd" — NEVER touch 5356033
const CATEGORY_ID = '20976592'; // Kyle, test category
const DIAG_DESC  = 'FPSYNC|diag-1';

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

// ─── Logging helpers ──────────────────────────────────────────────────────────

const INFO = '[INFO]';
const PASS = '[PASS]';
const FAIL = '[FAIL]';
const WARN = '[WARN]';
const REDIR = '[REDIRECT DETECTED]';

function log(level, msg) {
  console.log(`${level} ${msg}`);
}

function separator(title) {
  const line = '─'.repeat(70);
  console.log(`\n${line}`);
  if (title) console.log(`  ${title}`);
  console.log(line);
}

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

// ─── rawFetch (verbatim from skylight-probe.mjs) ─────────────────────────────

async function rawFetch(url, opts, jar) {
  const res = await fetch(url, { ...opts, redirect: 'manual' });
  if (jar) jar.ingest(res.headers);
  const body = await res.text().catch(() => '');
  return { res, body };
}

// ─── Auth (verbatim from skylight-probe.mjs) ─────────────────────────────────

async function doAuth() {
  separator('STEP 1 — OAuth Login (5-step PKCE)');

  const jar = new CookieJar();
  const verifier  = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state     = generateState();

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

  const authCode     = codeUrl.searchParams.get('code');
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

// ─── Redirect-probing fetch helpers ──────────────────────────────────────────

/**
 * Build API headers for authenticated calls.
 */
function apiHeaders(token, extra) {
  return {
    ...API_HEADERS_BASE,
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

/**
 * Perform a fetch with redirect:'follow' (same as the Worker) and log redirect info.
 * Returns { res, body, requestUrl, redirected, finalUrl }.
 *
 * @param {string} label  Short human label for this call (e.g. "(i) GET chores")
 * @param {string} url    Full request URL
 * @param {object} opts   fetch options (method, headers, body — NOT redirect)
 */
async function probeFetch(label, url, opts) {
  let res;
  let body = '';

  try {
    res = await fetch(url, { ...opts, redirect: 'follow' });
    body = await res.text().catch(() => '');
  } catch (err) {
    log(FAIL, `${label} — fetch threw: ${err.message}`);
    return null;
  }

  const redirected = res.redirected;     // boolean: true if at least one redirect was followed
  const finalUrl   = res.url;            // URL after all redirects (or original if none)
  const wasRedirected = redirected || (finalUrl && finalUrl !== url);

  log(INFO, `${label}`);
  log(INFO, `  REQUEST url  : ${url}`);
  log(INFO, `  response.status     : ${res.status}`);
  log(INFO, `  response.redirected : ${redirected}`);
  log(INFO, `  response.url        : ${finalUrl}`);

  if (wasRedirected) {
    log(REDIR, `  *** REDIRECT: ${url}`);
    log(REDIR, `            -> ${finalUrl}`);
  } else {
    log(PASS, `  No redirect detected.`);
  }

  if (!res.ok && res.status !== 404) {
    // 404 is expected for the single-chore GET probe; log non-2xx errors
    const snippet = body.slice(0, 300);
    log(WARN, `  Non-2xx response (${res.status}): ${snippet}`);
  }

  return { res, body, requestUrl: url, redirected, finalUrl };
}

/**
 * Perform a fetch with redirect:'manual' to capture the raw 3xx response and
 * Location header without following the redirect.
 *
 * @param {string} label  Short human label
 * @param {string} url    Full request URL
 * @param {object} opts   fetch options (method, headers, body — NOT redirect)
 */
async function manualRedirectFetch(label, url, opts) {
  let res;
  let body = '';

  try {
    res = await fetch(url, { ...opts, redirect: 'manual' });
    body = await res.text().catch(() => '');
  } catch (err) {
    log(FAIL, `${label} (manual) — fetch threw: ${err.message}`);
    return null;
  }

  const location = res.headers.get('location') ?? '(none)';

  log(INFO, `${label} [redirect:manual]`);
  log(INFO, `  REQUEST url    : ${url}`);
  log(INFO, `  raw status     : ${res.status}`);
  log(INFO, `  Location header: ${location}`);

  if (res.status >= 300 && res.status < 400) {
    log(REDIR, `  *** RAW 3xx: server IS redirecting to: ${location}`);
  } else if (res.status === 0) {
    log(WARN, '  status=0 — opaque redirect response (Node treated redirect:manual as opaque).');
    log(WARN, '  Relying on response.redirected / response.url signals from the follow:true probe above.');
  } else {
    log(PASS, `  No 3xx from server at this URL (status ${res.status}).`);
  }

  return { res, body, requestUrl: url, rawStatus: res.status, location };
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function choresQueryParams() {
  const now = new Date();
  const after  = new Date(now); after.setDate(after.getDate() - 7);
  const before = new Date(now); before.setDate(before.getDate() + 30);
  return new URLSearchParams({
    after:              isoDate(after),
    before:             isoDate(before),
    include_late:       'true',
    include_up_for_grabs: 'true',
    filter:             'linked_to_profile',
  });
}

// ─── Create diag chore ────────────────────────────────────────────────────────

async function createDiagChore(token) {
  const today = isoDate(new Date());
  const url   = `${BASE}/api/frames/${FRAME_ID}/chores/create_multiple`;
  const body  = {
    summary:      'FairPlay redirect diagnostic',
    start:        today,
    start_time:   null,
    recurring:    false,
    reward_points: null,
    emoji_icon:   null,
    category_id:  CATEGORY_ID,
    category_ids: [CATEGORY_ID],
    description:  DIAG_DESC,
  };

  const opts = {
    method:  'POST',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  };

  const result = await probeFetch('(ii) POST /api/frames/{frameId}/chores/create_multiple', url, opts);
  if (!result) throw new Error('Create chore probe returned null');

  let choreId = null;
  try {
    const json = JSON.parse(result.body);
    const created = json?.data;
    if (Array.isArray(created) && created.length > 0) {
      choreId = created[0]?.id ?? null;
    }
  } catch {
    // ignore parse errors — already logged status above
  }

  if (!choreId) {
    log(FAIL, `Create chore did not return a usable id. Body snippet: ${result.body.slice(0, 300)}`);
    throw new Error('Could not create diagnostic chore — cannot proceed with PUT/DELETE probes.');
  }

  log(PASS, `Diagnostic chore created. id=${choreId}`);
  return { choreId, probeResult: result };
}

// ─── Cleanup helpers ──────────────────────────────────────────────────────────

/**
 * DELETE a single chore by id.  Returns true on success, false on failure.
 * Does not throw.
 */
async function deleteChore(token, choreId) {
  const url = `${BASE}/api/frames/${FRAME_ID}/chores/${choreId}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: apiHeaders(token),
      redirect: 'follow',
    });
    if (res.ok || res.status === 404) {
      log(PASS, `DELETE id=${choreId} => HTTP ${res.status} (ok)`);
      return true;
    }
    const txt = await res.text().catch(() => '');
    log(FAIL, `DELETE id=${choreId} => HTTP ${res.status}: ${txt.slice(0, 200)}`);
    return false;
  } catch (err) {
    log(FAIL, `DELETE id=${choreId} threw: ${err.message}`);
    return false;
  }
}

/**
 * Safety-sweep: GET /chores (wide window) and DELETE any whose description
 * starts with "FPSYNC|diag".  Returns the count deleted.
 */
async function sweepDiagChores(token) {
  const now = new Date();
  const after  = new Date(now); after.setDate(after.getDate() - 14);
  const before = new Date(now); before.setDate(before.getDate() + 60);
  const qs = new URLSearchParams({
    after:  isoDate(after),
    before: isoDate(before),
    include_late: 'true',
    include_up_for_grabs: 'true',
  });
  const url = `${BASE}/api/frames/${FRAME_ID}/chores?${qs}`;

  let chores = [];
  try {
    const res = await fetch(url, { headers: apiHeaders(token), redirect: 'follow' });
    const text = await res.text().catch(() => '');
    const json = JSON.parse(text);
    chores = json?.data ?? [];
  } catch (err) {
    log(WARN, `Safety-sweep GET threw: ${err.message}`);
    return 0;
  }

  const diag = chores.filter((c) => {
    const desc = c?.attributes?.description ?? '';
    const summary = c?.attributes?.summary ?? '';
    return desc.startsWith('FPSYNC|diag') || summary === 'FairPlay redirect diagnostic';
  });

  if (diag.length === 0) {
    log(PASS, 'Safety sweep: no residual diag chores found.');
    return 0;
  }

  log(INFO, `Safety sweep: found ${diag.length} residual diag chore(s) — deleting...`);
  let deleted = 0;
  for (const c of diag) {
    const ok = await deleteChore(token, c.id);
    if (ok) deleted++;
  }
  return deleted;
}

// ─── Summary report ───────────────────────────────────────────────────────────

function printFinalSummary(probeResults, manualResults, trailingSlashResults) {
  separator('FINAL SUMMARY — Redirect Diagnostic');

  // Collect which calls redirected
  const redirected = [];
  const notRedirected = [];

  for (const r of probeResults) {
    if (!r) continue;
    if (r.redirected || (r.finalUrl && r.finalUrl !== r.requestUrl)) {
      redirected.push(r);
    } else {
      notRedirected.push(r);
    }
  }

  console.log('');
  console.log('(a) DOES THE API REDIRECT API CALLS?');
  console.log('');

  if (redirected.length === 0) {
    log(PASS, 'NO REDIRECTS DETECTED on any of the 6 representative API calls.');
    console.log('');
    console.log('    The ~2-3x subrequest multiplier is NOT caused by HTTP redirects.');
    console.log('    Next step: instrument the Worker itself to count subrequests per');
    console.log('    logical API call (e.g. log ctx.waitUntil counts, or add a');
    console.log('    subrequest counter around each fetch).');
  } else {
    log(FAIL, `REDIRECTS DETECTED on ${redirected.length} of the probed calls:`);
    for (const r of redirected) {
      console.log(`    ${r.requestUrl}`);
      console.log(`    -> ${r.finalUrl}`);
      console.log(`       (response.redirected=${r.redirected}, HTTP ${r.res?.status})`);
      console.log('');
    }
  }

  console.log('');
  console.log('(b) REDIRECT TARGET / CANONICAL URL PATTERN:');
  console.log('');

  if (manualResults.length === 0 && redirected.length === 0) {
    console.log('    N/A — no redirects observed.');
  } else {
    let anyManual3xx = false;
    for (const m of manualResults) {
      if (!m) continue;
      if (m.rawStatus >= 300 && m.rawStatus < 400) {
        anyManual3xx = true;
        console.log(`    ${m.requestUrl}`);
        console.log(`    -> Location: ${m.location}  (raw HTTP ${m.rawStatus})`);
        // Pattern analysis
        try {
          const reqU   = new URL(m.requestUrl);
          const locStr = m.location.startsWith('/')
            ? `${reqU.protocol}//${reqU.host}${m.location}`
            : m.location;
          const locU = new URL(locStr);
          const patterns = [];
          if (reqU.host !== locU.host) patterns.push(`host change: ${reqU.host} -> ${locU.host}`);
          if (reqU.protocol !== locU.protocol) patterns.push(`protocol change: ${reqU.protocol} -> ${locU.protocol}`);
          if (reqU.pathname !== locU.pathname) patterns.push(`path change: ${reqU.pathname} -> ${locU.pathname}`);
          if (reqU.search !== locU.search) patterns.push(`query change: ${reqU.search} -> ${locU.search}`);
          if (patterns.length > 0) {
            console.log(`    Pattern: ${patterns.join(', ')}`);
          } else {
            console.log('    Pattern: (URLs appear identical — possible query normalization)');
          }
        } catch {
          console.log('    (Could not parse Location for pattern analysis)');
        }
        console.log('');
      }
    }
    if (!anyManual3xx && redirected.length > 0) {
      console.log('    redirect:manual did not observe a 3xx — Node followed the redirect');
      console.log('    transparently. Canonical URL pattern from response.url:');
      for (const r of redirected) {
        if (r.requestUrl !== r.finalUrl) {
          console.log(`    ${r.requestUrl} -> ${r.finalUrl}`);
        }
      }
    }
    if (!anyManual3xx && redirected.length === 0) {
      console.log('    N/A — no redirects observed in either mode.');
    }
  }

  console.log('');
  console.log('(b.1) TRAILING-SLASH COMPARISON:');
  console.log('');
  if (trailingSlashResults.withSlash && trailingSlashResults.withoutSlash) {
    const ws  = trailingSlashResults.withSlash;
    const wos = trailingSlashResults.withoutSlash;
    const wsRedir  = ws.redirected  || (ws.finalUrl  && ws.finalUrl  !== ws.requestUrl);
    const wosRedir = wos.redirected || (wos.finalUrl && wos.finalUrl !== wos.requestUrl);
    console.log(`    WITHOUT trailing slash: redirected=${wosRedir}  finalUrl=${wos.finalUrl}`);
    console.log(`    WITH    trailing slash: redirected=${wsRedir}   finalUrl=${ws.finalUrl}`);
    if (!wsRedir && !wosRedir) {
      log(PASS, '    Neither trailing-slash nor no-slash variant triggers a redirect.');
    } else if (wsRedir && !wosRedir) {
      log(REDIR, '    Trailing slash causes a redirect; WITHOUT slash is the canonical form.');
    } else if (!wsRedir && wosRedir) {
      log(REDIR, '    No-trailing-slash causes a redirect; WITH slash is the canonical form.');
    } else {
      log(WARN, '    Both variants redirect — unusual. Check the finalUrl patterns above.');
    }
  } else {
    console.log('    (trailing-slash comparison could not be completed — see errors above)');
  }

  console.log('');
  console.log('(c) RECOMMENDATION:');
  console.log('');

  if (redirected.length === 0) {
    console.log('    No HTTP redirects found. The subrequest multiplier has a different cause.');
    console.log('    Investigate:');
    console.log('      1. Worker retry logic firing on transient errors');
    console.log('      2. Multiple independent fetch() calls per handler (e.g. auth + API call)');
    console.log('      3. Subrequest counting in Cloudflare that includes the auth token');
    console.log('         exchange itself (each PKCE step = 1 subrequest)');
    console.log('      4. Any middleware or fetch wrappers that make secondary calls');
    console.log('    Action: add per-fetch logging to the Worker to count subrequests.');
  } else {
    console.log('    To eliminate redirect overhead, update the Worker to call the');
    console.log('    CANONICAL URL directly (the response.url / Location target shown above).');
    console.log('    Each avoided redirect saves 1 subrequest (the redirect response itself');
    console.log('    plus the follow-up request both count against the 50-subrequest cap).');
    if (manualResults.some((m) => m && m.rawStatus >= 300 && m.rawStatus < 400 && m.location !== '(none)')) {
      const firstM = manualResults.find((m) => m && m.rawStatus >= 300 && m.rawStatus < 400 && m.location !== '(none)');
      console.log(`    Canonical base: ${firstM.location} (from Location header)`);
    }
  }

  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nFAIRPLAY · Skylight Redirect Diagnostic');
  console.log('=========================================');
  console.log(`Email:    ${EMAIL}`);
  console.log('Password: [REDACTED]');
  console.log(`Frame:    ${FRAME_ID} (TEST frame "thehd" — NOT 5356033)`);
  console.log(`Category: ${CATEGORY_ID} (Kyle, test)`);
  console.log('');
  console.log('WARNING: This uses Skylight\'s UNOFFICIAL reverse-engineered API.');
  console.log('         Personal use only on your own account.');
  console.log('');

  // ── Auth ──────────────────────────────────────────────────────────────────
  let token;
  try {
    token = await doAuth();
  } catch (err) {
    log(FAIL, `Auth failed: ${err.message}`);
    process.exit(1);
  }

  const qs         = choresQueryParams();
  const choresPath = `/api/frames/${FRAME_ID}/chores`; // no trailing slash
  const choresUrl  = `${BASE}${choresPath}?${qs}`;
  const listsUrl   = `${BASE}/api/frames/${FRAME_ID}/lists`;

  const probeResults   = [];   // {label, requestUrl, redirected, finalUrl, res}
  const manualResults  = [];   // {label, requestUrl, rawStatus, location}
  let   createdChoreId = null;

  // ── Section 2: follow-redirect probes for all 6 call types ───────────────
  separator('STEP 2 — redirect:follow probes (same as the Worker)');
  console.log('For each call: REQUEST url, response.status, response.redirected, response.url');
  console.log('');

  // (i) GET chores list
  {
    const r = await probeFetch(
      `(i) GET ${choresPath}?...`,
      choresUrl,
      { headers: apiHeaders(token) }
    );
    if (r) probeResults.push({ label: '(i) GET chores', ...r });
  }

  // (ii) POST create_multiple — capture created chore id for subsequent probes
  let choreId = null;
  try {
    const { choreId: cid, probeResult } = await createDiagChore(token);
    choreId        = cid;
    createdChoreId = cid;
    if (probeResult) probeResults.push({ label: '(ii) POST create_multiple', ...probeResult });
  } catch (err) {
    log(FAIL, `Create chore failed: ${err.message}`);
    log(WARN, 'Skipping PUT, single-chore GET, and DELETE probes (no chore id).');
  }

  // (iii) GET lists
  {
    const r = await probeFetch(
      '(iii) GET /api/frames/{frameId}/lists',
      listsUrl,
      { headers: apiHeaders(token) }
    );
    if (r) probeResults.push({ label: '(iii) GET lists', ...r });
  }

  // (iv) PUT complete chore
  if (choreId) {
    const putUrl = `${BASE}/api/frames/${FRAME_ID}/chores/${choreId}`;
    const r = await probeFetch(
      `(iv) PUT /api/frames/{frameId}/chores/${choreId}  body:{status:"complete"}`,
      putUrl,
      {
        method: 'PUT',
        headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'complete' }),
      }
    );
    if (r) probeResults.push({ label: '(iv) PUT complete', ...r });
  }

  // (v) GET single chore by id  — expect 404
  if (choreId) {
    const singleUrl = `${BASE}/api/frames/${FRAME_ID}/chores/${choreId}`;
    log(INFO, '');
    log(INFO, '(v) GET /api/frames/{frameId}/chores/{id}  (single-chore GET — we expect 404)');
    const r = await probeFetch(
      `(v) GET /api/frames/{frameId}/chores/${choreId}`,
      singleUrl,
      { headers: apiHeaders(token) }
    );
    if (r) {
      probeResults.push({ label: '(v) GET single chore', ...r });
      if (r.res?.status === 404) {
        log(INFO, '  (404 expected — single-chore GET endpoint may not exist)');
      }
    }
  }

  // (vi) DELETE chore
  if (choreId) {
    const deleteUrl = `${BASE}/api/frames/${FRAME_ID}/chores/${choreId}`;
    const r = await probeFetch(
      `(vi) DELETE /api/frames/{frameId}/chores/${choreId}`,
      deleteUrl,
      { method: 'DELETE', headers: apiHeaders(token) }
    );
    if (r) {
      probeResults.push({ label: '(vi) DELETE chore', ...r });
      if (r.res?.ok || r.res?.status === 404) {
        // Successfully deleted — clear so cleanup doesn't double-delete
        createdChoreId = null;
      }
    }
  }

  // ── Section 3: redirect:manual probes for calls (i) and (ii) ─────────────
  separator('STEP 3 — redirect:manual probes (capture raw 3xx + Location header)');
  console.log('');

  // (i) manual — chores list
  {
    const m = await manualRedirectFetch(
      '(i) GET chores [manual]',
      choresUrl,
      { headers: apiHeaders(token) }
    );
    if (m) manualResults.push({ label: '(i) GET chores', ...m });
  }

  // (ii) manual — create_multiple
  // We create a SECOND diag chore here just for the manual probe, then delete it immediately.
  {
    const today  = isoDate(new Date());
    const url    = `${BASE}/api/frames/${FRAME_ID}/chores/create_multiple`;
    const body   = {
      summary:       'FairPlay redirect diagnostic #2',
      start:         today,
      start_time:    null,
      recurring:     false,
      reward_points: null,
      emoji_icon:    null,
      category_id:   CATEGORY_ID,
      category_ids:  [CATEGORY_ID],
      description:   DIAG_DESC,
    };
    const opts = {
      method:  'POST',
      headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    };

    const m = await manualRedirectFetch('(ii) POST create_multiple [manual]', url, opts);
    if (m) manualResults.push({ label: '(ii) POST create_multiple', ...m });

    // If the manual probe got a 2xx (no redirect), capture the id and delete it
    if (m && m.rawStatus >= 200 && m.rawStatus < 300) {
      try {
        const json   = JSON.parse(m.body);
        const tmp2id = json?.data?.[0]?.id;
        if (tmp2id) {
          log(INFO, `  Manual probe created chore id=${tmp2id} — cleaning up immediately.`);
          await deleteChore(token, tmp2id);
        }
      } catch {
        // ignore — sweep will catch it
      }
    }
  }

  // ── Section 4: trailing-slash comparison on call (i) ─────────────────────
  separator('STEP 4 — Trailing-slash canonicalization test (call (i))');
  console.log('');

  const choresPathSlash = `/api/frames/${FRAME_ID}/chores/`; // WITH trailing slash
  const choresUrlSlash  = `${BASE}${choresPathSlash}?${qs}`;

  log(INFO, 'Testing WITHOUT trailing slash:');
  const noSlash = await probeFetch(
    `(i-noslash) GET ${choresPath}?...`,
    choresUrl,
    { headers: apiHeaders(token) }
  );

  log(INFO, '');
  log(INFO, 'Testing WITH trailing slash:');
  const withSlash = await probeFetch(
    `(i-slash)   GET ${choresPathSlash}?...`,
    choresUrlSlash,
    { headers: apiHeaders(token) }
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  separator('CLEANUP');

  // Delete the primary diag chore if the DELETE probe didn't already remove it
  if (createdChoreId) {
    log(INFO, `Deleting primary diag chore id=${createdChoreId} (DELETE probe may not have run)...`);
    await deleteChore(token, createdChoreId);
  } else {
    log(INFO, 'Primary diag chore already deleted by probe (vi) — skipping.');
  }

  // Safety sweep
  log(INFO, 'Running safety sweep for any residual FPSYNC|diag chores...');
  const swept = await sweepDiagChores(token);

  // Confirm sweep
  const now = new Date();
  const afterConf  = new Date(now); afterConf.setDate(afterConf.getDate() - 14);
  const beforeConf = new Date(now); beforeConf.setDate(beforeConf.getDate() + 60);
  const qsConf = new URLSearchParams({
    after:  isoDate(afterConf),
    before: isoDate(beforeConf),
    include_late: 'true',
    include_up_for_grabs: 'true',
  });
  try {
    const confirmRes  = await fetch(
      `${BASE}/api/frames/${FRAME_ID}/chores?${qsConf}`,
      { headers: apiHeaders(token), redirect: 'follow' }
    );
    const confirmText = await confirmRes.text().catch(() => '');
    const confirmJson = JSON.parse(confirmText);
    const remaining   = (confirmJson?.data ?? []).filter((c) => {
      const desc    = c?.attributes?.description ?? '';
      const summary = c?.attributes?.summary ?? '';
      return desc.startsWith('FPSYNC|diag') || summary.startsWith('FairPlay redirect diagnostic');
    });
    if (remaining.length === 0) {
      log(PASS, `Cleanup confirmed: 0 diag chores remain on frame ${FRAME_ID}.`);
    } else {
      log(FAIL, `Cleanup INCOMPLETE: ${remaining.length} diag chore(s) still present:`);
      for (const c of remaining) {
        log(FAIL, `  id=${c.id}  summary="${c?.attributes?.summary}"  desc="${c?.attributes?.description}"`);
      }
      log(WARN, 'Manual deletion needed — check Skylight app or re-run this script.');
    }
  } catch (err) {
    log(WARN, `Could not confirm cleanup: ${err.message}`);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  printFinalSummary(probeResults, manualResults, { withSlash, withoutSlash: noSlash });
}

main().catch((err) => {
  console.error('\nUNEXPECTED ERROR:', err.message);
  console.error(err.stack);
  process.exit(2);
});
