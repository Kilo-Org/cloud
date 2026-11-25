// The cookie store is stubbed so the signed linking session can round-trip
// without a request context.
const mockCookieStore = new Map<string, string>();
jest.mock('next/headers', () => ({
  cookies: async () => ({
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    get: (name: string) =>
      mockCookieStore.has(name) ? { value: mockCookieStore.get(name) } : undefined,
    delete: (name: string) => mockCookieStore.delete(name),
  }),
}));

import { describe, expect, it } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { hashWebSessionId } from '@kilocode/web-shared/lib/admin/step-up-store';
import {
  createAccountLinkingSession,
  getAccountLinkingSession,
  isLinkingWebSession,
} from './account-linking-session';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const COOKIE_NAME = 'account-linking-session';
const WEB_SESSION_ID = 'web-session-1';
const WEB_SESSION_ID_HASH = hashWebSessionId(WEB_SESSION_ID);

function storeCustomToken(claims: Record<string, unknown>): void {
  const token = jwt.sign(claims, NEXTAUTH_SECRET, {
    algorithm: 'HS256',
    expiresIn: 60 * 15,
  });
  mockCookieStore.set(COOKIE_NAME, token);
}

/** The claims of a well-formed session, for the cases that change one of them. */
function validClaims(): Record<string, unknown> {
  return {
    existingUserId: 'user-1',
    webSessionIdHash: WEB_SESSION_ID_HASH,
    targetProvider: 'openai',
    createdAt: Date.now(),
    tokenPurpose: 'account-linking',
  };
}

function claimsWithout(name: string): Record<string, unknown> {
  const { [name]: _omitted, ...rest } = validClaims();
  return rest;
}

describe('account linking session', () => {
  it('carries the shared-services scope through the signed session', async () => {
    await createAccountLinkingSession({
      existingUserId: 'user-1',
      webSessionId: WEB_SESSION_ID,
      targetProvider: 'openai',
      organizationId: ORGANIZATION_ID,
      chatGptScope: 'shared_services',
    });

    await expect(getAccountLinkingSession()).resolves.toMatchObject({
      existingUserId: 'user-1',
      targetProvider: 'openai',
      organizationId: ORGANIZATION_ID,
      chatGptScope: 'shared_services',
    });
  });

  it('carries an organization member link without the shared-services scope', async () => {
    await createAccountLinkingSession({
      existingUserId: 'user-1',
      webSessionId: WEB_SESSION_ID,
      targetProvider: 'openai',
      organizationId: ORGANIZATION_ID,
    });

    const session = await getAccountLinkingSession();

    expect(session?.organizationId).toBe(ORGANIZATION_ID);
    expect(session?.chatGptScope).toBeUndefined();
  });

  it('binds the session to the browser session that started it', async () => {
    await createAccountLinkingSession({
      existingUserId: 'user-1',
      webSessionId: WEB_SESSION_ID,
      targetProvider: 'openai',
    });

    const session = await getAccountLinkingSession();
    if (!session) throw new Error('expected a linking session');

    expect(isLinkingWebSession(session, WEB_SESSION_ID)).toBe(true);
    expect(isLinkingWebSession(session, 'web-session-2')).toBe(false);
    expect(isLinkingWebSession(session, undefined)).toBe(false);
  });

  it('keeps the browser session id itself out of the cookie', async () => {
    await createAccountLinkingSession({
      existingUserId: 'user-1',
      webSessionId: WEB_SESSION_ID,
      targetProvider: 'openai',
    });

    expect(mockCookieStore.get(COOKIE_NAME)).toBeDefined();
    const claims = jwt.decode(mockCookieStore.get(COOKIE_NAME) ?? '');
    expect(JSON.stringify(claims)).not.toContain(WEB_SESSION_ID);
  });

  it('keeps a linking session usable past the previous five-minute window', async () => {
    const startedAt = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      await createAccountLinkingSession({
        existingUserId: 'user-1',
        webSessionId: WEB_SESSION_ID,
        targetProvider: 'openai',
      });
      nowSpy.mockReturnValue(startedAt + 9 * 60 * 1000);

      await expect(getAccountLinkingSession()).resolves.toMatchObject({
        existingUserId: 'user-1',
        targetProvider: 'openai',
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('marks the signed session with its purpose', async () => {
    await createAccountLinkingSession({
      existingUserId: 'user-1',
      webSessionId: WEB_SESSION_ID,
      targetProvider: 'openai',
    });

    const claims = jwt.verify(mockCookieStore.get(COOKIE_NAME) ?? '', NEXTAUTH_SECRET);

    expect(claims).toMatchObject({ tokenPurpose: 'account-linking' });
  });

  it('accepts the well-formed claims the cases below change', async () => {
    storeCustomToken(validClaims());

    await expect(getAccountLinkingSession()).resolves.toMatchObject({ existingUserId: 'user-1' });
  });

  it('refuses a token minted for another purpose', async () => {
    storeCustomToken(claimsWithout('tokenPurpose'));

    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  it.each([
    ['a missing user', claimsWithout('existingUserId')],
    ['an empty user', { ...validClaims(), existingUserId: '' }],
    ['a missing browser session', claimsWithout('webSessionIdHash')],
    [
      'a browser session that is not a hash',
      { ...validClaims(), webSessionIdHash: WEB_SESSION_ID },
    ],
    ['a missing provider', claimsWithout('targetProvider')],
    ['a non-string provider', { ...validClaims(), targetProvider: 7 }],
    ['an organization that is not a uuid', { ...validClaims(), organizationId: 'not-a-uuid' }],
    ['an unknown shared-services scope', { ...validClaims(), chatGptScope: 'personal' }],
    ['a missing timestamp', claimsWithout('createdAt')],
    [
      'a timestamp that is not a number',
      { ...validClaims(), createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    ['an unexpected claim', { ...validClaims(), admin: true }],
  ])('refuses a session with %s', async (_label, claims) => {
    storeCustomToken(claims);

    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  it('refuses a session older than the linking window', async () => {
    storeCustomToken({ ...validClaims(), createdAt: Date.now() - 16 * 60 * 1000 });

    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });
});
