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
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { scheduleSecurityNotice } from '@/lib/security-notices';
import { scheduleNewSignInCheck } from '@/lib/auth/new-sign-in-check';

const mockScheduleSecurityNotice = jest.mocked(scheduleSecurityNotice);
const mockCaptureException = jest.mocked(captureException);

function requestHeaders(address: string, country: string) {
  return new Headers({
    'x-vercel-forwarded-for': address,
    'x-vercel-ip-country': country,
    'x-vercel-ip-city': 'Berlin',
    'user-agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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
      {
        type: 'new_sign_in',
        method: 'google',
        deviceKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        networkKeyHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
      expect.objectContaining({
        occurredAt: expect.any(Date),
        location: 'Berlin, US',
        device: 'Chrome on macOS',
      })
    );
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  test('a failed detection resolves and is reported without user data', async () => {
    // No such user row: the statement fails on its foreign key.
    const user = { id: `missing-${crypto.randomUUID()}`, google_user_email: 'a@example.com' };

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
    expect(mockCaptureException).toHaveBeenCalledWith(expect.anything(), {
      tags: { source: 'sign_in_context_check' },
    });
  });
});
