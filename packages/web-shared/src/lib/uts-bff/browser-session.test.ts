import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, test } from '@jest/globals';
import {
  createFakeUts,
  generateKiloWebTestKey,
  type FakeUts,
  type KiloWebTestKey,
} from '@kilocode/web-shared/tests/helpers/uts-kilo-web.helper';
import { browserSessionPepperBinding } from './browser-session-config';
import type { BrowserSession } from './kilo-web-client';
import {
  browserSessionResponse,
  browserSessionSetup,
  completeBrowserSignIn,
  endBrowserSession,
  isBrowserSessionTouchDue,
  readBrowserSession,
  retiredNextAuthSessionCookies,
  safeReturnPath,
  startBrowserSignIn,
  touchBrowserSession,
  type BrowserSessionSetup,
} from './browser-session';

const REDIRECT_URI = 'http://localhost:3000/api/auth/uts/callback';
const SUBJECT = 'user-1';

let key: KiloWebTestKey;
let uts: FakeUts;
let setup: BrowserSessionSetup;

const admitAll = (session: BrowserSession) =>
  Promise.resolve({ decision: 'admit' as const, userId: session.subject, pepper: 'pepper-1' });

beforeEach(async () => {
  key = await generateKiloWebTestKey();
  uts = createFakeUts(key);
  const configured = browserSessionSetup(
    { UTS_BROWSER_SESSIONS: 'on', UTS_KILO_WEB_CLIENT_KEY: key.privateJwk },
    uts.fetch
  );
  if (configured === null) throw new Error('expected a development setup');
  setup = configured;
});

/** `name=value` of a Set-Cookie header, and its attributes. */
function parseSetCookie(header: string) {
  const [pair, ...attributes] = header.split('; ');
  const index = pair.indexOf('=');
  return { name: pair.slice(0, index), value: pair.slice(index + 1), attributes };
}

type Pending = { cookieHeader: string; state: string; verifier: string };

function start(returnTo: string | null = '/profile'): Pending & { location: URL } {
  const { location, setCookie } = startBrowserSignIn(setup, returnTo);
  const { name, value } = parseSetCookie(setCookie);
  const transaction = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as {
    state: string;
    verifier: string;
  };
  return {
    location: new URL(location),
    cookieHeader: `${name}=${value}`,
    state: transaction.state,
    verifier: transaction.verifier,
  };
}

function callbackUrl(params: Record<string, string>, path = '/api/auth/uts/callback'): string {
  return `http://localhost:3000${path}?${new URLSearchParams(params)}`;
}

function codeFor(pending: Pending, subject = SUBJECT): string {
  const challenge = createHash('sha256').update(pending.verifier).digest('base64url');
  return uts.issueCode(subject, REDIRECT_URI, challenge);
}

async function signIn(subject = SUBJECT, cookieHeader = '') {
  const pending = start();
  const outcome = await completeBrowserSignIn(
    setup,
    {
      requestUrl: callbackUrl({
        code: codeFor(pending, subject),
        state: pending.state,
        iss: uts.issuer,
      }),
      cookieHeader: [pending.cookieHeader, cookieHeader].filter(Boolean).join('; '),
    },
    admitAll
  );
  if (outcome.kind !== 'signed_in') throw new Error(`expected signed_in, got ${outcome.kind}`);
  const session = parseSetCookie(outcome.setCookies[0]);
  return { outcome, sessionCookie: `${session.name}=${session.value}`, session };
}

describe('setup', () => {
  test('uses the registered callback and the issuer of each environment, nothing when off', () => {
    expect(setup).toMatchObject({
      environment: 'development',
      issuer: 'http://localhost:8800',
      redirectUri: REDIRECT_URI,
      appOrigin: 'http://localhost:3000',
    });
    const production = browserSessionSetup({
      UTS_BROWSER_SESSIONS: 'on',
      VERCEL_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
    });
    expect(production).toMatchObject({
      issuer: 'https://uts.kiloapps.io',
      redirectUri: 'https://app.kilo.ai/api/auth/uts/callback',
      appOrigin: 'https://app.kilo.ai',
    });
    const staging = browserSessionSetup({
      UTS_BROWSER_SESSIONS: 'on',
      VERCEL_ENV: 'preview',
      VERCEL_TARGET_ENV: 'staging',
    });
    expect(staging).toMatchObject({
      issuer: 'https://uts-staging.kiloapps.io',
      redirectUri: 'https://staging-app.kilo.ai/api/auth/uts/callback',
    });
    expect(browserSessionSetup({})).toBeNull();
    expect(
      browserSessionSetup({
        UTS_BROWSER_SESSIONS: 'on',
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'preview',
      })
    ).toBeNull();
  });
});

describe('safeReturnPath', () => {
  test.each([
    ['/profile', '/profile'],
    ['/cloud/sessions/abc?at=12', '/cloud/sessions/abc?at=12'],
    ['//evil.example', null],
    ['/\\evil.example', null],
    ['https://evil.example/', null],
    ['/api/auth/uts/end', null],
    ['/API/x', null],
    ['/a/../api/x', null],
    ['/a%2F..', null],
    ['/a#fragment', null],
  ])('%s -> %s', (candidate, expected) => {
    expect(safeReturnPath(candidate)).toBe(expected);
  });
});

describe('startBrowserSignIn', () => {
  test('sends exactly the kilo-web authorization request with PKCE S256', () => {
    const pending = start();
    expect(`${pending.location.origin}${pending.location.pathname}`).toBe(
      'http://localhost:8800/authorize'
    );
    expect(Object.fromEntries(pending.location.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'kilo-web',
      redirect_uri: REDIRECT_URI,
      scope: 'uts:browser-session.read',
      resource: 'http://localhost:8800',
      state: pending.state,
      code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
      code_challenge_method: 'S256',
    });
    expect(pending.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pending.state).not.toBe(pending.verifier);
  });

  test('the transaction cookie is HTTP-only, Lax, 10 minutes; __Host- and Secure when deployed', () => {
    const { setCookie } = startBrowserSignIn(setup, '/profile');
    expect(parseSetCookie(setCookie)).toMatchObject({
      name: 'kilo-web-tx',
      attributes: ['Path=/', 'Max-Age=600', 'HttpOnly', 'SameSite=Lax'],
    });
    const production = browserSessionSetup({
      UTS_BROWSER_SESSIONS: 'on',
      VERCEL_ENV: 'production',
      VERCEL_TARGET_ENV: 'production',
    });
    if (production === null) throw new Error('expected a production setup');
    expect(parseSetCookie(startBrowserSignIn(production, null).setCookie)).toMatchObject({
      name: '__Host-kilo-web-tx',
      attributes: ['Path=/', 'Max-Age=600', 'HttpOnly', 'Secure', 'SameSite=Lax'],
    });
  });

  test('an unsafe return path returns to /', async () => {
    const pending = start('//evil.example/x');
    const outcome = await completeBrowserSignIn(
      setup,
      {
        requestUrl: callbackUrl({ code: codeFor(pending), state: pending.state, iss: uts.issuer }),
        cookieHeader: pending.cookieHeader,
      },
      admitAll
    );
    expect(outcome).toMatchObject({ kind: 'signed_in', location: 'http://localhost:3000/' });
  });
});

describe('completeBrowserSignIn', () => {
  test('exchanges the code and sets only an HTTP-only session cookie with the pepper binding', async () => {
    const { outcome, session } = await signIn();
    expect(outcome.location).toBe('http://localhost:3000/profile');
    expect(outcome.userId).toBe(SUBJECT);
    const [handle, binding] = session.value.split('.');
    expect(handle).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(binding).toBe(browserSessionPepperBinding('pepper-1'));
    expect(session.name).toBe('kilo-web-session');
    expect(session.attributes).toContain('HttpOnly');
    expect(session.attributes).toContain('SameSite=Lax');
    const maxAge = Number(session.attributes.find(a => a.startsWith('Max-Age='))?.slice(8));
    expect(maxAge).toBeGreaterThan(30 * 24 * 3600 - 60);
    expect(parseSetCookie(outcome.setCookies[1])).toMatchObject({
      name: 'kilo-web-tx',
      value: '',
      attributes: expect.arrayContaining(['Max-Age=0']),
    });
    expect(outcome.setCookies.join(' ')).not.toContain('at-');
    expect(uts.calls).toEqual([{ path: '/token', status: 200 }]);
  });

  test('a callback without its transaction, with another state or issuer is refused before UTS', async () => {
    const pending = start();
    const code = codeFor(pending);
    const cases: Array<[Record<string, string>, string, string]> = [
      [{ code, state: pending.state, iss: uts.issuer }, '', 'no_transaction'],
      [{ code, state: 'x'.repeat(43), iss: uts.issuer }, pending.cookieHeader, 'state_mismatch'],
      [{ code, state: pending.state }, pending.cookieHeader, 'issuer_mismatch'],
      [
        { code, state: pending.state, iss: 'https://uts.kiloapps.io' },
        pending.cookieHeader,
        'issuer_mismatch',
      ],
    ];
    for (const [params, cookieHeader, reason] of cases) {
      const outcome = await completeBrowserSignIn(
        setup,
        { requestUrl: callbackUrl(params), cookieHeader },
        admitAll
      );
      expect(outcome).toEqual({ kind: 'restart', reason, setCookies: [] });
    }
    expect(uts.calls).toEqual([]);
  });

  test('a repeated parameter, another path or two transaction cookies never reach UTS', async () => {
    const pending = start();
    const code = codeFor(pending);
    const repeated = `${callbackUrl({ code, state: pending.state, iss: uts.issuer })}&code=${code}`;
    expect(
      await completeBrowserSignIn(
        setup,
        { requestUrl: repeated, cookieHeader: pending.cookieHeader },
        admitAll
      )
    ).toMatchObject({ kind: 'restart', reason: 'malformed_callback' });
    expect(
      await completeBrowserSignIn(
        setup,
        {
          requestUrl: callbackUrl(
            { code, state: pending.state, iss: uts.issuer },
            '/api/auth/uts/other'
          ),
          cookieHeader: pending.cookieHeader,
        },
        admitAll
      )
    ).toMatchObject({ kind: 'restart', reason: 'malformed_callback' });
    expect(
      await completeBrowserSignIn(
        setup,
        {
          requestUrl: callbackUrl({ code, state: pending.state, iss: uts.issuer }),
          cookieHeader: `${pending.cookieHeader}; ${pending.cookieHeader}`,
        },
        admitAll
      )
    ).toMatchObject({ kind: 'restart', reason: 'no_transaction' });
    expect(uts.calls).toEqual([]);
  });

  test('an expired transaction is cleared', async () => {
    const pending = start();
    const stale = Buffer.from(
      JSON.stringify({
        v: 1,
        state: pending.state,
        verifier: pending.verifier,
        return_to: '/',
        exp: Math.floor(Date.now() / 1000) - 1,
      })
    ).toString('base64url');
    const outcome = await completeBrowserSignIn(
      setup,
      {
        requestUrl: callbackUrl({ code: codeFor(pending), state: pending.state, iss: uts.issuer }),
        cookieHeader: `kilo-web-tx=${stale}`,
      },
      admitAll
    );
    expect(outcome).toMatchObject({ kind: 'restart', reason: 'transaction_expired' });
    expect(outcome.setCookies).toHaveLength(1);
  });

  test('an authorization error ends the transaction without a session', async () => {
    const pending = start();
    const outcome = await completeBrowserSignIn(
      setup,
      {
        requestUrl: callbackUrl({ error: 'access_denied', state: pending.state, iss: uts.issuer }),
        cookieHeader: pending.cookieHeader,
      },
      admitAll
    );
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: 'authorization_refused',
      code: 'access_denied',
    });
    expect(outcome.setCookies.map(value => parseSetCookie(value).name)).toEqual(['kilo-web-tx']);
  });

  test('a UTS 503 keeps the transaction for a reload; the reload gets the same handle', async () => {
    const pending = start();
    const params = { code: codeFor(pending), state: pending.state, iss: uts.issuer };
    uts.failNext('/token', 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '7' });
    expect(
      await completeBrowserSignIn(
        setup,
        { requestUrl: callbackUrl(params), cookieHeader: pending.cookieHeader },
        admitAll
      )
    ).toEqual({ kind: 'retry', reason: 'unavailable', retryAfterSeconds: 7, setCookies: [] });
    const first = await completeBrowserSignIn(
      setup,
      { requestUrl: callbackUrl(params), cookieHeader: pending.cookieHeader },
      admitAll
    );
    const second = await completeBrowserSignIn(
      setup,
      { requestUrl: callbackUrl(params), cookieHeader: pending.cookieHeader },
      admitAll
    );
    if (first.kind !== 'signed_in' || second.kind !== 'signed_in') throw new Error('expected both');
    expect(first.setCookies[0]).toBe(second.setCookies[0]);
  });

  test('a refused code, a malformed answer and a refused client fail without a session', async () => {
    const pending = start();
    const params = { code: codeFor(pending), state: pending.state, iss: uts.issuer };
    uts.failNext('/token', 400, { error: 'invalid_grant', error_description: 'gone' });
    expect(
      await completeBrowserSignIn(
        setup,
        { requestUrl: callbackUrl(params), cookieHeader: pending.cookieHeader },
        admitAll
      )
    ).toMatchObject({ kind: 'failed', reason: 'exchange_failed', code: 'invalid_grant' });
    uts.failNext('/token', 200, { access_token: 'x' });
    expect(
      await completeBrowserSignIn(
        setup,
        { requestUrl: callbackUrl(params), cookieHeader: pending.cookieHeader },
        admitAll
      )
    ).toMatchObject({ kind: 'failed', reason: 'exchange_failed', code: 'malformed_response' });

    const other = createFakeUts(await generateKiloWebTestKey());
    const wrongKey = browserSessionSetup(
      { UTS_BROWSER_SESSIONS: 'on', UTS_KILO_WEB_CLIENT_KEY: key.privateJwk },
      other.fetch
    );
    if (wrongKey === null) throw new Error('expected a setup');
    const pendingOther = start();
    const challenge = createHash('sha256').update(pendingOther.verifier).digest('base64url');
    expect(
      await completeBrowserSignIn(
        wrongKey,
        {
          requestUrl: callbackUrl({
            code: other.issueCode(SUBJECT, REDIRECT_URI, challenge),
            state: pendingOther.state,
            iss: other.issuer,
          }),
          cookieHeader: pendingOther.cookieHeader,
        },
        admitAll
      )
    ).toMatchObject({ kind: 'failed', reason: 'exchange_failed', code: 'invalid_client' });
  });

  test('a refused account ends the new UTS session and sets no session cookie', async () => {
    const pending = start();
    const outcome = await completeBrowserSignIn(
      setup,
      {
        requestUrl: callbackUrl({ code: codeFor(pending), state: pending.state, iss: uts.issuer }),
        cookieHeader: pending.cookieHeader,
      },
      async () => ({ decision: 'refuse' as const, reason: 'account_blocked' as const })
    );
    expect(outcome).toMatchObject({
      kind: 'failed',
      reason: 'account_refused',
      code: 'account_blocked',
    });
    expect(outcome.setCookies.map(value => parseSetCookie(value).name)).toEqual(['kilo-web-tx']);
    expect([...uts.sessions.values()].every(session => session.ended)).toBe(true);
    expect(uts.calls.map(call => call.path)).toEqual(['/token', '/account/browser-sessions/end']);
  });

  test('a new sign-in ends the session the browser held before', async () => {
    const first = await signIn();
    const second = await signIn(SUBJECT, first.sessionCookie);
    const [firstHandle] = first.session.value.split('.');
    expect(uts.sessions.get(firstHandle)?.ended).toBe(true);
    expect(second.session.value).not.toBe(first.session.value);
  });

  test('an accepted sign-in retires every NextAuth session cookie of the browser', async () => {
    const nextAuth =
      '__Secure-next-auth.session-token=a; next-auth.session-token.0=b; next-auth.csrf-token=c';
    const { outcome } = await signIn(SUBJECT, nextAuth);
    const retired = outcome.setCookies.slice(2).map(parseSetCookie);
    expect(retired).toEqual([
      {
        name: '__Secure-next-auth.session-token',
        value: '',
        attributes: ['Path=/', 'Max-Age=0', 'HttpOnly', 'Secure', 'SameSite=Lax'],
      },
      {
        name: 'next-auth.session-token.0',
        value: '',
        attributes: ['Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'],
      },
    ]);
  });

  test('a failed or retried sign-in leaves the NextAuth cookies in place', async () => {
    const pending = start();
    uts.failNext('/token', 503, { error: 'temporarily_unavailable' });
    const retried = await completeBrowserSignIn(
      setup,
      {
        requestUrl: callbackUrl({ code: codeFor(pending), state: pending.state, iss: uts.issuer }),
        cookieHeader: `${pending.cookieHeader}; next-auth.session-token=a`,
      },
      admitAll
    );
    expect(retried).toMatchObject({ kind: 'retry', setCookies: [] });
  });

  test('an oversized UTS answer is malformed and never read in full', async () => {
    const pending = start();
    uts.failNext('/token', 200, { padding: 'x'.repeat(20 * 1024) });
    expect(
      await completeBrowserSignIn(
        setup,
        {
          requestUrl: callbackUrl({
            code: codeFor(pending),
            state: pending.state,
            iss: uts.issuer,
          }),
          cookieHeader: pending.cookieHeader,
        },
        admitAll
      )
    ).toMatchObject({ kind: 'failed', reason: 'exchange_failed', code: 'malformed_response' });
  });
});

describe('readBrowserSession, touch and end', () => {
  test('reads the live session; a malformed or duplicate cookie is ended, an outage unavailable', async () => {
    const { sessionCookie } = await signIn();
    const read = await readBrowserSession(setup, sessionCookie);
    expect(read).toMatchObject({ status: 'active', session: { subject: SUBJECT, amr: ['email'] } });

    uts.failNext(
      '/account/browser-sessions/read',
      503,
      { error: 'temporarily_unavailable' },
      {
        'Retry-After': '9',
      }
    );
    expect(await readBrowserSession(setup, sessionCookie)).toEqual({
      status: 'unavailable',
      reason: 'unavailable',
      retryAfterSeconds: 9,
    });
    expect(await readBrowserSession(setup, `${sessionCookie}; ${sessionCookie}`)).toEqual({
      status: 'ended',
    });
    expect(await readBrowserSession(setup, 'kilo-web-session=not-a-handle')).toEqual({
      status: 'ended',
    });
    expect(await readBrowserSession(setup, null)).toEqual({ status: 'absent' });
    expect(await readBrowserSession(setup, 'next-auth.session-token=a')).toEqual({
      status: 'absent',
    });

    expect(await endBrowserSession(setup, sessionCookie)).toMatchObject({ kind: 'ended' });
    expect(await readBrowserSession(setup, sessionCookie)).toEqual({ status: 'ended' });
  });

  test('the idle clock is due only once the session was last seen 10 minutes ago', async () => {
    const { sessionCookie } = await signIn();
    const read = await readBrowserSession(setup, sessionCookie);
    if (read.status !== 'active') throw new Error('expected active');
    expect(isBrowserSessionTouchDue(read.session)).toBe(false);
    uts.ageIdle(11 * 60);
    const aged = await readBrowserSession(setup, sessionCookie);
    if (aged.status !== 'active') throw new Error('expected active');
    expect(isBrowserSessionTouchDue(aged.session)).toBe(true);
    expect(await touchBrowserSession(setup, aged.handle)).toBe('touched');
    expect(uts.touches()).toBe(1);
    await endBrowserSession(setup, sessionCookie);
    expect(await touchBrowserSession(setup, aged.handle)).toBe('ended');
  });

  test('end clears the UTS and NextAuth cookies only once UTS confirms; repeats safely', async () => {
    const { sessionCookie } = await signIn();
    const browser = `${sessionCookie}; next-auth.session-token=a`;
    uts.failNext('/account/browser-sessions/end', 503, { error: 'temporarily_unavailable' });
    expect(await endBrowserSession(setup, browser)).toMatchObject({ kind: 'retry' });
    const ended = await endBrowserSession(setup, browser);
    if (ended.kind !== 'ended') throw new Error('expected ended');
    expect(ended.setCookies.map(parseSetCookie)).toEqual([
      {
        name: 'kilo-web-session',
        value: '',
        attributes: ['Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'],
      },
      {
        name: 'next-auth.session-token',
        value: '',
        attributes: ['Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Lax'],
      },
    ]);
    expect([...uts.sessions.values()].every(session => session.ended)).toBe(true);
    expect((await endBrowserSession(setup, browser)).kind).toBe('ended');
    expect(await endBrowserSession(setup, null)).toEqual({ kind: 'ended', setCookies: [] });
  });

  test('a duplicate cookie ends every well-formed handle it names', async () => {
    const first = await signIn();
    const second = await signIn();
    const ended = await endBrowserSession(setup, `${first.sessionCookie}; ${second.sessionCookie}`);
    expect(ended.kind).toBe('ended');
    expect([...uts.sessions.values()].every(session => session.ended)).toBe(true);
  });

  test('only NextAuth session cookies the request sent are retired', () => {
    expect(retiredNextAuthSessionCookies('a=1; next-auth.callback-url=x')).toEqual([]);
    expect(retiredNextAuthSessionCookies(null)).toEqual([]);
  });
});

describe('browserSessionResponse', () => {
  test('is no-store, sends no referrer and carries every cookie', () => {
    const response = browserSessionResponse({
      status: 303,
      location: 'http://localhost:3000/',
      setCookies: ['a=1', 'b=2'],
      retryAfterSeconds: 3,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Location')).toBe('http://localhost:3000/');
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(response.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });
});
