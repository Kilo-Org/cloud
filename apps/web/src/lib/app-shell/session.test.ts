import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as NextHeaders from 'next/headers';
import type * as FindUserById from '@kilocode/web-shared/lib/user/find-user-by-id';
import type * as SessionModule from './session';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-app-shell-signing-secret',
}));
jest.mock('next/headers', () => ({ cookies: jest.fn() }));
jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({ findUserById: jest.fn() }));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked modules and the module under test are required here, after the
// mocks are registered.
const { cookies } = jest.requireMock<typeof NextHeaders>('next/headers');
const { findUserById } = jest.requireMock<typeof FindUserById>(
  '@kilocode/web-shared/lib/user/find-user-by-id'
);
const {
  APP_SHELL_SESSION_COOKIE,
  APP_SHELL_SESSION_TTL_SECONDS,
  appShellSessionCookieOptions,
  createAppShellSessionToken,
  readAppShellSession,
  requireAppShellUser,
  verifyAppShellSessionToken,
} = jest.requireActual<typeof SessionModule>('./session');

const mockCookies = jest.mocked(cookies);
const mockFindUserById = jest.mocked(findUserById);

function requestWithCookies(values: Record<string, string>) {
  mockCookies.mockResolvedValue({
    get: (name: string) => (values[name] === undefined ? undefined : { name, value: values[name] }),
  } as Awaited<ReturnType<typeof cookies>>);
}

beforeEach(() => {
  jest.resetAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('appShellSessionCookieOptions', () => {
  test('scopes the cookie to the shell path', () => {
    expect(appShellSessionCookieOptions()).toEqual({
      path: '/app-shell',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: APP_SHELL_SESSION_TTL_SECONDS,
    });
  });
});

describe('appShellSessionToken', () => {
  test('round-trips the user the hand-off named', () => {
    expect(verifyAppShellSessionToken(createAppShellSessionToken('user-1'))).toEqual({
      userId: 'user-1',
    });
  });

  test('refuses a tampered or missing token', () => {
    const token = createAppShellSessionToken('user-1');

    expect(verifyAppShellSessionToken(`${token}x`)).toBeNull();
    expect(verifyAppShellSessionToken(null)).toBeNull();
    expect(verifyAppShellSessionToken('')).toBeNull();
  });

  test('expires after the shell session lifetime', () => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    const token = createAppShellSessionToken('user-1');

    jest.setSystemTime(
      new Date(Date.parse('2026-01-01T00:00:00Z') + (APP_SHELL_SESSION_TTL_SECONDS + 1) * 1000)
    );

    expect(verifyAppShellSessionToken(token)).toBeNull();
  });
});

describe('readAppShellSession', () => {
  test('reads only the shell cookie', async () => {
    requestWithCookies({ [APP_SHELL_SESSION_COOKIE]: createAppShellSessionToken('user-1') });

    await expect(readAppShellSession()).resolves.toEqual({ userId: 'user-1' });
  });

  test('does not accept a full web session as a shell session', async () => {
    // A signed-in browser on `/api/trpc` or `/credits` carries the NextAuth
    // cookie; the shell pages must not treat that as authority.
    requestWithCookies({ 'next-auth.session-token': 'web-session' });

    await expect(readAppShellSession()).resolves.toBeNull();
    await expect(requireAppShellUser()).resolves.toBeNull();
  });
});

describe('requireAppShellUser', () => {
  test('loads the user the shell cookie names', async () => {
    requestWithCookies({ [APP_SHELL_SESSION_COOKIE]: createAppShellSessionToken('user-1') });
    mockFindUserById.mockResolvedValue(shellUser('user-1'));

    await expect(requireAppShellUser()).resolves.toMatchObject({ id: 'user-1' });
    expect(mockFindUserById).toHaveBeenCalledWith('user-1');
  });

  test('refuses a session whose account is gone', async () => {
    requestWithCookies({ [APP_SHELL_SESSION_COOKIE]: createAppShellSessionToken('deleted-user') });
    mockFindUserById.mockResolvedValue(undefined);

    await expect(requireAppShellUser()).resolves.toBeNull();
  });
});
