/**
 * Skylight HTTP client for the Sync Worker.
 *
 * SAFETY INVARIANTS (§9 of the design spec):
 *
 * 1. DRYRUN-at-client: every non-GET call checks env.DRYRUN first.
 *    When DRYRUN='true' (the default), the call short-circuits and returns a
 *    synthetic logged result. No other code path reaches Skylight for writes.
 *    Unit tests spy on globalThis.fetch to assert no non-GET call escapes.
 *
 * 2. Frame fingerprint assert: getFrame() compares name against the stored
 *    fingerprint string; callers must call assertFrameFingerprint() at startup.
 *
 * 3. Read-back verify: every mutating method (createChore, completeChore,
 *    deleteChore) returns a read-back result. Callers use getChoreById()
 *    for post-mutation confirmation.
 *
 * Auth: 5-step PKCE flow from scripts/skylight-probe.mjs (copied verbatim).
 * Token storage: caller provides a TokenStore interface (backed by KV in prod).
 */

import type {
  ChoreResource,
  SingleChoreResponse,
  ChoreListResponse,
  CreateChoreResponse,
  SingleFrameResponse,
  FrameResource,
  ListResource,
  ListsResponse,
  CreateListResponse,
  ListItemResource,
  CreateListItemResponse,
  SingleListResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants (proven values from skylight-probe.mjs)
// ---------------------------------------------------------------------------

export const SKYLIGHT_BASE = 'https://app.ourskylight.com';
const REDIRECT_URI = 'https://ourskylight.com/welcome';
const CLIENT_ID = 'skylight-mobile';
const SCOPE = 'everything';

const COMMON_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Referer: 'https://ourskylight.com/',
};

const API_HEADERS_BASE: Record<string, string> = {
  'User-Agent': 'SkylightMobile (web)',
  Accept: 'application/json',
  'Skylight-Api-Version': '2026-03-01',
};

// ---------------------------------------------------------------------------
// DRYRUN result sentinel
// ---------------------------------------------------------------------------

export const DRYRUN_SYNTHETIC_ID = 'DRYRUN-SYNTHETIC-ID';

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/**
 * Return a YYYY-MM-DD string offset by `days` from `date` (YYYY-MM-DD).
 * Uses UTC arithmetic so there is no DST ambiguity.
 */
function isoDateOffset(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`); // noon UTC avoids midnight DST edge
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// TokenStore interface (production: KV; tests: in-memory)
// ---------------------------------------------------------------------------

export interface TokenStore {
  getToken(): Promise<string | null>;
  setToken(token: string, expiresInSeconds: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SkylightApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string
  ) {
    super(message);
    this.name = 'SkylightApiError';
  }
}

export class FrameGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameGuardError';
  }
}

export class DryrRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DryRunError';
  }
}

export class ListWriteGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ListWriteGuardError';
  }
}

// ---------------------------------------------------------------------------
// Phase 2c: List safety constants
// ---------------------------------------------------------------------------

/**
 * The name of the dedicated bridge-owned list.
 * The worker may ONLY write list_items to this list.
 */
export const BRIDGE_LIST_LABEL = '▸ FairPlay';

/**
 * The family's REAL list ids that the worker must NEVER write to.
 * These are the real frame's shopping + to_do lists.
 */
export const FAMILY_LIST_IDS = new Set(['6454862', '6454863']);

/**
 * Fallback color to use when creating the bridge list if no other list
 * color is available. Must be a valid Skylight palette hex value.
 */
export const BRIDGE_LIST_FALLBACK_COLOR = '#B6E085';

/**
 * DRYRUN synthetic list id used when DRYRUN=true and ensureFairPlayList is called.
 */
export const DRYRUN_SYNTHETIC_LIST_ID = 'DRYRUN-SYNTHETIC-LIST-ID';

/**
 * Assert that a list write targets the bridge-owned list, not a family list.
 * Throws ListWriteGuardError on violation — call before EVERY list_item write.
 */
export function assertBridgeListWrite(targetListId: string, bridgeListId: string): void {
  if (FAMILY_LIST_IDS.has(targetListId)) {
    throw new ListWriteGuardError(
      `SAFETY: refusing write to family list id=${targetListId}. ` +
        `Only the bridge list (id=${bridgeListId}) may be written.`
    );
  }
  if (targetListId !== bridgeListId) {
    throw new ListWriteGuardError(
      `SAFETY: refusing write to list id=${targetListId}. ` +
        `Expected bridge list id=${bridgeListId}. Id-map guard violation.`
    );
  }
}

// ---------------------------------------------------------------------------
// PKCE helpers (verbatim from scripts/skylight-probe.mjs)
// ---------------------------------------------------------------------------

function generateVerifier(): string {
  const uuid1 = crypto.randomUUID().replace(/-/g, '');
  const uuid2 = crypto.randomUUID().replace(/-/g, '');
  return uuid1 + uuid2; // 64 hex chars
}

function base64url(bytes: Uint8Array): string {
  const binaryStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binaryStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function computeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64url(new Uint8Array(digest));
}

function generateState(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Cookie jar (verbatim from scripts/skylight-probe.mjs)
// ---------------------------------------------------------------------------

class CookieJar {
  private store = new Map<string, string>();

  ingest(headers: Headers): void {
    const setCookieValues: string[] = [];
    if (typeof (headers as unknown as { getSetCookie(): string[] }).getSetCookie === 'function') {
      setCookieValues.push(
        ...(headers as unknown as { getSetCookie(): string[] }).getSetCookie()
      );
    } else {
      const v = headers.get('set-cookie');
      if (v) setCookieValues.push(v);
    }
    for (const raw of setCookieValues) {
      const part = raw.split(';')[0].trim();
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      this.store.set(name, value);
    }
  }

  header(): string {
    return [...this.store.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Low-level fetch helpers
// ---------------------------------------------------------------------------

async function rawFetch(
  url: string,
  opts: RequestInit,
  jar?: CookieJar
): Promise<{ res: Response; body: string }> {
  const res = await fetch(url, { ...opts, redirect: 'manual' });
  if (jar) jar.ingest(res.headers);
  const body = await res.text().catch(() => '');
  return { res, body };
}

// ---------------------------------------------------------------------------
// PKCE Auth — 5-step flow (verbatim from scripts/skylight-probe.mjs)
// ---------------------------------------------------------------------------

export async function pkceAuth(email: string, password: string): Promise<string> {
  const jar = new CookieJar();
  const verifier = generateVerifier();
  const challenge = await computeChallenge(verifier);
  const state = generateState();

  // Step 1: initiate OAuth
  const authorizeUrl =
    `${SKYLIGHT_BASE}/oauth/authorize` +
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

  const loginFormUrl = r1.headers.get('location');
  if (!loginFormUrl && !b1.includes('authenticity_token')) {
    throw new SkylightApiError(
      `PKCE step 1 failed: HTTP ${r1.status}, no redirect and no form`,
      r1.status
    );
  }

  // Step 2: load login form
  const formUrl = loginFormUrl ?? authorizeUrl;
  const { res: r2, body: formHtml } = await rawFetch(
    formUrl,
    { headers: { ...COMMON_HEADERS, Cookie: jar.header() } },
    jar
  );

  const tokenMatch =
    formHtml.match(/name=["']authenticity_token["'][^>]*value=["']([^"']+)["']/i) ??
    formHtml.match(/value=["']([^"']+)["'][^>]*name=["']authenticity_token["']/i);

  if (!tokenMatch) {
    throw new SkylightApiError(
      `PKCE step 2 failed: no authenticity_token. HTTP ${r2.status}`,
      r2.status
    );
  }
  const authenticityToken = tokenMatch[1];

  // Step 3: POST credentials
  const formBody = new URLSearchParams({
    authenticity_token: authenticityToken,
    email,
    password,
  });

  const { res: r3 } = await rawFetch(
    `${SKYLIGHT_BASE}/auth/session`,
    {
      method: 'POST',
      headers: {
        ...COMMON_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: SKYLIGHT_BASE,
        Referer: `${SKYLIGHT_BASE}/auth/session/new`,
        Cookie: jar.header(),
      },
      body: formBody.toString(),
    },
    jar
  );

  if (r3.status !== 302 && r3.status !== 301) {
    throw new SkylightApiError(
      `PKCE step 3 failed: expected 302, got ${r3.status}. Check credentials.`,
      r3.status
    );
  }
  const oauthRedirectUrl = r3.headers.get('location');
  if (!oauthRedirectUrl) {
    throw new SkylightApiError('PKCE step 3 failed: no Location header', r3.status);
  }

  // Step 4: follow /oauth/authorize for auth code
  const step4Url = oauthRedirectUrl.startsWith('/')
    ? `${SKYLIGHT_BASE}${oauthRedirectUrl}`
    : oauthRedirectUrl;

  const { res: r4 } = await rawFetch(
    step4Url,
    { headers: { ...COMMON_HEADERS, Cookie: jar.header() } },
    jar
  );

  const codeRedirect = r4.headers.get('location');
  if (!codeRedirect) {
    throw new SkylightApiError(
      `PKCE step 4 failed: HTTP ${r4.status}, no Location`,
      r4.status
    );
  }

  let codeUrl: URL;
  try {
    codeUrl = new URL(
      codeRedirect.startsWith('/') ? `${SKYLIGHT_BASE}${codeRedirect}` : codeRedirect
    );
  } catch {
    throw new SkylightApiError(
      `PKCE step 4: could not parse redirect URL: ${codeRedirect}`,
      r4.status
    );
  }

  const authCode = codeUrl.searchParams.get('code');
  const returnedState = codeUrl.searchParams.get('state');

  if (!authCode) {
    throw new SkylightApiError(
      `PKCE step 4: no "code" param in redirect: ${codeRedirect}`,
      r4.status
    );
  }
  if (returnedState !== state) {
    throw new SkylightApiError(
      `PKCE step 4: state mismatch! sent "${state}", got "${returnedState}". CSRF risk.`,
      r4.status
    );
  }

  // Step 5: exchange code for bearer token
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
    `${SKYLIGHT_BASE}/oauth/token`,
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
    }
  );

  if (!r5.ok) {
    throw new SkylightApiError(
      `PKCE step 5 failed: HTTP ${r5.status}. Body: ${tokenRaw.slice(0, 300)}`,
      r5.status
    );
  }

  let tokenJson: Record<string, unknown>;
  try {
    tokenJson = JSON.parse(tokenRaw) as Record<string, unknown>;
  } catch {
    throw new SkylightApiError(
      `PKCE step 5: response not JSON. Body: ${tokenRaw.slice(0, 200)}`,
      r5.status
    );
  }

  const bearerToken =
    (tokenJson['access_token'] as string | undefined) ??
    (tokenJson['token'] as string | undefined);

  if (!bearerToken) {
    throw new SkylightApiError(
      `PKCE step 5: no access_token in response. Keys: ${Object.keys(tokenJson).join(', ')}`,
      r5.status
    );
  }

  return bearerToken;
}

// ---------------------------------------------------------------------------
// SkylightClient class
// ---------------------------------------------------------------------------

export interface SkylightClientOptions {
  frameId: string;
  dryrun: boolean;
  token: string;
}

export class SkylightClient {
  private readonly frameId: string;
  private readonly dryrun: boolean;
  private token: string;

  constructor(opts: SkylightClientOptions) {
    this.frameId = opts.frameId;
    this.dryrun = opts.dryrun;
    this.token = opts.token;
  }

  /** Update the bearer token (after re-auth). */
  updateToken(token: string): void {
    this.token = token;
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private apiHeaders(): Record<string, string> {
    return {
      ...API_HEADERS_BASE,
      Authorization: `Bearer ${this.token}`,
    };
  }

  /**
   * DRYRUN gate: call at the top of every non-GET method.
   * Logs the would-be call and returns a sentinel result.
   * Throws DryrRunError (which callers catch to return early).
   */
  private assertNotDryrun(method: string, path: string): void {
    if (this.dryrun) {
      console.log(
        `[skylight-client] DRYRUN: would ${method} ${SKYLIGHT_BASE}${path}`
      );
      throw new DryrRunError(`DRYRUN: ${method} ${path} suppressed`);
    }
  }

  private async apiGet<T>(path: string): Promise<T> {
    const url = `${SKYLIGHT_BASE}${path}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: this.apiHeaders(),
    });
    if (res.status === 401) {
      throw new SkylightApiError(`Skylight 401: ${path}`, 401);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SkylightApiError(
        `GET ${path} => ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        body
      );
    }
    return res.json() as Promise<T>;
  }

  private async apiMutate<T>(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown
  ): Promise<T | null> {
    // DRYRUN guard — MUST be first thing in every non-GET
    this.assertNotDryrun(method, path);

    const url = `${SKYLIGHT_BASE}${path}`;
    const headers: Record<string, string> = { ...this.apiHeaders() };
    const opts: RequestInit = { method, headers };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }

    const res = await fetch(url, opts);

    if (res.status === 401) {
      throw new SkylightApiError(`Skylight 401: ${method} ${path}`, 401);
    }
    if (res.status === 429) {
      throw new SkylightApiError(`Skylight 429: ${method} ${path}`, 429);
    }
    if (res.status === 204 || res.status === 200) {
      // DELETE often returns 204 with no body
      const text = await res.text().catch(() => '');
      if (!text) return null;
      try {
        return JSON.parse(text) as T;
      } catch {
        return null;
      }
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new SkylightApiError(
        `${method} ${path} => ${res.status}: ${body.slice(0, 300)}`,
        res.status,
        body
      );
    }
    return res.json() as Promise<T>;
  }

  // ── Frame ──────────────────────────────────────────────────────────────────

  /**
   * GET /api/frames/{frameId} and return the resource.
   * This is a GET, so it always runs regardless of DRYRUN.
   */
  async getFrame(): Promise<FrameResource> {
    const resp = await this.apiGet<SingleFrameResponse>(`/api/frames/${this.frameId}`);
    return resp.data;
  }

  /**
   * Assert the frame name matches the expected fingerprint string.
   * Throws FrameGuardError on mismatch — callers must hard-abort.
   *
   * @param expectedFingerprint - e.g. '5356033:heutoncal'
   */
  async assertFrameFingerprint(expectedFingerprint: string): Promise<void> {
    const frame = await this.getFrame();
    const [, expectedName] = expectedFingerprint.split(':');
    const actualName = frame.attributes.name ?? '';
    if (actualName !== expectedName) {
      throw new FrameGuardError(
        `Frame fingerprint mismatch! ` +
          `Expected name "${expectedName}" for frame ${this.frameId}, ` +
          `but got "${actualName}". Refusing to proceed.`
      );
    }
  }

  // ── Chores — reads (always run, even in DRYRUN) ───────────────────────────

  /**
   * GET /api/frames/{frameId}/chores?after=...&before=...
   * after and before are YYYY-MM-DD strings.
   */
  async listChores(after: string, before: string): Promise<ChoreResource[]> {
    const qs = new URLSearchParams({
      after,
      before,
      include_late: 'true',
      // profile-assigned chores only appear with this filter (see getChoreById).
      filter: 'linked_to_profile',
    });
    const resp = await this.apiGet<ChoreListResponse>(
      `/api/frames/${this.frameId}/chores?${qs}`
    );
    return resp.data ?? [];
  }

  /**
   * Fetch a single chore by id via the LIST endpoint (the by-id GET endpoint
   * does not exist on the live API — it always returns 404).
   *
   * Queries a ±1-day window around `date` with include_late=true and
   * include_up_for_grabs=true to guarantee the chore is visible regardless of
   * category assignment. Finds the chore by exact id in the response array.
   *
   * Returns the ChoreResource if found, or null if genuinely absent.
   * Never throws a 404-shaped error — genuine absence returns null.
   *
   * @param choreId - The Skylight chore id to look up.
   * @param date    - The chore's occurrence date (YYYY-MM-DD). Used to build
   *                  the date window for the list query.
   */
  async getChoreById(choreId: string, date: string): Promise<ChoreResource | null> {
    const after = isoDateOffset(date, -1);
    const before = isoDateOffset(date, 1);
    const qs = new URLSearchParams({
      after,
      before,
      include_late: 'true',
      include_up_for_grabs: 'true',
      // REQUIRED: profile-assigned chores are only returned by the list when this
      // filter is present. Confirmed empirically on the live frame — a windowed
      // query WITHOUT it returns ~1/18 of our (category-assigned) chores, WITH it
      // returns 18/18. We always assign a category, so this never hides our chores.
      filter: 'linked_to_profile',
    });
    const resp = await this.apiGet<ChoreListResponse>(
      `/api/frames/${this.frameId}/chores?${qs}`
    );
    const list = resp.data ?? [];
    return list.find((c) => c.id === choreId) ?? null;
  }

  // ── Chores — writes (gated by DRYRUN) ─────────────────────────────────────

  /**
   * POST /api/frames/{frameId}/chores/create_multiple
   *
   * Safety: creates exactly ONE chore per call (design §9).
   * Asserts data.length === 1 and that the returned description matches
   * the expected ownership marker "FPSYNC|<todoistId>" (clean-title scheme).
   *
   * The summary is the CLEAN task content (no visible sentinel).
   * Ownership is verified via attributes.description, not the summary.
   *
   * Returns the created ChoreResource on success.
   * Throws on DRYRUN — callers catch DryrRunError and treat as synthetic success.
   */
  async createChore(opts: {
    summary: string;
    start: string;             // YYYY-MM-DD
    categoryId: string | null;
    idemToken: string;         // kept for legacy compatibility; description marker is the real guard
    description?: string;      // ownership marker "FPSYNC|<todoistId>" — verified on read-back
  }): Promise<ChoreResource> {
    const path = `/api/frames/${this.frameId}/chores/create_multiple`;

    // DRYRUN gate (throws DryrRunError)
    this.assertNotDryrun('POST', path);

    const body: Record<string, unknown> = {
      summary: opts.summary,
      start: opts.start,
      start_time: null,
      recurring: false,
      reward_points: null,
      emoji_icon: null,
    };

    // Include ownership marker in description if provided
    if (opts.description !== undefined) {
      body['description'] = opts.description;
    }

    if (opts.categoryId !== null) {
      body['category_id'] = opts.categoryId;
      body['category_ids'] = [opts.categoryId];
    } else {
      body['up_for_grabs'] = true;
    }

    const resp = await this.apiMutate<CreateChoreResponse>('POST', path, body);

    if (!resp || !Array.isArray(resp.data)) {
      throw new SkylightApiError(
        `createChore: unexpected response shape: ${JSON.stringify(resp).slice(0, 200)}`,
        0
      );
    }

    // §9 Safety: assert exactly one chore was created
    if (resp.data.length !== 1) {
      throw new SkylightApiError(
        `createChore: expected data.length===1, got ${resp.data.length}. ` +
          `Possible duplicate. Manual review required.`,
        0
      );
    }

    const created = resp.data[0];

    // §9 Safety: if a description marker was provided, verify it round-tripped.
    // This is the primary ownership check in the clean-title scheme.
    if (opts.description !== undefined) {
      if (!descriptionMatchesMarker(created.attributes.description, opts.description)) {
        throw new SkylightApiError(
          `createChore: returned description "${created.attributes.description}" does not match ` +
            `expected marker "${opts.description}". Marking needs_review.`,
          0
        );
      }
    } else {
      // Legacy path: fall back to idemToken-in-summary check
      if (!created.attributes.summary.includes(opts.idemToken)) {
        throw new SkylightApiError(
          `createChore: returned summary does not contain idemToken "${opts.idemToken}". ` +
            `Got: "${created.attributes.summary}". Marking needs_review.`,
          0
        );
      }
    }

    return created;
  }

  /**
   * PUT /api/frames/{frameId}/chores/{choreId} with { status: "complete" }
   *
   * Flat body — NOT a JSON:API envelope. Proven shape from skylight-probe.mjs.
   * Throws on DRYRUN.
   */
  async completeChore(choreId: string): Promise<void> {
    const path = `/api/frames/${this.frameId}/chores/${choreId}`;
    // DRYRUN gate (throws DryrRunError)
    this.assertNotDryrun('PUT', path);
    await this.apiMutate<unknown>('PUT', path, { status: 'complete' });
  }

  /**
   * DELETE /api/frames/{frameId}/chores/{choreId}
   *
   * One-time delete — NO apply_to param (§9: never apply_to=all).
   * Proven correct shape from skylight-probe.mjs.
   * Throws on DRYRUN.
   */
  async deleteChore(choreId: string): Promise<void> {
    const path = `/api/frames/${this.frameId}/chores/${choreId}`;
    // DRYRUN gate (throws DryrRunError)
    this.assertNotDryrun('DELETE', path);
    await this.apiMutate<unknown>('DELETE', path);
  }

  // ── Read-back verify helpers ───────────────────────────────────────────────

  /**
   * After completeChore, verify the status actually flipped.
   * Throws if the chore is not found or status is not 'complete'.
   *
   * @param choreId - The Skylight chore id.
   * @param date    - The chore's occurrence date (YYYY-MM-DD) for the list window.
   */
  async verifyCompleted(choreId: string, date: string): Promise<ChoreResource> {
    const chore = await this.getChoreById(choreId, date);
    if (!chore) {
      throw new SkylightApiError(
        `verifyCompleted: chore ${choreId} not found after PUT complete`,
        404
      );
    }
    if (chore.attributes.status !== 'complete') {
      throw new SkylightApiError(
        `verifyCompleted: chore ${choreId} status is "${chore.attributes.status}" ` +
          `after PUT complete (silent no-op?)`,
        0
      );
    }
    return chore;
  }

  /**
   * After deleteChore, verify the chore is gone (absent from the list).
   * Throws if the chore still exists.
   *
   * @param choreId - The Skylight chore id.
   * @param date    - The chore's occurrence date (YYYY-MM-DD) for the list window.
   */
  async verifyDeleted(choreId: string, date: string): Promise<void> {
    const chore = await this.getChoreById(choreId, date);
    if (chore !== null) {
      throw new SkylightApiError(
        `verifyDeleted: chore ${choreId} still exists after DELETE (status=${chore.attributes.status})`,
        0
      );
    }
  }

  // ── Lists (phase 2c) ───────────────────────────────────────────────────────

  /**
   * GET /api/frames/{frameId}/lists
   * Returns all lists for this frame. Always runs, even in DRYRUN.
   */
  async getLists(): Promise<ListResource[]> {
    const resp = await this.apiGet<ListsResponse>(`/api/frames/${this.frameId}/lists`);
    return resp.data ?? [];
  }

  /**
   * GET /api/frames/{frameId}/lists/{listId}
   * Returns the list with its items in included[].
   * Returns null on 404.
   */
  async getList(listId: string): Promise<SingleListResponse | null> {
    try {
      return await this.apiGet<SingleListResponse>(`/api/frames/${this.frameId}/lists/${listId}`);
    } catch (err) {
      if (err instanceof SkylightApiError && err.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /**
   * POST /api/frames/{frameId}/lists
   * Creates a new list. Returns the created list resource.
   * SAFETY: only called from ensureFairPlayList; gated by DRYRUN.
   */
  async createList(opts: { label: string; color: string }): Promise<ListResource> {
    const path = `/api/frames/${this.frameId}/lists`;
    this.assertNotDryrun('POST', path);
    const resp = await this.apiMutate<CreateListResponse>('POST', path, {
      label: opts.label,
      kind: 'to_do',
      color: opts.color,
    });
    if (!resp?.data) {
      throw new SkylightApiError(`createList: unexpected response shape`, 0);
    }
    return resp.data;
  }

  /**
   * DELETE /api/frames/{frameId}/lists/{listId}
   * Deletes the entire list. Only used for cleanup in tests / teardown.
   * Gated by DRYRUN.
   */
  async deleteList(listId: string): Promise<void> {
    const path = `/api/frames/${this.frameId}/lists/${listId}`;
    this.assertNotDryrun('DELETE', path);
    await this.apiMutate<unknown>('DELETE', path);
  }

  /**
   * POST /api/frames/{frameId}/lists/{listId}/list_items
   * Creates a list item. Returns the created item resource.
   * Gated by DRYRUN and list-ownership guard.
   * Throws ListWriteGuardError if listId != the bridge-owned list.
   */
  async createListItem(listId: string, label: string, bridgeListId: string): Promise<ListItemResource> {
    assertBridgeListWrite(listId, bridgeListId);
    const path = `/api/frames/${this.frameId}/lists/${listId}/list_items`;
    this.assertNotDryrun('POST', path);
    const resp = await this.apiMutate<CreateListItemResponse>('POST', path, {
      label,
      section: null,
    });
    if (!resp?.data) {
      throw new SkylightApiError(`createListItem: unexpected response shape`, 0);
    }
    return resp.data;
  }

  /**
   * PUT /api/frames/{frameId}/lists/{listId}/list_items/{itemId}
   * Completes a list item: {status:"completed"} — note "completed", NOT "complete".
   * Gated by DRYRUN and list-ownership guard.
   */
  async completeListItem(listId: string, itemId: string, bridgeListId: string): Promise<void> {
    assertBridgeListWrite(listId, bridgeListId);
    const path = `/api/frames/${this.frameId}/lists/${listId}/list_items/${itemId}`;
    this.assertNotDryrun('PUT', path);
    await this.apiMutate<unknown>('PUT', path, { status: 'completed' });
  }

  /**
   * DELETE /api/frames/{frameId}/lists/{listId}/list_items/{itemId}
   * Deletes a list item. Gated by DRYRUN and list-ownership guard.
   */
  async deleteListItem(listId: string, itemId: string, bridgeListId: string): Promise<void> {
    assertBridgeListWrite(listId, bridgeListId);
    const path = `/api/frames/${this.frameId}/lists/${listId}/list_items/${itemId}`;
    this.assertNotDryrun('DELETE', path);
    await this.apiMutate<unknown>('DELETE', path);
  }

  /**
   * GET /api/frames/{frameId}/lists/{listId} and return the included list_items.
   * Returns [] if the list is not found or has no items.
   */
  async getListItems(listId: string): Promise<ListItemResource[]> {
    const resp = await this.getList(listId);
    return resp?.included ?? [];
  }
}

// ---------------------------------------------------------------------------
// Phase 2c: ensureFairPlayList — get-or-create the dedicated bridge list
// ---------------------------------------------------------------------------

/** KV key for the bridge list id */
export const KV_FAIRPLAY_LIST_ID = 'fairplay_list_id';

/**
 * Ensure the "▸ FairPlay" bridge list exists on the frame.
 *
 * Algorithm:
 *   1. Check KV for a cached list id.
 *   2. If found, verify it's NOT a family list id (safety assert).
 *   3. If not found in KV, scan GET /lists for a list whose id matches the KV entry
 *      OR whose label == BRIDGE_LIST_LABEL — but ONLY match by id (never by label alone
 *      for write-routing; label is used only at creation/discovery time).
 *   4. If still not found, create it (POST /lists) with a color reused from existing
 *      lists (or the fallback), then assert the returned id is NOT a family list id.
 *   5. Cache the id in KV.
 *
 * DRYRUN: returns DRYRUN_SYNTHETIC_LIST_ID, caches it in KV, logs the would-be create.
 * Never writes to any family list.
 *
 * @param client   A live SkylightClient
 * @param kv       KV namespace for caching the list id
 * @param dryrun   Whether DRYRUN mode is active
 * @returns The bridge list id (or DRYRUN_SYNTHETIC_LIST_ID in DRYRUN mode)
 */
export async function ensureFairPlayList(
  client: SkylightClient,
  kv: KVNamespace,
  dryrun: boolean
): Promise<string> {
  // 1. Check KV cache
  const cached = await kv.get(KV_FAIRPLAY_LIST_ID);
  if (cached && cached !== DRYRUN_SYNTHETIC_LIST_ID) {
    // Safety: assert cached id is NOT a family list
    if (FAMILY_LIST_IDS.has(cached)) {
      throw new ListWriteGuardError(
        `ensureFairPlayList: SAFETY ABORT — KV cached list id=${cached} is a FAMILY LIST. ` +
          `Manual intervention required. Clear the KV key "${KV_FAIRPLAY_LIST_ID}".`
      );
    }
    return cached;
  }

  // 2. GET all lists, find the bridge list by label
  const allLists = await client.getLists();

  // Check for family list id collisions in the GET response (defensive)
  const bridgeList = allLists.find((l) => l.attributes.label === BRIDGE_LIST_LABEL);

  if (bridgeList) {
    // Assert it's not a family list
    if (FAMILY_LIST_IDS.has(bridgeList.id)) {
      throw new ListWriteGuardError(
        `ensureFairPlayList: SAFETY ABORT — found bridge list label but id=${bridgeList.id} is a FAMILY LIST. ` +
          `Manual investigation required.`
      );
    }
    // Cache and return
    await kv.put(KV_FAIRPLAY_LIST_ID, bridgeList.id);
    return bridgeList.id;
  }

  // 3. Need to create the bridge list
  if (dryrun) {
    console.log(
      `[skylight-client] DRYRUN: would create list "${BRIDGE_LIST_LABEL}" — returning synthetic id`
    );
    await kv.put(KV_FAIRPLAY_LIST_ID, DRYRUN_SYNTHETIC_LIST_ID);
    return DRYRUN_SYNTHETIC_LIST_ID;
  }

  // Pick a color from an existing list, or use the fallback
  const existingColor = allLists.find((l) => l.attributes.color)?.attributes.color;
  const color = existingColor ?? BRIDGE_LIST_FALLBACK_COLOR;

  const created = await client.createList({ label: BRIDGE_LIST_LABEL, color });

  // Safety: assert the newly-created id is NOT a family list
  if (FAMILY_LIST_IDS.has(created.id)) {
    throw new ListWriteGuardError(
      `ensureFairPlayList: SAFETY ABORT — newly created list id=${created.id} matches a FAMILY LIST id. ` +
        `This should be impossible. Manual investigation required.`
    );
  }

  // Cache and return
  await kv.put(KV_FAIRPLAY_LIST_ID, created.id);
  console.log(
    `[skylight-client] ensureFairPlayList: created bridge list id=${created.id} label="${BRIDGE_LIST_LABEL}"`
  );
  return created.id;
}

// ---------------------------------------------------------------------------
// Sentinel helpers (§9) — kept for backward-compat with existing tests
// ---------------------------------------------------------------------------

/** Unicode left-pointing triangle — zero-collision sentinel glyph */
export const SENTINEL_GLYPH = '▸'; // ▸

/**
 * Derive the short token embedded in a chore summary from a Todoist task id.
 * Uses the last 6 chars of the id for brevity while remaining stable.
 */
export function sentinelToken(todoistId: string): string {
  return todoistId.slice(-6);
}

/**
 * Build the full chore summary including the ▸ sentinel + short token.
 * Format: "<content> ▸<token>"
 * The sentinel is at the END so the family name reads naturally.
 *
 * @deprecated Use the clean-title scheme: summary = task content (no sentinel);
 * ownership marker goes in attributes.description via choreDescriptionMarker().
 * This function is retained for backward-compatibility with existing tests.
 */
export function buildSummary(content: string, todoistId: string): string {
  const token = sentinelToken(todoistId);
  return `${content} ${SENTINEL_GLYPH}${token}`;
}

/**
 * Check whether a summary string contains our expected sentinel.
 * Uses full stored string comparison — never prefix matching.
 */
export function summaryMatchesSentinel(
  actualSummary: string,
  expectedSummary: string
): boolean {
  return actualSummary === expectedSummary;
}

// ---------------------------------------------------------------------------
// Description-marker helpers (clean-title ownership scheme)
// ---------------------------------------------------------------------------

/**
 * Build the ownership marker stored in attributes.description for chores.
 * Format: "FPSYNC|<todoistId>"
 *
 * Deterministic from the Todoist task id — strong and low-collision.
 * Families never write "FPSYNC|..." so this is a reliable bridge-owned field.
 * Used instead of a visible sentinel in the summary so chore titles are CLEAN
 * on the kitchen display.
 */
export function choreDescriptionMarker(todoistId: string): string {
  return `FPSYNC|${todoistId}`;
}

/**
 * Check whether a live chore's attributes.description matches the expected
 * ownership marker for the given todoistId.
 *
 * Used in:
 *   - create-verify (§9): confirm description echoed back correctly
 *   - delete protocol: re-GET + confirm before any DELETE/complete
 *   - inbound DETACH guard: abort if description diverged
 */
export function descriptionMatchesMarker(
  liveDescription: string | null | undefined,
  expectedMarker: string
): boolean {
  return liveDescription === expectedMarker;
}
