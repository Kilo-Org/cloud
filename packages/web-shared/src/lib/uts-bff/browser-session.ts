import 'server-only';
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  KILO_WEB_CLIENT_ID,
  UTS_AUTHORIZE_PATH,
  UTS_BROWSER_SESSION_READ_SCOPE,
  UTS_ENDPOINTS,
  firstPartyClient,
  type UtsEnvironment,
} from '@kilocode/uts-contracts';
import { z } from 'zod';
import type { User } from '@kilocode/db/schema';
import { db, readDb } from '@kilocode/web-shared/lib/drizzle';
import { getLowerDomainFromEmail } from '@kilocode/web-shared/lib/email-address';
import { getOrganizationById } from '@kilocode/web-shared/lib/organizations/organizations';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { isBlockedAccount } from '@kilocode/web-shared/lib/user/account-status';
import { isUserBlacklistedByDomain } from '@kilocode/web-shared/lib/user/domain-gates';
import {
  browserSessionCookieNames,
  browserSessionPepperBinding,
  cookieValues,
  utsBrowserSessionEnvironment,
  type BrowserSessionCookieNames,
} from '@kilocode/web-shared/lib/uts-bff/browser-session-config';
import {
  createKiloWebClient,
  type BrowserSession,
  type KiloWebClient,
  type KiloWebOutcome,
} from '@kilocode/web-shared/lib/uts-bff/kilo-web-client';
import { kiloWebSigningKeyProvider } from '@kilocode/web-shared/lib/uts-bff/kilo-web-key';

/**
 * The browser sign-in of the web BFF `kilo-web` (design 5.1, 5.4, 5.5): an OAuth 2.1 authorization
 * code request with PKCE S256 to the environment's UTS issuer, its callback on the fixed redirect
 * URI that `UTS_FIRST_PARTY_CLIENTS` registers, the session read and the session end.
 *
 * The pending sign-in lives only in a short HTTP-only transaction cookie; the browser session lives
 * in UTS, and the browser holds only an HTTP-only cookie with the opaque session handle and the
 * pepper binding (`browser-session-config.ts`). No token reaches the browser: the exchange's access
 * token is dropped. A browser holds one session family: an accepted sign-in retires its NextAuth
 * session cookies, and from then on its UTS cookie alone decides who it is. Every result here that
 * carries a `Set-Cookie` value or a handle is never logged; every other member is a code.
 */

/** Long enough for an emailed sign-in code (10 minutes, design 5.3). */
const TRANSACTION_LIFETIME_SECONDS = 600;
/** UTS moves the idle clock at most every 5 minutes; the BFF asks at most every 10. */
const TOUCH_AFTER_SECONDS = 10 * 60;
/** Design 5.3: a browser session lives 14 days idle. */
const IDLE_LIFETIME_SECONDS = 14 * 24 * 60 * 60;

const RandomValueSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const PepperBindingSchema = z.union([z.literal('none'), RandomValueSchema]);
/** A UTS authorization code is opaque; this bounds what the callback forwards. */
const CODE_PATTERN = /^[\x21-\x7e]{1,1024}$/;
const MAX_RETURN_PATH_LENGTH = 2048;
/**
 * One `/`, then unencoded RFC 3986 path characters not starting with `/`, then an optional query
 * whose every `%` starts a valid escape. A `%` in the path, a backslash, `//`, a fragment and
 * whitespace are refused rather than decoded, because browsers and servers decode them differently.
 */
const RETURN_PATH_PATTERN =
  /^\/(?:[\w\-.~!$&'()*+,;=:@][\w\-.~!$&'()*+,;=:@/]*)?(?:\?(?:[\w\-.~!$&'()*+,;=:@/?]|%[0-9A-Fa-f]{2})*)?$/;
const RETURN_PATH_BASE = 'https://return-path.invalid';
/**
 * The NextAuth session cookie and its chunks (`.0`, `.1`, …), under NextAuth's own default name:
 * `next-auth.session-token`, prefixed `__Secure-` where the app runs over HTTPS.
 */
const NEXTAUTH_SESSION_COOKIE = /^(?:__Secure-)?next-auth\.session-token(?:\.\d{1,2})?$/;

/**
 * `candidate` when it is a canonical page path on the app origin, else null. Dot segments and
 * `/api` paths in any case are refused: a GET that follows a sign-in must not reach an API route.
 */
export function safeReturnPath(candidate: string): string | null {
  if (candidate.length > MAX_RETURN_PATH_LENGTH || !RETURN_PATH_PATTERN.test(candidate)) {
    return null;
  }
  const queryStart = candidate.indexOf('?');
  const path = queryStart === -1 ? candidate : candidate.slice(0, queryStart);
  if (path.split('/').some(segment => segment === '.' || segment === '..')) return null;
  const lowerPath = path.toLowerCase();
  if (lowerPath === '/api' || lowerPath.startsWith('/api/')) return null;
  const url = new URL(candidate, RETURN_PATH_BASE);
  return url.origin === RETURN_PATH_BASE && url.pathname + url.search === candidate
    ? candidate
    : null;
}

/** Where this deployment's browser sessions live; null when they are off here. */
export type BrowserSessionSetup = {
  environment: UtsEnvironment;
  issuer: string;
  /** The one `kilo-web` redirect URI UTS registers for this environment. */
  redirectUri: string;
  /** The origin of `redirectUri`: the only origin that starts, completes and ends a sign-in. */
  appOrigin: string;
  cookies: BrowserSessionCookieNames;
  client: KiloWebClient;
};

export function browserSessionSetup(
  runtime: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl?: typeof fetch
): BrowserSessionSetup | null {
  const environment = utsBrowserSessionEnvironment(runtime);
  if (environment === null) return null;
  const registered = firstPartyClient(KILO_WEB_CLIENT_ID);
  if (registered?.kind !== 'confidential_web') return null;
  const [redirectUri, ...others] = registered.redirectUris[environment];
  if (redirectUri === undefined || others.length > 0) return null;
  const { issuer } = UTS_ENDPOINTS[environment];
  return {
    environment,
    issuer,
    redirectUri,
    appOrigin: new URL(redirectUri).origin,
    cookies: browserSessionCookieNames(environment),
    client: createKiloWebClient({
      issuer,
      signingKey: kiloWebSigningKeyProvider(environment, runtime),
      fetch: fetchImpl,
    }),
  };
}

/** `Lax` keeps the cookies on the top-level GET back from UTS, and off cross-site posts. */
function cookie(setup: BrowserSessionSetup, name: string, value: string, maxAge: number): string {
  const secure = setup.environment === 'development' ? '' : '; Secure';
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}

export function clearedCookie(setup: BrowserSessionSetup, name: string): string {
  return cookie(setup, name, '', 0);
}

/**
 * Expires every NextAuth session cookie the request carries, chunks included, with NextAuth's own
 * attributes (`Path=/`, HttpOnly, Lax, Secure under the `__Secure-` prefix), so the browser keeps
 * one session family. Only names the request sent are expired.
 */
export function retiredNextAuthSessionCookies(cookieHeader: string | null): string[] {
  const names = new Set<string>();
  for (const pair of (cookieHeader ?? '').split(';')) {
    const name = pair.slice(0, Math.max(pair.indexOf('='), 0)).trim();
    if (NEXTAUTH_SESSION_COOKIE.test(name)) names.add(name);
  }
  return [...names].map(name => {
    const secure = name.startsWith('__Secure-') ? '; Secure' : '';
    return `${name}=; Path=/; Max-Age=0; HttpOnly${secure}; SameSite=Lax`;
  });
}

const TransactionSchema = z.strictObject({
  v: z.literal(1),
  state: RandomValueSchema,
  verifier: RandomValueSchema,
  return_to: z.string(),
  exp: z.int().positive(),
});
type Transaction = z.infer<typeof TransactionSchema>;

function decodeTransaction(value: string): Transaction | null {
  if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const parsed = TransactionSchema.safeParse(json);
  return parsed.success && safeReturnPath(parsed.data.return_to) !== null ? parsed.data : null;
}

/** The session cookie: the UTS handle, then the pepper binding. */
type SessionCookie = { handle: string; binding: string };

function decodeSessionCookie(value: string): SessionCookie | null {
  const [handle, binding, ...rest] = value.split('.');
  if (rest.length > 0 || handle === undefined || binding === undefined) return null;
  if (!RandomValueSchema.safeParse(handle).success) return null;
  if (!PepperBindingSchema.safeParse(binding).success) return null;
  return { handle, binding };
}

/**
 * The request's session cookies. `none`: no cookie of that name. `invalid`: one malformed value,
 * or more than one value, which is ambiguous; neither names a session. `one`: a well-formed cookie.
 * `handles` lists every well-formed handle, for ending them all.
 */
type RequestSessionCookies =
  | { status: 'none' }
  | { status: 'invalid'; handles: string[] }
  | { status: 'one'; cookie: SessionCookie };

function requestSessionCookies(
  setup: BrowserSessionSetup,
  cookieHeader: string | null
): RequestSessionCookies {
  const values = cookieValues(cookieHeader, setup.cookies.session);
  if (values.length === 0) return { status: 'none' };
  const decoded = values.map(decodeSessionCookie);
  const [only] = decoded;
  if (decoded.length === 1 && only) return { status: 'one', cookie: only };
  return {
    status: 'invalid',
    handles: decoded.flatMap(value => (value === null ? [] : [value.handle])),
  };
}

function randomValue(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

function sameValue(received: string, expected: string): boolean {
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The one value of a query parameter; absent and repeated are both null. */
function single(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

/** Redirect to the UTS authorization endpoint with a new transaction cookie. */
export function startBrowserSignIn(
  setup: BrowserSessionSetup,
  returnTo: string | null
): { location: string; setCookie: string } {
  const transaction: Transaction = {
    v: 1,
    state: randomValue(),
    verifier: randomValue(),
    return_to: (returnTo === null ? null : safeReturnPath(returnTo)) ?? '/',
    exp: Math.floor(Date.now() / 1000) + TRANSACTION_LIFETIME_SECONDS,
  };
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: KILO_WEB_CLIENT_ID,
    redirect_uri: setup.redirectUri,
    scope: UTS_BROWSER_SESSION_READ_SCOPE,
    resource: setup.issuer,
    state: transaction.state,
    code_challenge: createHash('sha256').update(transaction.verifier).digest('base64url'),
    code_challenge_method: 'S256',
  });
  return {
    location: `${setup.issuer}${UTS_AUTHORIZE_PATH}?${query}`,
    setCookie: cookie(
      setup,
      setup.cookies.transaction,
      Buffer.from(JSON.stringify(transaction)).toString('base64url'),
      TRANSACTION_LIFETIME_SECONDS
    ),
  };
}

/**
 * The app's SSO policy for the account's primary email domain, checked against what UTS verified
 * for the session (design 5.8). The app's organizations stay the authority: a domain that requires
 * SSO admits a session only when UTS says it signed in through SSO (`amr` has `sso`) and the
 * WorkOS organization of that verified profile is the one bound (`organizations.external_org_id`)
 * to the organization the app says requires it. Gmail is exempt, as for a NextAuth sign-in.
 */
export type BrowserSessionSsoDecision =
  | { decision: 'admit'; ssoSourceOrganizationId?: string }
  | {
      decision: 'refuse';
      reason:
        | 'email_domain_invalid'
        | 'sso_misconfigured'
        | 'sso_required'
        | 'sso_organization_mismatch';
    };

export async function browserSessionSsoDecision(
  user: Pick<User, 'google_user_email'>,
  session: Pick<BrowserSession, 'amr' | 'sso_organization'>
): Promise<BrowserSessionSsoDecision> {
  const domain = getLowerDomainFromEmail(user.google_user_email);
  if (!domain) return { decision: 'refuse', reason: 'email_domain_invalid' };
  if (domain === 'gmail.com') return { decision: 'admit' };
  const authority = await resolveSsoAuthorityForDomain(domain);
  if (authority.status === 'misconfigured')
    return { decision: 'refuse', reason: 'sso_misconfigured' };
  if (authority.status === 'not_required') return { decision: 'admit' };
  if (!session.amr.includes('sso') || session.sso_organization === undefined) {
    return { decision: 'refuse', reason: 'sso_required' };
  }
  const organization = await getOrganizationById(authority.sourceOrganizationId);
  if (organization?.external_org_id !== session.sso_organization) {
    return { decision: 'refuse', reason: 'sso_organization_mismatch' };
  }
  return { decision: 'admit', ssoSourceOrganizationId: authority.sourceOrganizationId };
}

type Failure = Exclude<KiloWebOutcome<never>, { kind: 'ok' }>;

/**
 * `signed_in`: redirect to `location`. `retry`: the same callback URL can succeed later (UTS
 * answers a repeat of the exchange inside the code's 60 seconds with the same session and handle);
 * the transaction and the browser's cookies stay. `restart`: this callback cannot complete the
 * pending sign-in; a forged one (wrong `state` or `iss`) leaves the transaction in place. `failed`:
 * the sign-in is over. Only `signed_in` sets the session cookie and retires the NextAuth session
 * cookies, so a failed or retried sign-in never signs the browser out of the session it holds.
 */
export type BrowserCallbackOutcome =
  | { kind: 'signed_in'; location: string; userId: string; setCookies: string[] }
  | {
      kind: 'retry';
      reason: string;
      retryAfterSeconds: number | null;
      setCookies: string[];
    }
  | {
      kind: 'restart';
      reason:
        | 'no_transaction'
        | 'transaction_expired'
        | 'state_mismatch'
        | 'issuer_mismatch'
        | 'malformed_callback';
      setCookies: string[];
    }
  | {
      kind: 'failed';
      reason: 'authorization_refused' | 'exchange_failed' | 'account_refused';
      code: string | null;
      /** The refused account, when the app has one. */
      userId?: string;
      setCookies: string[];
    };

/** Whether the app lets the UTS subject hold a web session, and the pepper it binds to. */
export type BrowserSessionAdmission =
  | { decision: 'admit'; userId: string; pepper: string | null }
  | {
      decision: 'refuse';
      reason:
        | 'no_account'
        | 'account_blocked'
        | 'email_domain_blocked'
        | Extract<BrowserSessionSsoDecision, { decision: 'refuse' }>['reason'];
      userId?: string;
    };

/**
 * The app's own gates on the subject, as the NextAuth sign-in applies them: an app account with this
 * id (an account UTS created on its own, `uts_…`, has none yet), not blocked, not on a blacklisted
 * email domain, and the SSO policy of its domain. The row and its pepper come from the primary.
 */
async function admitSubject(session: BrowserSession): Promise<BrowserSessionAdmission> {
  const user = await findUserById(session.subject, db);
  if (!user) return { decision: 'refuse', reason: 'no_account' };
  if (isBlockedAccount(user)) {
    return { decision: 'refuse', reason: 'account_blocked', userId: user.id };
  }
  if (await isUserBlacklistedByDomain(user, readDb)) {
    return { decision: 'refuse', reason: 'email_domain_blocked', userId: user.id };
  }
  const sso = await browserSessionSsoDecision(user, session);
  if (sso.decision === 'refuse') return { decision: 'refuse', reason: sso.reason, userId: user.id };
  return { decision: 'admit', userId: user.id, pepper: user.web_session_pepper ?? null };
}

function failureCode(failure: Failure): string {
  if (failure.kind === 'invalid_session') return 'invalid_session';
  if (failure.kind === 'retryable') return failure.reason;
  return failure.error ?? failure.reason;
}

export async function completeBrowserSignIn(
  setup: BrowserSessionSetup,
  input: { requestUrl: string; cookieHeader: string | null },
  admit: (session: BrowserSession) => Promise<BrowserSessionAdmission> = admitSubject
): Promise<BrowserCallbackOutcome> {
  const clearTransaction = clearedCookie(setup, setup.cookies.transaction);
  const restart = (
    reason: Extract<BrowserCallbackOutcome, { kind: 'restart' }>['reason'],
    setCookies: string[] = []
  ): BrowserCallbackOutcome => ({ kind: 'restart', reason, setCookies });
  const retry = (reason: string, retryAfterSeconds: number | null): BrowserCallbackOutcome => ({
    kind: 'retry',
    reason,
    retryAfterSeconds,
    setCookies: [],
  });

  const stored = cookieValues(input.cookieHeader, setup.cookies.transaction);
  if (stored.length === 0) return restart('no_transaction');
  const transaction = stored.length === 1 ? decodeTransaction(stored[0]) : null;
  if (transaction === null) return restart('no_transaction', [clearTransaction]);
  if (transaction.exp <= Math.floor(Date.now() / 1000)) {
    return restart('transaction_expired', [clearTransaction]);
  }

  let params: URLSearchParams;
  try {
    const url = new URL(input.requestUrl);
    if (`${setup.appOrigin}${url.pathname}` !== setup.redirectUri) {
      return restart('malformed_callback');
    }
    params = url.searchParams;
  } catch {
    return restart('malformed_callback');
  }
  const state = single(params, 'state');
  if (state === null || !sameValue(state, transaction.state)) return restart('state_mismatch');
  // RFC 9207: the response names its issuer; any other issuer is a mix-up.
  if (single(params, 'iss') !== setup.issuer) return restart('issuer_mismatch');

  const error = single(params, 'error');
  const code = single(params, 'code');
  if (params.has('error') && !params.has('code')) {
    return {
      kind: 'failed',
      reason: 'authorization_refused',
      code: error !== null && /^[a-z_]{1,64}$/.test(error) ? error : 'unrecognized',
      setCookies: [clearTransaction],
    };
  }
  if (code === null || params.has('error') || !CODE_PATTERN.test(code)) {
    return restart('malformed_callback');
  }

  const exchange = await setup.client.exchangeCode({
    code,
    codeVerifier: transaction.verifier,
    redirectUri: setup.redirectUri,
  });
  if (exchange.kind === 'retryable') {
    return retry(exchange.reason, exchange.retryAfterSeconds);
  }
  if (exchange.kind !== 'ok') {
    return {
      kind: 'failed',
      reason: 'exchange_failed',
      code: failureCode(exchange),
      setCookies: [clearTransaction],
    };
  }
  const { handle, session } = exchange.value;

  let admission: BrowserSessionAdmission;
  try {
    admission = await admit(session);
  } catch {
    return retry('admission_unavailable', null);
  }
  if (admission.decision !== 'admit') {
    // The refused subject's new session ends at once; a repeat of an end changes nothing more.
    const ended = await setup.client.endSession(handle);
    if (ended.kind === 'retryable')
      return retry('session_end_unavailable', ended.retryAfterSeconds);
    return {
      kind: 'failed',
      reason: 'account_refused',
      code: admission.reason,
      ...(admission.userId === undefined ? {} : { userId: admission.userId }),
      setCookies: [clearTransaction],
    };
  }

  // One session cookie per browser: every session it held before ends, unless it is this one (a
  // repeated callback). A handle UTS already replaced answers `invalid_session`, which is fine.
  const prior = requestSessionCookies(setup, input.cookieHeader);
  const priorHandles =
    prior.status === 'one'
      ? [prior.cookie.handle]
      : prior.status === 'invalid'
        ? prior.handles
        : [];
  for (const priorHandle of priorHandles) {
    if (sameValue(priorHandle, handle)) continue;
    const ended = await setup.client.endSession(priorHandle);
    if (ended.kind === 'retryable') {
      return retry('prior_session_unresolved', ended.retryAfterSeconds);
    }
  }

  const maxAge = session.expires_at - Math.floor(Date.now() / 1000);
  if (maxAge <= 0) {
    return { kind: 'failed', reason: 'exchange_failed', code: 'session_expired', setCookies: [] };
  }
  return {
    kind: 'signed_in',
    location: `${setup.appOrigin}${transaction.return_to}`,
    userId: admission.userId,
    setCookies: [
      cookie(
        setup,
        setup.cookies.session,
        `${handle}.${browserSessionPepperBinding(admission.pepper)}`,
        maxAge
      ),
      clearTransaction,
      ...retiredNextAuthSessionCookies(input.cookieHeader),
    ],
  };
}

/**
 * What the request's session cookie names. `absent`: no cookie of that name. `ended`: UTS says the
 * handle names no live session, or the cookie is malformed or ambiguous. `unavailable`: UTS or the
 * client key cannot answer now; the cookie is kept and the request is never treated as signed
 * out. `active` carries the handle in memory for `touchBrowserSession`; the caller checks
 * `binding` against the current pepper.
 */
export type BrowserSessionRead =
  | { status: 'absent' }
  | { status: 'ended' }
  | { status: 'unavailable'; reason: string; retryAfterSeconds: number | null }
  | { status: 'active'; handle: string; binding: string; session: BrowserSession };

export async function readBrowserSession(
  setup: BrowserSessionSetup,
  cookieHeader: string | null
): Promise<BrowserSessionRead> {
  const stored = requestSessionCookies(setup, cookieHeader);
  if (stored.status === 'none') return { status: 'absent' };
  if (stored.status === 'invalid') return { status: 'ended' };
  const read = await setup.client.readSession(stored.cookie.handle);
  if (read.kind === 'ok') {
    return {
      status: 'active',
      handle: stored.cookie.handle,
      binding: stored.cookie.binding,
      session: read.value,
    };
  }
  if (read.kind === 'invalid_session') return { status: 'ended' };
  return {
    status: 'unavailable',
    reason: failureCode(read),
    retryAfterSeconds: read.kind === 'retryable' ? read.retryAfterSeconds : null,
  };
}

/**
 * Whether the session's 14-day idle window should move: `read` moves no clock, so once the session
 * was last seen more than 10 minutes ago the BFF mints the bootstrap scope, which moves it.
 */
export function isBrowserSessionTouchDue(session: BrowserSession): boolean {
  const now = Math.floor(Date.now() / 1000);
  const fullWindow = Math.min(session.expires_at, now + IDLE_LIFETIME_SECONDS);
  return session.idle_expires_at <= fullWindow - TOUCH_AFTER_SECONDS;
}

/**
 * Moves an admitted session's idle clock. The caller touches only a session the app authorized
 * this request for. Only `ended` matters to it; any other failure leaves the session as read.
 */
export async function touchBrowserSession(
  setup: BrowserSessionSetup,
  handle: string
): Promise<'touched' | 'ended' | 'failed'> {
  const touched = await setup.client.touchSession(handle);
  if (touched.kind === 'ok') return 'touched';
  return touched.kind === 'invalid_session' ? 'ended' : 'failed';
}

/**
 * Ends the request's browser sessions at UTS, every well-formed handle of the cookie. `ended`:
 * authoritative (ended now, already ended, or nothing to end); the caller clears the UTS cookie and
 * any NextAuth session cookie. `retry`: not yet counted as ended; every cookie stays.
 */
export async function endBrowserSession(
  setup: BrowserSessionSetup,
  cookieHeader: string | null
): Promise<
  | { kind: 'ended'; setCookies: string[] }
  | { kind: 'retry'; reason: string; retryAfterSeconds: number | null }
> {
  const stored = requestSessionCookies(setup, cookieHeader);
  const handles =
    stored.status === 'one'
      ? [stored.cookie.handle]
      : stored.status === 'invalid'
        ? stored.handles
        : [];
  for (const handle of handles) {
    const ended = await setup.client.endSession(handle);
    if (ended.kind !== 'ok' && ended.kind !== 'invalid_session') {
      return {
        kind: 'retry',
        reason: failureCode(ended),
        retryAfterSeconds: ended.kind === 'retryable' ? ended.retryAfterSeconds : null,
      };
    }
  }
  return {
    kind: 'ended',
    setCookies: [
      ...(stored.status === 'none' ? [] : [clearedCookie(setup, setup.cookies.session)]),
      ...retiredNextAuthSessionCookies(cookieHeader),
    ],
  };
}

/**
 * Every response of the browser-session routes: `no-store`, no referrer onward, its cookies, and
 * `Retry-After` when UTS named one. A `location` makes it a redirect; otherwise the body is JSON
 * or plain text.
 */
export function browserSessionResponse(init: {
  status: number;
  location?: string;
  json?: unknown;
  text?: string;
  setCookies?: readonly string[];
  retryAfterSeconds?: number | null;
}): Response {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  if (init.location !== undefined) headers.set('Location', init.location);
  if (init.retryAfterSeconds !== undefined && init.retryAfterSeconds !== null) {
    headers.set('Retry-After', String(init.retryAfterSeconds));
  }
  for (const value of init.setCookies ?? []) headers.append('Set-Cookie', value);
  let body: string | null = null;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  } else if (init.text !== undefined) {
    headers.set('Content-Type', 'text/plain; charset=utf-8');
    body = init.text;
  }
  return new Response(body, { status: init.status, headers });
}
