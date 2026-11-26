import type * as securityNoticesModule from '@/lib/security-notices';
import type * as sentryModule from '@sentry/nextjs';

jest.mock('@/lib/security-notices', () => ({
  ...jest.requireActual<typeof securityNoticesModule>('@/lib/security-notices'),
  scheduleSecurityNotice: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual<typeof sentryModule>('@sentry/nextjs'),
  captureException: jest.fn(),
}));

import { beforeEach, describe, expect, test } from '@jest/globals';
import { captureException } from '@sentry/nextjs';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { scheduleSecurityNotice } from '@/lib/security-notices';
import { scheduleNewSignInCheck } from '@/lib/auth/new-sign-in-check';

const mockScheduleSecurityNotice = jest.mocked(scheduleSecurityNotice);
const mockCaptureException = jest.mocked(captureException);

const CHROME_ON_MACOS =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const ANDROID_APP = 'Kilo-Code/1.0.4 (android)';

function requestHeaders(address: string, country: string, userAgent = CHROME_ON_MACOS) {
  return new Headers({
    'x-vercel-forwarded-for': address,
    'x-vercel-ip-country': country,
    'x-vercel-ip-city': 'Berlin',
    'user-agent': userAgent,
  });
}

describe('scheduleNewSignInCheck', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockScheduleSecurityNotice.mockResolvedValue(undefined);
  });

  test('notifies a sign-in from a new device on a new network, and only that one', async () => {
    const user = await insertTestUser();
    const check = (secret: string, address: string, country: string) =>
      scheduleNewSignInCheck({
        user,
        method: 'google',
        device: { kind: 'browser_cookie', secret },
        headers: requestHeaders(address, country),
      });

    await check('laptop', '203.0.113.45', 'DE');
    await check('laptop', '198.51.100.7', 'FR');
    await check('phone', '203.0.113.99', 'DE');
    expect(mockScheduleSecurityNotice).not.toHaveBeenCalled();

    await check('stranger', '192.0.2.10', 'US');

    expect(mockScheduleSecurityNotice).toHaveBeenCalledTimes(1);
    expect(mockScheduleSecurityNotice).toHaveBeenCalledWith(
      user,
      { type: 'new_sign_in', method: 'google' },
      expect.objectContaining({
        occurredAt: expect.any(Date),
        location: 'Berlin, US',
        device: 'Chrome on macOS',
      })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('a same-version Android sign-in is decided on the network alone', async () => {
    const user = await insertTestUser();
    const android = (address: string, country: string) =>
      scheduleNewSignInCheck({
        user,
        method: 'email',
        device: { kind: 'no_install_key' },
        headers: requestHeaders(address, country, ANDROID_APP),
      });

    // The victim's phone, then the same app version from a known network.
    await android('203.0.113.45', 'DE');
    await android('203.0.113.99', 'DE');
    expect(mockScheduleSecurityNotice).not.toHaveBeenCalled();

    // The same app version from a new network notifies.
    await android('192.0.2.10', 'US');
    expect(mockScheduleSecurityNotice).toHaveBeenCalledTimes(1);
    expect(mockScheduleSecurityNotice).toHaveBeenCalledWith(
      user,
      { type: 'new_sign_in', method: 'email' },
      expect.objectContaining({ location: 'Berlin, US' })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('a failed detection resolves and is reported without user data', async () => {
    const user = await insertTestUser();
    // A database error's message names the query parameters.
    const transaction = jest
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(new Error(`failed query with params ${user.id}`));

    await expect(
      scheduleNewSignInCheck({
        user,
        method: 'email',
        device: { kind: 'browser_cookie', secret: 'laptop' },
        headers: requestHeaders('203.0.113.45', 'DE'),
      })
    ).resolves.toBeUndefined();

    expect(mockScheduleSecurityNotice).not.toHaveBeenCalled();
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [reported, context] = mockCaptureException.mock.calls[0] ?? [];
    expect(reported).toEqual(new Error('sign_in_context_check_failed'));
    expect(reported).not.toHaveProperty('cause');
    expect(context).toEqual({ tags: { source: 'sign_in_context_check' } });
    transaction.mockRestore();
  });

  test('a check skipped at its lock limit sends nothing and reports nothing', async () => {
    const user = await insertTestUser();
    const transaction = jest
      .spyOn(db, 'transaction')
      .mockRejectedValueOnce(
        new Error('failed query', { cause: Object.assign(new Error('lock'), { code: '55P03' }) })
      );

    await scheduleNewSignInCheck({
      user,
      method: 'email',
      device: { kind: 'browser_cookie', secret: 'laptop' },
      headers: requestHeaders('203.0.113.45', 'DE'),
    });

    expect(mockScheduleSecurityNotice).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
    transaction.mockRestore();
  });

  test('a sign-in of an account that is gone sends nothing and reports nothing', async () => {
    const user = { id: `missing-${crypto.randomUUID()}`, google_user_email: 'a@example.com' };

    await scheduleNewSignInCheck({
      user,
      method: 'email',
      device: { kind: 'browser_cookie', secret: 'laptop' },
      headers: requestHeaders('203.0.113.45', 'DE'),
    });

    expect(mockScheduleSecurityNotice).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalled();
  });
});
