import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import type * as HandoffTokenModule from '@/lib/app-shell/handoff-token';
import type * as SessionModule from '@/lib/app-shell/session';
import type * as HandoffRouteModule from './route';
import { NextRequest } from 'next/server';
import { shellUser } from '@/tests/helpers/shell-user.helper';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: '[REDACTED by s1-secret-redact]',
}));
jest.mock('@/lib/app-shell/handoff-token', () => ({
  consumeAppShellHandoff: jest.fn(),
}));
jest.mock('@/lib/app-shell/session', () => ({
  ...jest.requireActual<typeof SessionModule>('@/lib/app-shell/session'),
  loadAppShellUser: jest.fn(),
}));

// This repo's transform does not hoist `jest.mock` above the static imports, so
// the mocked module and the modules under test are required here.
const { consumeAppShellHandoff } = jest.requireMock<typeof HandoffTokenModule>(
  '@/lib/app-shell/handoff-token'
);
const { APP_SHELL_SESSION_COOKIE, verifyAppShellSessionToken, loadAppShellUser } =
  jest.requireMock<typeof SessionModule>('@/lib/app-shell/session');
const { GET } = jest.requireActual<typeof HandoffRouteModule>('./route');

const mockConsume = jest.mocked(consumeAppShellHandoff);
const mockLoadUser = jest.mocked(loadAppShellUser);

beforeEach(() => {
  mockConsume.mockReset();
  mockLoadUser.mockReset();
  mockLoadUser.mockResolvedValue({ status: 'active', user: shellUser('user-1') });
});

function handoffRequest(token?: string, origin = 'https://kilo.example'): NextRequest {
  const url = new URL(`${origin}/app-shell/handoff`);
  if (token !== undefined) url.searchParams.set('token', token);
  return new NextRequest(url);
}

describe('GET /app-shell/handoff', () => {
  test('sets a shell-scoped session cookie and redirects to the stored target', async () => {
    mockConsume.mockResolvedValue({
      userId: 'user-1',
      targetPath: '/app-shell/github-app?organizationId=org-1',
    });

    const response = await GET(handoffRequest('one-time-token'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('/app-shell/github-app?organizationId=org-1');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');

    const cookie = response.cookies.get(APP_SHELL_SESSION_COOKIE);
    expect(cookie?.path).toBe('/app-shell');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(verifyAppShellSessionToken(cookie?.value)).toEqual({ userId: 'user-1' });
  });

  test('redirects on the origin the browser requested, not the bind host', async () => {
    mockConsume.mockResolvedValue({
      userId: 'user-1',
      targetPath: '/app-shell/connected-accounts',
    });

    // The dev server binds 0.0.0.0, so a Location built from `request.url` would
    // send the browser to a different host than the one that holds the cookie.
    const response = await GET(handoffRequest('one-time-token', 'http://0.0.0.0:3000'));

    const location = response.headers.get('location');
    expect(location).toBe('/app-shell/connected-accounts');
    expect(location).not.toContain('0.0.0.0');
    expect(location).not.toContain('://');
  });

  test('sends a replayed or expired token to the terminal page instead of a page', async () => {
    mockConsume.mockResolvedValue(null);

    const response = await GET(handoffRequest('spent-token'));

    expect(response.headers.get('location')).toBe('/app-shell/expired');
    expect(response.cookies.get(APP_SHELL_SESSION_COOKIE)).toBeUndefined();
  });

  test('sends a stripped token to the terminal page', async () => {
    mockConsume.mockResolvedValue(null);

    const response = await GET(handoffRequest());

    expect(mockConsume).toHaveBeenCalledWith('');
    expect(response.headers.get('location')).toBe('/app-shell/expired');
  });

  test('does not hand a blocked account a shell session', async () => {
    mockConsume.mockResolvedValue({ userId: 'blocked-user', targetPath: '/app-shell/github-app' });
    mockLoadUser.mockResolvedValue({ status: 'restricted' });

    const response = await GET(handoffRequest('one-time-token'));

    expect(response.headers.get('location')).toBe('/app-shell/account-unavailable');
    expect(response.cookies.get(APP_SHELL_SESSION_COOKIE)).toBeUndefined();
  });

  test('does not hand a deleted account a shell session', async () => {
    mockConsume.mockResolvedValue({ userId: 'deleted-user', targetPath: '/app-shell/github-app' });
    mockLoadUser.mockResolvedValue({ status: 'gone' });

    const response = await GET(handoffRequest('one-time-token'));

    expect(response.headers.get('location')).toBe('/app-shell/expired');
    expect(response.cookies.get(APP_SHELL_SESSION_COOKIE)).toBeUndefined();
  });
});
