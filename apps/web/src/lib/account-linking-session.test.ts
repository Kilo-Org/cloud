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
import { createAccountLinkingSession, getAccountLinkingSession } from './account-linking-session';

const ORGANIZATION_ID = '00000000-0000-4000-8000-000000000001';
const COOKIE_NAME = 'account-linking-session';

function storeCustomToken(claims: Record<string, unknown>): void {
  const token = jwt.sign(claims, NEXTAUTH_SECRET, {
    algorithm: 'HS256',
    expiresIn: 60 * 15,
  });
  mockCookieStore.set(COOKIE_NAME, token);
}

describe('account linking session', () => {
  it('carries the shared-services scope through the signed session', async () => {
    await createAccountLinkingSession('user-1', 'openai', ORGANIZATION_ID, 'shared_services');

    await expect(getAccountLinkingSession()).resolves.toMatchObject({
      existingUserId: 'user-1',
      targetProvider: 'openai',
      organizationId: ORGANIZATION_ID,
      chatGptScope: 'shared_services',
    });
  });

  it('carries an organization member link without the shared-services scope', async () => {
    await createAccountLinkingSession('user-1', 'openai', ORGANIZATION_ID);

    const session = await getAccountLinkingSession();

    expect(session?.organizationId).toBe(ORGANIZATION_ID);
    expect(session?.chatGptScope).toBeUndefined();
  });

  it('keeps a linking session usable past the previous five-minute window', async () => {
    const startedAt = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      await createAccountLinkingSession('user-1', 'openai');
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
    await createAccountLinkingSession('user-1', 'openai');

    const claims = jwt.verify(mockCookieStore.get(COOKIE_NAME) ?? '', NEXTAUTH_SECRET);

    expect(claims).toMatchObject({ tokenPurpose: 'account-linking' });
  });

  it('refuses a token minted for another purpose', async () => {
    storeCustomToken({
      existingUserId: 'user-1',
      targetProvider: 'openai',
      createdAt: Date.now(),
    });

    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  it.each([
    [
      'a missing user',
      { targetProvider: 'openai', createdAt: Date.now(), tokenPurpose: 'account-linking' },
    ],
    [
      'an empty user',
      {
        existingUserId: '',
        targetProvider: 'openai',
        createdAt: Date.now(),
        tokenPurpose: 'account-linking',
      },
    ],
    [
      'a missing provider',
      { existingUserId: 'user-1', createdAt: Date.now(), tokenPurpose: 'account-linking' },
    ],
    [
      'a non-string provider',
      {
        existingUserId: 'user-1',
        targetProvider: 7,
        createdAt: Date.now(),
        tokenPurpose: 'account-linking',
      },
    ],
    [
      'an organization that is not a uuid',
      {
        existingUserId: 'user-1',
        targetProvider: 'openai',
        organizationId: 'not-a-uuid',
        createdAt: Date.now(),
        tokenPurpose: 'account-linking',
      },
    ],
    [
      'an unknown shared-services scope',
      {
        existingUserId: 'user-1',
        targetProvider: 'openai',
        chatGptScope: 'personal',
        createdAt: Date.now(),
        tokenPurpose: 'account-linking',
      },
    ],
    [
      'a missing timestamp',
      { existingUserId: 'user-1', targetProvider: 'openai', tokenPurpose: 'account-linking' },
    ],
    [
      'a timestamp that is not a number',
      {
        existingUserId: 'user-1',
        targetProvider: 'openai',
        createdAt: '2026-01-01T00:00:00.000Z',
        tokenPurpose: 'account-linking',
      },
    ],
    [
      'an unexpected claim',
      {
        existingUserId: 'user-1',
        targetProvider: 'openai',
        createdAt: Date.now(),
        tokenPurpose: 'account-linking',
        admin: true,
      },
    ],
  ])('refuses a session with %s', async (_label, claims) => {
    storeCustomToken(claims);

    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  it('refuses a session older than the linking window', async () => {
    storeCustomToken({
      existingUserId: 'user-1',
      targetProvider: 'openai',
      createdAt: Date.now() - 16 * 60 * 1000,
      tokenPurpose: 'account-linking',
    });

    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });
});
