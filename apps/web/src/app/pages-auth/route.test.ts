import { NextRequest } from 'next/server';
import { getUserFromSessionForCredentialIssuanceOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { isValidCallbackPath } from '@/lib/getSignInCallbackUrl';
import { verifyPagesAuthCode } from '@/lib/pages-auth/pages-auth-code';
import { GET } from './route';

// Production is configured; the dev deployment has no secret.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-pages-auth-route-secret',
  PAGES_AUTH_SECRET: 'p'.repeat(40),
  PAGES_DEV_AUTH_SECRET: '',
}));

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuanceOrRedirect: jest.fn(),
}));

const mockedGetUser = jest.mocked(getUserFromSessionForCredentialIssuanceOrRedirect);

const PAGES = 'https://pages.kiloapps.io';
const STATE = 'S'.repeat(43);

function enter(query: string) {
  return GET(new NextRequest(`http://localhost:3000/pages-auth${query}`));
}
const queryOf = (origin: string, state: string) =>
  `?${new URLSearchParams({ origin, state }).toString()}`;

describe('GET /pages-auth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetUser.mockResolvedValue({ id: 'user-1' } as never);
  });

  test('sends a signed-in person to the fixed callback with a code for them', async () => {
    const response = await enter(queryOf(PAGES, STATE));

    expect(response.status).toBe(303);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');

    const location = new URL(response.headers.get('location') ?? '');
    expect(location.origin).toBe(PAGES);
    expect(location.pathname).toBe('/api/auth/kilo/callback');
    expect([...location.searchParams.keys()].sort()).toEqual(['code', 'state']);
    expect(location.searchParams.get('state')).toBe(STATE);
    expect(verifyPagesAuthCode(location.searchParams.get('code'))).toEqual({
      userId: 'user-1',
      origin: PAGES,
      state: STATE,
    });
  });

  test('sign-in is asked to come back to the same link', async () => {
    await enter(queryOf(PAGES, STATE));

    const signInUrl = mockedGetUser.mock.calls[0]?.[0] ?? '';
    const callbackPath = new URL(signInUrl, 'http://localhost:3000').searchParams.get(
      'callbackPath'
    );
    expect(signInUrl.startsWith('/users/sign_in?callbackPath=')).toBe(true);
    expect(callbackPath).toBe(`/pages-auth${queryOf(PAGES, STATE)}`);
    // Sign-in drops a callback path it does not recognize.
    expect(isValidCallbackPath(callbackPath ?? '')).toBe(true);
  });

  test.each([
    ['no parameters', ''],
    ['no state', `?origin=${encodeURIComponent(PAGES)}`],
    ['no origin', `?state=${STATE}`],
    ['another site', queryOf('https://evil.example', STATE)],
    ['a deployment with a path', queryOf(`${PAGES}/p/abc`, STATE)],
    ['a deployment with a trailing slash', queryOf(`${PAGES}/`, STATE)],
    ['a look-alike host', queryOf('https://pages.kiloapps.io.evil.example', STATE)],
    ['a deployment without a secret', queryOf('https://pages-dev.kiloapps.io', STATE)],
    ['a short state', queryOf(PAGES, 'short')],
    ['a state with other characters', queryOf(PAGES, `${'S'.repeat(42)}/`)],
    ['a repeated state', `${queryOf(PAGES, STATE)}&state=${STATE}`],
    ['a repeated origin', `${queryOf(PAGES, STATE)}&origin=${encodeURIComponent(PAGES)}`],
  ])('refuses %s without asking anyone to sign in', async (_name, query) => {
    const response = await enter(query);

    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockedGetUser).not.toHaveBeenCalled();
  });
});
