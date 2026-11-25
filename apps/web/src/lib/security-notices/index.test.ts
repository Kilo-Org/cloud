jest.mock('@sentry/nextjs', () => ({
  ...jest.requireActual('@sentry/nextjs'),
  captureException: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/email', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/email'),
  sendPasskeyAddedEmail: jest.fn(async () => ({ sent: true })),
  sendPasskeyRemovedEmail: jest.fn(async () => ({ sent: true })),
  sendNewSignInMethodEmail: jest.fn(async () => ({ sent: true })),
  sendSignInMethodRemovedEmail: jest.fn(async () => ({ sent: true })),
  sendDeviceSignInApprovedEmail: jest.fn(async () => ({ sent: true })),
  sendApiKeyResetEmail: jest.fn(async () => ({ sent: true })),
  sendBrowserSessionsRevokedEmail: jest.fn(async () => ({ sent: true })),
  sendNewSignInEmail: jest.fn(async () => ({ sent: true })),
}));
jest.mock('@kilocode/web-shared/lib/notifications-worker-client', () => ({
  dispatchAccountSecurityPush: jest.fn(async () => true),
}));

import { captureException } from '@sentry/nextjs';
import { and, eq } from 'drizzle-orm';
import { transactional_email_log, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import * as email from '@kilocode/web-shared/lib/email';
import { dispatchAccountSecurityPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import {
  scheduleSecurityNotice,
  securityNoticeRequestFromHeaders,
  type SecurityNoticeEvent,
  type SecurityNoticeRequest,
} from './index';

const mockCaptureException = jest.mocked(captureException);
const mockDispatchPush = jest.mocked(dispatchAccountSecurityPush);
const mockSendPasskeyAdded = jest.mocked(email.sendPasskeyAddedEmail);
const mockSendApiKeyReset = jest.mocked(email.sendApiKeyResetEmail);
const mockSendNewSignIn = jest.mocked(email.sendNewSignInEmail);

const REQUEST: SecurityNoticeRequest = {
  occurredAt: new Date('2026-03-04T05:06:07.000Z'),
  ip: '203.0.113.7',
  location: 'Berlin, DE',
  device: 'Firefox on Linux',
};

const EXPECTED_DETAILS = {
  changedAt: REQUEST.occurredAt,
  ip: REQUEST.ip,
  location: REQUEST.location,
  device: REQUEST.device,
};

let user: User;

beforeEach(async () => {
  jest.clearAllMocks();
  user = await insertTestUser();
});

async function noticeRows(userId: string) {
  return db
    .select({ key: transactional_email_log.idempotency_key })
    .from(transactional_email_log)
    .where(
      and(
        eq(transactional_email_log.user_id, userId),
        eq(transactional_email_log.email_type, 'security_notice')
      )
    );
}

const EVENTS: Array<[SecurityNoticeEvent, unknown, unknown[]]> = [
  [
    { type: 'passkey_added', passkeyId: 'pk-1', passkeyName: 'Laptop' },
    jest.mocked(email.sendPasskeyAddedEmail),
    ['Laptop', EXPECTED_DETAILS],
  ],
  [
    { type: 'passkey_removed', passkeyId: 'pk-1', passkeyName: null },
    jest.mocked(email.sendPasskeyRemovedEmail),
    [null, EXPECTED_DETAILS],
  ],
  [
    {
      type: 'sign_in_method_linked',
      provider: 'github',
      providerAccountId: 'gh-1',
      linkedIdentity: { email: 'octo@example.net', displayName: null },
      linkedAt: new Date('2026-03-04T05:06:07.000Z'),
    },
    jest.mocked(email.sendNewSignInMethodEmail),
    ['GitHub', { email: 'octo@example.net', displayName: null }, EXPECTED_DETAILS],
  ],
  [
    { type: 'sign_in_method_unlinked', provider: 'github' },
    jest.mocked(email.sendSignInMethodRemovedEmail),
    ['GitHub', EXPECTED_DETAILS],
  ],
  [
    {
      type: 'device_sign_in_approved',
      deviceAuthRequestId: 'request-1',
      clientLabel: 'Kilo CLI',
      requestIp: '198.51.100.24',
    },
    jest.mocked(email.sendDeviceSignInApprovedEmail),
    [{ clientLabel: 'Kilo CLI', requestIp: '198.51.100.24' }, EXPECTED_DETAILS],
  ],
  [{ type: 'api_key_reset' }, jest.mocked(email.sendApiKeyResetEmail), [EXPECTED_DETAILS]],
  [
    { type: 'browser_sessions_revoked' },
    jest.mocked(email.sendBrowserSessionsRevokedEmail),
    [EXPECTED_DETAILS],
  ],
  [
    {
      type: 'new_sign_in',
      method: 'google',
      deviceKeyHash: 'd'.repeat(64),
      networkKeyHash: 'n'.repeat(64),
    },
    jest.mocked(email.sendNewSignInEmail),
    ['Google', EXPECTED_DETAILS],
  ],
];

describe('scheduleSecurityNotice', () => {
  it.each(EVENTS)('sends one email and one push for %o', async (event, sender, args) => {
    await scheduleSecurityNotice(user, event, REQUEST);

    expect(sender).toHaveBeenCalledTimes(1);
    expect(sender).toHaveBeenCalledWith(user.google_user_email, ...args);
    expect(mockDispatchPush).toHaveBeenCalledTimes(1);
    expect(mockDispatchPush).toHaveBeenCalledWith({
      recipientUserId: user.id,
      event: event.type,
      idempotencyKey: expect.stringMatching(new RegExp(`^${event.type}:[0-9a-f]{64}$`)),
      device: 'Firefox on Linux',
      location: 'Berlin, DE',
    });
    expect(await noticeRows(user.id)).toHaveLength(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('keeps account and device identifiers out of the idempotency key', async () => {
    await scheduleSecurityNotice(
      user,
      {
        type: 'sign_in_method_linked',
        provider: 'github',
        providerAccountId: 'gh-secret-id',
        linkedIdentity: { email: 'octo@example.net' },
        linkedAt: new Date(),
      },
      REQUEST
    );

    const [row] = await noticeRows(user.id);
    expect(row?.key).not.toContain('gh-secret-id');
    expect(row?.key).not.toContain(user.id);
  });

  it('sends nothing for a second schedule of the same event', async () => {
    const event: SecurityNoticeEvent = {
      type: 'passkey_added',
      passkeyId: 'pk-2',
      passkeyName: null,
    };
    await scheduleSecurityNotice(user, event, REQUEST);
    await scheduleSecurityNotice(user, event, { ...REQUEST, occurredAt: new Date() });

    expect(mockSendPasskeyAdded).toHaveBeenCalledTimes(1);
    expect(mockDispatchPush).toHaveBeenCalledTimes(1);
  });

  it('treats repeated resets inside one ten-minute window as one notice, and a later one as new', async () => {
    const at = (iso: string) => ({ ...REQUEST, occurredAt: new Date(iso) });
    await scheduleSecurityNotice(user, { type: 'api_key_reset' }, at('2026-03-04T05:01:00.000Z'));
    await scheduleSecurityNotice(user, { type: 'api_key_reset' }, at('2026-03-04T05:09:00.000Z'));
    await scheduleSecurityNotice(user, { type: 'api_key_reset' }, at('2026-03-04T05:11:00.000Z'));

    expect(mockSendApiKeyReset).toHaveBeenCalledTimes(2);
    expect(mockDispatchPush).toHaveBeenCalledTimes(2);
  });

  it('never throws when the email transport fails, and frees the claim for a retry', async () => {
    const event: SecurityNoticeEvent = {
      type: 'passkey_added',
      passkeyId: 'pk-3',
      passkeyName: null,
    };
    mockSendPasskeyAdded.mockRejectedValueOnce(new Error('mail API down'));

    await expect(scheduleSecurityNotice(user, event, REQUEST)).resolves.toBeUndefined();
    expect(mockDispatchPush).toHaveBeenCalledTimes(1);
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { security_notice: 'passkey_added' },
    });
    expect(await noticeRows(user.id)).toHaveLength(0);

    await scheduleSecurityNotice(user, event, REQUEST);
    expect(mockSendPasskeyAdded).toHaveBeenCalledTimes(2);
  });

  it('keeps the claim when the email will not send on a retry either', async () => {
    mockSendApiKeyReset.mockResolvedValueOnce({ sent: false, reason: 'neverbounce_rejected' });

    await scheduleSecurityNotice(user, { type: 'api_key_reset' }, REQUEST);

    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { security_notice: 'api_key_reset' },
      extra: { reason: 'neverbounce_rejected' },
    });
    expect(await noticeRows(user.id)).toHaveLength(1);
  });

  it('never throws when the push dispatch fails, and still sends the email', async () => {
    mockDispatchPush.mockRejectedValueOnce(new Error('worker down'));

    await expect(
      scheduleSecurityNotice(user, { type: 'browser_sessions_revoked' }, REQUEST)
    ).resolves.toBeUndefined();
    expect(jest.mocked(email.sendBrowserSessionsRevokedEmail)).toHaveBeenCalledTimes(1);
  });

  it('names an unknown sign-in method generically', async () => {
    await scheduleSecurityNotice(
      user,
      { type: 'new_sign_in', method: 'carrier-pigeon', deviceKeyHash: 'a', networkKeyHash: 'b' },
      REQUEST
    );

    expect(mockSendNewSignIn).toHaveBeenCalledWith(user.google_user_email, null, EXPECTED_DETAILS);
  });

  it('sends the push without a device or location the request did not carry', async () => {
    await scheduleSecurityNotice(
      user,
      { type: 'api_key_reset' },
      {
        occurredAt: new Date(),
        ip: null,
        location: null,
        device: '   ',
      }
    );

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ device: null, location: null })
    );
  });
});

describe('securityNoticeRequestFromHeaders', () => {
  it('reads the address, approximate location and browser from the request', () => {
    const occurredAt = new Date('2026-01-01T00:00:00.000Z');
    const headers = new Headers({
      'x-vercel-forwarded-for': '203.0.113.7',
      'x-vercel-ip-city': 'San%20Francisco',
      'x-vercel-ip-country': 'US',
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    });

    expect(securityNoticeRequestFromHeaders(headers, occurredAt)).toEqual({
      occurredAt,
      ip: '203.0.113.7',
      location: 'San Francisco, US',
      device: 'Chrome on macOS',
    });
  });
});
