import { NextRequest } from 'next/server';
import { getProfileOrganizations } from '@kilocode/web-shared/lib/organizations/organizations';
import { findUserById } from '@kilocode/web-shared/lib/user/find-user-by-id';
import { createDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { createPagesAuthCode } from '@/lib/pages-auth/pages-auth-code';
import { POST } from './route';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'synthetic-pages-auth-exchange-secret',
  PAGES_AUTH_SECRET: 'p'.repeat(40),
  PAGES_DEV_AUTH_SECRET: 'd'.repeat(40),
}));

jest.mock('@kilocode/web-shared/lib/user/find-user-by-id', () => ({
  findUserById: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/organizations/organizations', () => ({
  getProfileOrganizations: jest.fn(),
}));

const mockedFindUserById = jest.mocked(findUserById);
const mockedGetProfileOrganizations = jest.mocked(getProfileOrganizations);

const NOW = new Date('2026-03-01T12:00:00.000Z');
const PAGES = 'https://pages.kiloapps.io';
const PAGES_DEV = 'https://pages-dev.kiloapps.io';
const SECRET = 'p'.repeat(40);
const DEV_SECRET = 'd'.repeat(40);
const STATE = 'S'.repeat(43);
const organizations = [{ id: 'org-1', name: 'Kilo', role: 'member' }];

function exchange(body: unknown, secret: string | null = SECRET) {
  return POST(
    new NextRequest('http://localhost:3000/api/pages-auth/exchange', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: {
        'Content-Type': 'application/json',
        ...(secret === null ? {} : { Authorization: `Bearer ${secret}` }),
      },
    })
  );
}
const codeFor = (origin = PAGES, state = STATE) =>
  createPagesAuthCode({ userId: 'user-1', origin, state });

describe('POST /api/pages-auth/exchange', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    mockedFindUserById.mockResolvedValue({
      id: 'user-1',
      google_user_name: 'Ada Lovelace',
      google_user_email: 'ada@kilo.test',
      blocked_reason: null,
    } as never);
    mockedGetProfileOrganizations.mockResolvedValue(organizations as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('answers with who signed in, and nothing else about them', async () => {
    const response = await exchange({ code: codeFor(), origin: PAGES, state: STATE });

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      user: { id: 'user-1', name: 'Ada Lovelace' },
      organizations,
    });
    expect(mockedFindUserById).toHaveBeenCalledWith('user-1');
    expect(mockedGetProfileOrganizations).toHaveBeenCalledWith('user-1', {
      excludeAccessBlocked: true,
    });
  });

  test.each([
    ['no credential', null],
    ['a wrong secret', 'q'.repeat(40)],
    ["another deployment's secret", DEV_SECRET],
  ])('refuses a caller with %s before looking anyone up', async (_name, secret) => {
    const response = await exchange({ code: codeFor(), origin: PAGES, state: STATE }, secret);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'invalid_client' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses an origin that is not a deployment, whatever it presents', async () => {
    const origin = 'https://evil.example';
    const response = await exchange({ code: codeFor(origin), origin, state: STATE });

    expect(response.status).toBe(401);
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses a code minted for another deployment', async () => {
    const response = await exchange({ code: codeFor(PAGES_DEV), origin: PAGES, state: STATE });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_code' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses a code presented with another state', async () => {
    const response = await exchange({ code: codeFor(), origin: PAGES, state: 'T'.repeat(43) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_code' });
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses a stale code', async () => {
    const code = codeFor();
    jest.setSystemTime(new Date(NOW.getTime() + 61_000));

    const response = await exchange({ code, origin: PAGES, state: STATE });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_code' });
  });

  test('refuses a tampered code and a token minted for another purpose', async () => {
    const code = codeFor();
    const tampered = code.slice(0, -1) + (code.at(-1) === 'a' ? 'b' : 'a');

    for (const candidate of [tampered, createDeviceAuthViewerToken('ABCD-EFGH', 'user-1')]) {
      const response = await exchange({ code: candidate, origin: PAGES, state: STATE });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'invalid_code' });
    }
    expect(mockedFindUserById).not.toHaveBeenCalled();
  });

  test('refuses an account that is gone or blocked', async () => {
    mockedFindUserById.mockResolvedValueOnce(undefined);
    const gone = await exchange({ code: codeFor(), origin: PAGES, state: STATE });

    mockedFindUserById.mockResolvedValueOnce({
      id: 'user-1',
      google_user_name: 'Ada Lovelace',
      blocked_reason: 'abuse',
    } as never);
    const blocked = await exchange({ code: codeFor(), origin: PAGES, state: STATE });

    for (const response of [gone, blocked]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'account_unavailable' });
    }
    expect(mockedGetProfileOrganizations).not.toHaveBeenCalled();
  });

  test.each([
    ['a body that is not JSON', 'not json'],
    ['no code', { origin: PAGES, state: STATE }],
    ['no origin', { code: 'a.b', state: STATE }],
    ['no state', { code: 'a.b', origin: PAGES }],
    ['a state of the wrong shape', { code: 'a.b', origin: PAGES, state: 'short' }],
  ])('refuses %s', async (_name, body) => {
    const response = await exchange(body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid_request' });
  });
});
