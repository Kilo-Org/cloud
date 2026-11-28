const mockHeaders = jest.fn<Promise<Headers>, []>();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

const mockGetServerSession = jest.fn();

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

const mockRedirect = jest.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

jest.mock('next/navigation', () => ({
  ...jest.requireActual('next/navigation'),
  redirect: (url: string) => mockRedirect(url),
}));

import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import { eq } from 'drizzle-orm';
import { kilocode_users, organizations, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  createFakeUts,
  generateKiloWebTestKey,
  type FakeSignIn,
  type FakeUts,
} from '@kilocode/web-shared/tests/helpers/uts-kilo-web.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { revokeWebSessions } from '@kilocode/web-shared/lib/web-session-revocation';
import { admitStaff } from '@kilocode/web-shared/lib/admin/admin-guard';
import {
  SessionCheckUnavailableError,
  sessionCheckResponseHeaders,
} from '@kilocode/web-shared/lib/uts-bff/browser-session-config';
import {
  browserSessionSetup,
  completeBrowserSignIn,
  startBrowserSignIn,
  type BrowserCallbackOutcome,
} from '@kilocode/web-shared/lib/uts-bff/browser-session';
import { contextAuthRefusal, createTRPCContext } from '@kilocode/web-shared/lib/trpc/init';
import { getUserFromAuth, getUserFromAuthOrRedirect, getUtsBrowserSessionStatus } from './server';

const REDIRECT_URI = 'http://localhost:3000/api/auth/uts/callback';
const SWITCH_VARIABLES = ['UTS_BROWSER_SESSIONS', 'UTS_KILO_WEB_CLIENT_KEY'] as const;
const READ_PATH = '/account/browser-sessions/read';

let uts: FakeUts;
let fetchSpy: jest.SpyInstance;

beforeEach(async () => {
  mockHeaders.mockReset();
  mockGetServerSession.mockReset();
  mockRedirect.mockClear();
  const key = await generateKiloWebTestKey();
  uts = createFakeUts(key);
  process.env.UTS_BROWSER_SESSIONS = 'on';
  process.env.UTS_KILO_WEB_CLIENT_KEY = key.privateJwk;
  fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(uts.fetch);
});

afterEach(() => {
  for (const name of SWITCH_VARIABLES) delete process.env[name];
  jest.restoreAllMocks();
});

/** A real callback through the fake UTS and the app's own admission. */
async function callbackThroughUts(
  subject: string,
  signIn?: FakeSignIn
): Promise<BrowserCallbackOutcome> {
  const setup = browserSessionSetup();
  if (setup === null) throw new Error('expected a development setup');
  const { location, setCookie } = startBrowserSignIn(setup, '/');
  const transaction = setCookie.split(';')[0];
  const { verifier } = JSON.parse(
    Buffer.from(transaction.slice(transaction.indexOf('=') + 1), 'base64url').toString('utf8')
  ) as { verifier: string };
  const code = uts.issueCode(
    subject,
    REDIRECT_URI,
    createHash('sha256').update(verifier).digest('base64url'),
    signIn
  );
  return await completeBrowserSignIn(setup, {
    requestUrl: `${REDIRECT_URI}?${new URLSearchParams({
      code,
      state: new URL(location).searchParams.get('state') ?? '',
      iss: uts.issuer,
    })}`,
    cookieHeader: transaction,
  });
}

/** The session cookie of an accepted sign-in. */
async function signInThroughUts(user: User, signIn?: FakeSignIn): Promise<string> {
  const outcome = await callbackThroughUts(user.id, signIn);
  if (outcome.kind !== 'signed_in') throw new Error(`expected signed_in, got ${outcome.kind}`);
  return outcome.setCookies[0].split(';')[0];
}

function requestWith(cookie: string) {
  mockHeaders.mockResolvedValue(new Headers({ cookie }));
}

function legacySession(user: User) {
  mockGetServerSession.mockResolvedValue({
    user: { id: user.id },
    kiloUserId: user.id,
    webSessionPepper: user.web_session_pepper,
    webSessionId: 'legacy-session',
    authenticatedAt: 1,
  });
}

describe('switch off and NextAuth-only browsers', () => {
  test('with the switch off the UTS cookie is ignored and NextAuth is read as before', async () => {
    const bffUser = await insertTestUser();
    const legacyUser = await insertTestUser();
    const cookie = await signInThroughUts(bffUser);
    delete process.env.UTS_BROWSER_SESSIONS;
    fetchSpy.mockClear();
    requestWith(`${cookie}; next-auth.session-token=x`);
    legacySession(legacyUser);

    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user?.id).toBe(legacyUser.id);
    expect(result.credential).toBe('session');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await getUtsBrowserSessionStatus()).toEqual({ status: 'absent' });
  });

  test('a request without a UTS cookie reads NextAuth as before, without calling UTS', async () => {
    const user = await insertTestUser();
    requestWith('next-auth.session-token=x');
    legacySession(user);
    fetchSpy.mockClear();

    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user?.id).toBe(user.id);
    expect(result.credential).toBe('session');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('one session family per browser', () => {
  test('a live UTS session signs the request in as its own family, without reading NextAuth', async () => {
    const user = await insertTestUser();
    const cookie = await signInThroughUts(user);
    requestWith(cookie);

    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user?.id).toBe(user.id);
    expect(result.credential).toBe('uts_session');
    expect(result.browserSessionFamily).toBe('uts');
    expect(result.webSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test.each([
    ['ended at UTS', 'ended'],
    ['malformed', 'malformed'],
    ['duplicated', 'duplicate'],
  ])('a UTS cookie %s is 401 and never falls back to the NextAuth session', async (_, kind) => {
    const bffUser = await insertTestUser();
    const legacyUser = await insertTestUser();
    const cookie = await signInThroughUts(bffUser);
    if (kind === 'ended') for (const session of uts.sessions.values()) session.ended = true;
    const header =
      kind === 'malformed'
        ? 'kilo-web-session=garbage'
        : kind === 'duplicate'
          ? `${cookie}; ${cookie}`
          : cookie;
    requestWith(`${header}; next-auth.session-token=x`);
    legacySession(legacyUser);

    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
    expect(result.credentialsRejected).toBe(true);
    expect(mockGetServerSession).not.toHaveBeenCalled();
    expect(await getUtsBrowserSessionStatus()).toEqual({ status: 'ended' });
  });

  test('a web-session pepper rotation ends the UTS session here; NextAuth does not answer', async () => {
    const user = await insertTestUser();
    const cookie = await signInThroughUts(user);
    await revokeWebSessions(user.id);
    requestWith(cookie);
    legacySession(user);

    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(401);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test('an account UTS created on its own has no app row and does not sign in', async () => {
    expect(await callbackThroughUts('uts_abcdefghijklmnopqrstuvwxyz')).toMatchObject({
      kind: 'failed',
      reason: 'account_refused',
      code: 'no_account',
    });
  });
});

describe('outage', () => {
  test('a UTS outage is 503 with Retry-After, even with a NextAuth session present', async () => {
    const user = await insertTestUser();
    const legacyUser = await insertTestUser();
    const cookie = await signInThroughUts(user);
    requestWith(cookie);
    legacySession(legacyUser);
    uts.failNext(READ_PATH, 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '7' });

    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(503);
    expect(result.authFailedResponse?.headers.get('Retry-After')).toBe('7');
    expect(result.sessionCheckUnavailable).toEqual({ retryAfterSeconds: 7 });
    expect(result.credentialsRejected).toBe(false);
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test('a page never redirects to sign-in during an outage', async () => {
    const user = await insertTestUser();
    const cookie = await signInThroughUts(user);
    requestWith(cookie);
    uts.failNext(READ_PATH, 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '7' });

    const page = getUserFromAuthOrRedirect();
    await expect(page).rejects.toBeInstanceOf(SessionCheckUnavailableError);
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('tRPC answers SERVICE_UNAVAILABLE with Retry-After, never the sign-out error', async () => {
    const user = await insertTestUser();
    const cookie = await signInThroughUts(user);
    requestWith(cookie);
    uts.failNext(READ_PATH, 503, { error: 'temporarily_unavailable' }, { 'Retry-After': '7' });

    const auth = await getUserFromAuth({ adminOnly: false });
    const refusal = contextAuthRefusal(auth, null);
    expect(refusal).toBeInstanceOf(TRPCError);
    expect(refusal?.code).toBe('SERVICE_UNAVAILABLE');
    expect(refusal?.cause).toBeInstanceOf(SessionCheckUnavailableError);
    expect(sessionCheckResponseHeaders(refusal ? [refusal] : [])).toEqual({ 'Retry-After': '7' });
    expect(sessionCheckResponseHeaders([new TRPCError({ code: 'UNAUTHORIZED' })])).toEqual({});
  });
});

describe('staff authority', () => {
  test('an admin request with a UTS cookie is refused by name and never falls back', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const cookie = await signInThroughUts(admin);
    requestWith(cookie);
    legacySession(admin);
    fetchSpy.mockClear();

    const result = await getUserFromAuth({ adminOnly: true });
    expect(result.user).toBeNull();
    expect(result.authFailedResponse?.status).toBe(403);
    expect(await result.authFailedResponse?.json()).toMatchObject({
      error: 'Access denied (UTS browser session)',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(mockGetServerSession).not.toHaveBeenCalled();
  });

  test('tRPC staff admission refuses a UTS session by name', async () => {
    const admin = await insertTestUser({ is_admin: true });
    const cookie = await signInThroughUts(admin);
    requestWith(cookie);

    const ctx = await createTRPCContext({
      req: new Request('http://localhost:3000/api/trpc/admin.x', { headers: { cookie } }),
    });
    expect(ctx.credential).toBe('uts_session');
    expect(ctx.browserSessionFamily).toBe('uts');
    const admitted = await admitStaff({
      user: ctx.user,
      credential: ctx.credential,
      webSessionId: ctx.webSessionId,
      webSessionPepper: ctx.webSessionPepper,
      headers: new Headers(),
      surface: 'trpc',
      route: 'admin.x',
      method: 'query',
      actionClass: 'platform_read',
      proof: { kind: 'bootstrap' },
    });
    expect(admitted).toEqual({ ok: false, refusal: { kind: 'uts_session' } });
  });
});

describe('account and SSO policy', () => {
  test('a blocked account is refused and its session never moves its idle clock', async () => {
    const user = await insertTestUser();
    const cookie = await signInThroughUts(user);
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'test' })
      .where(eq(kilocode_users.id, user.id));
    uts.ageIdle(11 * 60);
    requestWith(cookie);

    const refused = await getUserFromAuth({ adminOnly: false });
    expect(refused.user).toBeNull();
    expect(refused.authFailedResponse?.status).toBe(403);
    const allowed = await getUserFromAuth({ adminOnly: false, DANGEROUS_allowBlockedUsers: true });
    expect(allowed.user?.id).toBe(user.id);
    expect(uts.touches()).toBe(0);
  });

  test('an authorized session last seen over 10 minutes ago moves its idle clock once', async () => {
    const user = await insertTestUser();
    const cookie = await signInThroughUts(user);
    requestWith(cookie);
    await getUserFromAuth({ adminOnly: false });
    expect(uts.touches()).toBe(0);
    uts.ageIdle(11 * 60);
    await getUserFromAuth({ adminOnly: false });
    expect(uts.touches()).toBe(1);
  });

  test('a domain that requires SSO admits only the verified SSO organization', async () => {
    const owner = await insertTestUser();
    const domain = `sso-${randomUUID().slice(0, 8)}.example`;
    const workOsOrganization = `org_${randomUUID().replaceAll('-', '')}`;
    const organization = await createTestOrganization(`SSO ${domain}`, owner.id, 0);
    await db
      .update(organizations)
      .set({ sso_domain: domain, external_org_id: workOsOrganization })
      .where(eq(organizations.id, organization.id));
    const member = await insertTestUser({ google_user_email: `person@${domain}` });

    expect(await callbackThroughUts(member.id)).toMatchObject({
      kind: 'failed',
      reason: 'account_refused',
      code: 'sso_required',
      userId: member.id,
    });
    expect(
      await callbackThroughUts(member.id, {
        amr: ['sso'],
        sso_connection: 'conn_other',
        sso_organization: 'org_other',
      })
    ).toMatchObject({ kind: 'failed', code: 'sso_organization_mismatch' });

    const cookie = await signInThroughUts(member, {
      amr: ['sso'],
      sso_connection: 'conn_1',
      sso_organization: workOsOrganization,
    });
    requestWith(cookie);
    const result = await getUserFromAuth({ adminOnly: false });
    expect(result.user?.id).toBe(member.id);
    expect(result.ssoSourceOrganizationId).toBe(organization.id);
  });
});
