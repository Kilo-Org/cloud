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
  sendDeviceSessionRevokedEmail: jest.fn(async () => ({ sent: true })),
  sendSignInResetBySupportEmail: jest.fn(async () => ({ sent: true })),
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
import type { SecurityNoticeRequest } from '@kilocode/web-shared/lib/email';
import { internalDispatchRequestSchema } from '@kilocode/notifications/schemas';
import { dispatchAccountSecurityPush } from '@kilocode/web-shared/lib/notifications-worker-client';
import {
  deleteTransactionalEmailLogForUsers,
  insertTestUser,
} from '@kilocode/web-shared/tests/helpers/user.helper';

import {
  scheduleSecurityNotice,
  securityNoticeRequestFromHeaders,
  supportSecurityNoticeRequest,
  type SecurityNoticeEvent,
} from './index';

const mockCaptureException = jest.mocked(captureException);
const mockDispatchPush = jest.mocked(dispatchAccountSecurityPush);
const mockSendPasskeyAdded = jest.mocked(email.sendPasskeyAddedEmail);
const mockSendApiKeyReset = jest.mocked(email.sendApiKeyResetEmail);
const mockSendBrowserSessionsRevoked = jest.mocked(email.sendBrowserSessionsRevokedEmail);
const mockSendRemoved = jest.mocked(email.sendSignInMethodRemovedEmail);
const mockSendNewSignIn = jest.mocked(email.sendNewSignInEmail);

const REQUEST: SecurityNoticeRequest = {
  actor: 'owner',
  occurredAt: new Date('2026-03-04T05:06:07.000Z'),
  ip: '203.0.113.7',
  location: 'Berlin, DE',
  device: 'Firefox on Linux',
};

const OWNER_ORIGIN = { actor: 'owner', device: 'Firefox on Linux', location: 'Berlin, DE' };

const createdUserIds: string[] = [];
let user: User;

beforeEach(async () => {
  jest.clearAllMocks();
  user = await insertTestUser();
  createdUserIds.push(user.id);
});

// The notices this suite sends leave outbox rows that reference its users; a
// later suite in the same worker that deletes every user would hit them. The
// rows go after each test, while the database connection is still open.
afterEach(async () => {
  await deleteTransactionalEmailLogForUsers(createdUserIds.splice(0));
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

function at(iso: string): SecurityNoticeRequest {
  return { ...REQUEST, occurredAt: new Date(iso) };
}

const EVENTS: Array<[SecurityNoticeEvent, unknown, unknown[]]> = [
  [
    { type: 'passkey_added', passkeyId: 'pk-1', passkeyName: 'Laptop' },
    jest.mocked(email.sendPasskeyAddedEmail),
    ['Laptop', REQUEST],
  ],
  [
    { type: 'passkey_removed', passkeyId: 'pk-1', passkeyName: null },
    jest.mocked(email.sendPasskeyRemovedEmail),
    [null, REQUEST],
  ],
  [
    {
      type: 'sign_in_method_linked',
      provider: 'github',
      linkedIdentity: { email: 'octo@example.net', displayName: null },
      linkedAt: new Date('2026-03-04T05:06:07.000Z'),
    },
    jest.mocked(email.sendNewSignInMethodEmail),
    ['GitHub', { email: 'octo@example.net', displayName: null }, null, REQUEST],
  ],
  [
    { type: 'sign_in_method_unlinked', provider: 'github', actingSessionId: 'web-session-1' },
    jest.mocked(email.sendSignInMethodRemovedEmail),
    ['GitHub', REQUEST],
  ],
  [
    { type: 'api_key_reset', actingSessionId: 'web-session-1' },
    jest.mocked(email.sendApiKeyResetEmail),
    [REQUEST],
  ],
  [
    { type: 'browser_sessions_revoked', actingSessionId: 'web-session-1' },
    jest.mocked(email.sendBrowserSessionsRevokedEmail),
    [REQUEST],
  ],
  [
    {
      type: 'device_session_revoked',
      deviceSessionId: 'device-session-1',
      revokedDevice: 'Kilo CLI',
    },
    jest.mocked(email.sendDeviceSessionRevokedEmail),
    ['Kilo CLI', REQUEST],
  ],
  [
    { type: 'new_sign_in', method: 'google' },
    jest.mocked(email.sendNewSignInEmail),
    ['Google', REQUEST],
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
      origin: OWNER_ORIGIN,
    });
    expect(await noticeRows(user.id)).toHaveLength(1);
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it('describes the signed-in device in a device approval push, never the approving browser', async () => {
    await scheduleSecurityNotice(
      user,
      {
        type: 'device_sign_in_approved',
        deviceAuthRequestId: 'request-1',
        requester: { kind: 'recognised', label: 'Kilo CLI' },
        requestIp: '198.51.100.24',
      },
      REQUEST
    );

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { actor: 'owner', device: 'Kilo CLI', location: null } })
    );
    // The email keeps the requesting device apart from where it was approved.
    expect(jest.mocked(email.sendDeviceSignInApprovedEmail)).toHaveBeenCalledWith(
      user.google_user_email,
      { client: { kind: 'recognised', label: 'Kilo CLI' }, ip: '198.51.100.24' },
      REQUEST
    );
  });

  it('names the sign-in methods an SSO link replaced in its email', async () => {
    await scheduleSecurityNotice(
      user,
      {
        type: 'sign_in_method_linked',
        provider: 'workos',
        linkedIdentity: { email: 'owner@example.com', displayName: null },
        linkedAt: new Date('2026-03-04T05:06:07.000Z'),
        replacedProviders: ['github', 'google'],
      },
      REQUEST
    );

    expect(jest.mocked(email.sendNewSignInMethodEmail)).toHaveBeenCalledWith(
      user.google_user_email,
      'Enterprise SSO',
      { email: 'owner@example.com', displayName: null },
      ['GitHub', 'Google'],
      REQUEST
    );
    expect(mockDispatchPush).toHaveBeenCalledTimes(1);
    expect(await noticeRows(user.id)).toHaveLength(1);
  });

  it('attributes a name the requesting device chose in the approval push, cut short', async () => {
    await scheduleSecurityNotice(
      user,
      {
        type: 'device_sign_in_approved',
        deviceAuthRequestId: 'request-2',
        requester: { kind: 'self_named', name: `Kilo security check ${'x'.repeat(100)}` },
        requestIp: null,
      },
      REQUEST
    );

    const [[push]] = mockDispatchPush.mock.calls;
    expect(push?.origin).toEqual({
      actor: 'self_named_device',
      name: `Kilo security check ${'x'.repeat(20)}…`,
    });
  });

  it('replaces a quote mark in a name the requesting device chose', async () => {
    await scheduleSecurityNotice(
      user,
      {
        type: 'device_sign_in_approved',
        deviceAuthRequestId: 'request-3',
        requester: { kind: 'self_named', name: 'Kilo CLI" verified by “Kilo”' },
        requestIp: null,
      },
      REQUEST
    );

    const [[push]] = mockDispatchPush.mock.calls;
    expect(push?.origin).toEqual({
      actor: 'self_named_device',
      name: "Kilo CLI' verified by 'Kilo'",
    });
    // The worker's schema accepts the request as sent.
    expect(
      internalDispatchRequestSchema.safeParse({ kind: 'account_security', ...push }).success
    ).toBe(true);
  });

  it('names Kilo support and nothing about the staff member for a support action', async () => {
    const supportRequest = supportSecurityNoticeRequest(new Date('2026-03-04T05:06:07.000Z'));

    await scheduleSecurityNotice(
      user,
      { type: 'sign_in_reset_by_support', actingSessionId: 'admin-session-1' },
      supportRequest
    );

    expect(jest.mocked(email.sendSignInResetBySupportEmail)).toHaveBeenCalledWith(
      user.google_user_email,
      { actor: 'support', occurredAt: new Date('2026-03-04T05:06:07.000Z') }
    );
    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'sign_in_reset_by_support', origin: { actor: 'support' } })
    );
  });

  it('keeps the linked identity out of the idempotency key', async () => {
    await scheduleSecurityNotice(
      user,
      {
        type: 'sign_in_method_linked',
        provider: 'email',
        linkedIdentity: { email: 'linked-secret@example.net' },
        linkedAt: new Date(),
      },
      REQUEST
    );

    const [row] = await noticeRows(user.id);
    expect(row?.key).not.toContain('linked-secret');
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

  it('treats repeated resets by one session inside ten minutes as one notice, and a later one as new', async () => {
    const reset: SecurityNoticeEvent = { type: 'api_key_reset', actingSessionId: 'web-session-a' };
    await scheduleSecurityNotice(user, reset, at('2026-03-04T05:01:00.000Z'));
    await scheduleSecurityNotice(user, reset, at('2026-03-04T05:09:00.000Z'));
    await scheduleSecurityNotice(user, reset, at('2026-03-04T05:11:00.000Z'));

    expect(mockSendApiKeyReset).toHaveBeenCalledTimes(2);
    expect(mockDispatchPush).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ type: 'api_key_reset' } as const, mockSendApiKeyReset],
    [{ type: 'browser_sessions_revoked' } as const, mockSendBrowserSessionsRevoked],
  ])(
    'sends a second %o notice for another session inside the same window',
    async (event, sender) => {
      await scheduleSecurityNotice(
        user,
        { ...event, actingSessionId: 'web-session-owner' },
        at('2026-03-04T05:01:00.000Z')
      );
      await scheduleSecurityNotice(
        user,
        { ...event, actingSessionId: 'web-session-other' },
        at('2026-03-04T05:02:00.000Z')
      );

      expect(sender).toHaveBeenCalledTimes(2);
      expect(await noticeRows(user.id)).toHaveLength(2);
    }
  );

  it('keys an unlink on the session: a repeat is one notice, another session is a new one', async () => {
    const unlink = (actingSessionId: string): SecurityNoticeEvent => ({
      type: 'sign_in_method_unlinked',
      provider: 'github',
      actingSessionId,
    });
    await scheduleSecurityNotice(user, unlink('web-session-a'), at('2026-03-04T05:01:10.000Z'));
    await scheduleSecurityNotice(user, unlink('web-session-a'), at('2026-03-04T05:01:20.000Z'));
    await scheduleSecurityNotice(user, unlink('web-session-b'), at('2026-03-04T05:01:30.000Z'));

    expect(mockSendRemoved).toHaveBeenCalledTimes(2);
  });

  it('treats each reset from a request with no session as its own notice', async () => {
    await scheduleSecurityNotice(
      user,
      { type: 'api_key_reset', actingSessionId: null },
      at('2026-03-04T05:01:00.000Z')
    );
    await scheduleSecurityNotice(
      user,
      { type: 'api_key_reset', actingSessionId: null },
      at('2026-03-04T05:02:00.000Z')
    );

    expect(mockSendApiKeyReset).toHaveBeenCalledTimes(2);
  });

  it('allows one new-sign-in notice per hour bucket, and a later one an hour after the cap claim', async () => {
    const newSignIn: SecurityNoticeEvent = { type: 'new_sign_in', method: 'google' };
    await scheduleSecurityNotice(user, newSignIn, at('2026-03-04T05:30:00.000Z'));
    await scheduleSecurityNotice(user, newSignIn, at('2026-03-04T05:59:00.000Z'));
    // The sign-in check's cap allows the next notice an hour after the last
    // one; that time is always in the next bucket.
    await scheduleSecurityNotice(user, newSignIn, at('2026-03-04T06:30:00.000Z'));

    expect(mockSendNewSignIn).toHaveBeenCalledTimes(2);
    expect(await noticeRows(user.id)).toHaveLength(2);
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
    expect(await noticeRows(user.id)).toHaveLength(0);

    await scheduleSecurityNotice(user, event, REQUEST);
    expect(mockSendPasskeyAdded).toHaveBeenCalledTimes(2);
  });

  it('reports a failure to Sentry as a fixed error with only the event type, never the error itself', async () => {
    mockSendPasskeyAdded.mockRejectedValueOnce(
      new Error(`Failed query: insert params: ${user.id},security_notice`)
    );

    await scheduleSecurityNotice(
      user,
      { type: 'passkey_added', passkeyId: 'pk-4', passkeyName: null },
      REQUEST
    );

    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    const [[reported, context]] = mockCaptureException.mock.calls;
    expect(reported).toEqual(new Error('security_notice_failed'));
    expect(context).toEqual({ tags: { security_notice: 'passkey_added' } });
    expect(JSON.stringify(mockCaptureException.mock.calls)).not.toContain(user.id);
  });

  it('keeps the claim when the email will not send on a retry either', async () => {
    mockSendApiKeyReset.mockResolvedValueOnce({ sent: false, reason: 'neverbounce_rejected' });

    await scheduleSecurityNotice(user, { type: 'api_key_reset', actingSessionId: 's' }, REQUEST);

    expect(mockCaptureException).toHaveBeenCalledWith(new Error('security_notice_email_not_sent'), {
      tags: { security_notice: 'api_key_reset' },
      extra: { reason: 'neverbounce_rejected' },
    });
    expect(await noticeRows(user.id)).toHaveLength(1);
  });

  it('never throws when the push dispatch fails, and still sends the email', async () => {
    mockDispatchPush.mockRejectedValueOnce(new Error('worker down'));

    await expect(
      scheduleSecurityNotice(
        user,
        { type: 'browser_sessions_revoked', actingSessionId: 's' },
        REQUEST
      )
    ).resolves.toBeUndefined();
    expect(mockSendBrowserSessionsRevoked).toHaveBeenCalledTimes(1);
  });

  it('names an unknown sign-in method generically', async () => {
    await scheduleSecurityNotice(user, { type: 'new_sign_in', method: 'carrier-pigeon' }, REQUEST);

    expect(mockSendNewSignIn).toHaveBeenCalledWith(user.google_user_email, null, REQUEST);
  });

  it('sends the push without a device or location the request did not carry', async () => {
    await scheduleSecurityNotice(
      user,
      { type: 'api_key_reset', actingSessionId: 's' },
      { actor: 'owner', occurredAt: new Date(), ip: null, location: null, device: '   ' }
    );

    expect(mockDispatchPush).toHaveBeenCalledWith(
      expect.objectContaining({ origin: { actor: 'owner', device: null, location: null } })
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
      actor: 'owner',
      occurredAt,
      ip: '203.0.113.7',
      location: 'San Francisco, US',
      device: 'Chrome on macOS',
    });
  });
});
