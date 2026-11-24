import { beforeEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'crypto';

const cookieStore = new Map<string, { name: string; value: string }>();
const requestHeaders = new Headers();
jest.mock('next/headers', () => ({
  headers: async () => requestHeaders,
  cookies: async () => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => cookieStore.set(name, { name, value }),
    delete: (name: string) => cookieStore.delete(name),
    getAll: () => [...cookieStore.values()],
  }),
}));

import { encode } from 'next-auth/jwt';
import type { User } from '@kilocode/db/schema';
import { NEXTAUTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { getAccountLinkingSession } from '@/lib/account-linking-session';
import { AccountLinkingProviders } from '@/lib/auth/provider-metadata';
import { appShellProceduresRouter } from '@/routers/app-shell-procedures-router';
import { createBearerCallerForUser, createSessionCallerForUser } from '@/routers/test-utils';

const createAppShellCaller = createCallerFactory(appShellProceduresRouter);

async function setSessionCookie(user: User, webSessionPepper = user.web_session_pepper) {
  cookieStore.set('next-auth.session-token', {
    name: 'next-auth.session-token',
    value: await encode({
      secret: NEXTAUTH_SECRET,
      token: { kiloUserId: user.id, sub: randomUUID(), webSessionPepper },
    }),
  });
}

function insertLinkingUser(userData: Partial<User> = {}) {
  return insertTestUser({ web_session_pepper: randomUUID(), ...userData });
}

const refusal = {
  code: 'FORBIDDEN',
  message: 'Sign in to the Kilo web app to add a sign-in method.',
};

describe('user router - linkAuthProvider', () => {
  beforeEach(() => {
    cookieStore.clear();
    requestHeaders.delete('authorization');
  });

  it('starts a link for every provider the connected-accounts card offers', async () => {
    const user = await insertLinkingUser();
    await setSessionCookie(user);
    const caller = await createSessionCallerForUser(user.id);

    for (const { id } of AccountLinkingProviders) {
      await expect(caller.user.linkAuthProvider({ provider: id })).resolves.toEqual({
        success: true,
      });
      await expect(getAccountLinkingSession()).resolves.toMatchObject({
        existingUserId: user.id,
        targetProvider: id,
      });
    }

    // A method the card does not offer must not open a linking session.
    await expect(caller.user.linkAuthProvider({ provider: 'workos' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  it('refuses a bearer caller', async () => {
    const user = await insertLinkingUser();
    await setSessionCookie(user);
    requestHeaders.set('authorization', 'Bearer any-credential');
    const caller = await createBearerCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'google' })).rejects.toMatchObject(
      refusal
    );
    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  it.each(['revoked', 'blocked'])('refuses a web session that is %s', async sessionState => {
    const user = await insertLinkingUser(
      sessionState === 'blocked' ? { blocked_reason: 'test block' } : {}
    );
    await setSessionCookie(
      user,
      sessionState === 'revoked' ? randomUUID() : user.web_session_pepper
    );
    const caller = await createSessionCallerForUser(user.id);

    await expect(caller.user.linkAuthProvider({ provider: 'google' })).rejects.toMatchObject(
      refusal
    );
    await expect(getAccountLinkingSession()).resolves.toBeNull();
  });

  // The app shell names its caller with its own cookie, which the OAuth
  // callback never receives, so a shell link can only complete when the same
  // browser also holds that account's web session.
  describe('from the app shell', () => {
    it('starts a link when the browser holds the account web session', async () => {
      const user = await insertLinkingUser();
      await setSessionCookie(user);
      const caller = createAppShellCaller({ user, headersList: new Headers() });

      await expect(caller.user.linkAuthProvider({ provider: 'google' })).resolves.toEqual({
        success: true,
      });
      await expect(getAccountLinkingSession()).resolves.toMatchObject({
        existingUserId: user.id,
        targetProvider: 'google',
      });
    });

    it('refuses a browser without a web session', async () => {
      const user = await insertLinkingUser();
      const caller = createAppShellCaller({ user, headersList: new Headers() });

      await expect(caller.user.linkAuthProvider({ provider: 'google' })).rejects.toMatchObject(
        refusal
      );
      await expect(getAccountLinkingSession()).resolves.toBeNull();
    });

    it('refuses a web session for another account', async () => {
      const user = await insertLinkingUser();
      await setSessionCookie(await insertLinkingUser());
      const caller = createAppShellCaller({ user, headersList: new Headers() });

      await expect(caller.user.linkAuthProvider({ provider: 'google' })).rejects.toMatchObject(
        refusal
      );
      await expect(getAccountLinkingSession()).resolves.toBeNull();
    });
  });
});
