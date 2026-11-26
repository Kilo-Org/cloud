import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
  getUserFromAuth: jest.fn(),
}));
jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(async () => ({ rateLimited: false })),
}));

import { and, eq } from 'drizzle-orm';
import { checkRateLimit } from '@vercel/firewall';
import { auth_audit_logs, device_auth_requests, type User } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  getUserFromAuth,
  getUserFromSessionForCredentialIssuance,
} from '@kilocode/web-shared/lib/user/server';
import { createDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { createDeviceAuthViewerToken } from '@/lib/device-auth/device-auth-viewer-token';
import { setAuthActionSinkForTest, type AuthActionEvent } from '@/lib/auth/auth-audit';
import { POST as approve } from './tokens/route';
import { DELETE as denyOrCancel } from './codes/[code]/route';
import { POST as redeem } from './token/route';

const mockSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockAuth = jest.mocked(getUserFromAuth);

let events: AuthActionEvent[];

beforeEach(() => {
  events = [];
  setAuthActionSinkForTest(event => events.push(event));
});

afterEach(() => {
  setAuthActionSinkForTest(null);
});

async function signedInUser(): Promise<User> {
  const user = await insertTestUser({
    google_user_email: `device-audit-${crypto.randomUUID()}@example.com`,
  });
  mockSession.mockResolvedValue({ user, authFailedResponse: null } as never);
  mockAuth.mockResolvedValue({ user, authFailedResponse: null } as never);
  return user;
}

function approveRequest(code: string) {
  return new Request(`${APP_URL}/api/device-auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(APP_URL).origin },
    body: JSON.stringify({ code }),
  });
}

async function authRowsFor(userId: string) {
  return db.select().from(auth_audit_logs).where(eq(auth_audit_logs.user_id, userId));
}

/** The row id of a stored pairing, which the audit row names. */
async function requestRowId(userCode: string) {
  const [row] = await db
    .select({ id: device_auth_requests.id })
    .from(device_auth_requests)
    .where(eq(device_auth_requests.user_code, userCode));
  return row?.id;
}

describe('device authorization audit rows', () => {
  it('records an approval with the request id and none of its secrets', async () => {
    const user = await signedInUser();
    const pairing = await createDeviceAuthRequest({ ipAddress: '198.51.100.20' });

    const response = await approve(approveRequest(pairing.userCode));

    expect(response.status).toBe(200);
    const rows = await authRowsFor(user.id);
    expect(rows).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.approve',
        outcome: 'success',
        user_id: user.id,
        method: null,
        failure_reason: null,
        metadata: { deviceAuthRequestId: await requestRowId(pairing.userCode) },
      }),
    ]);
    const recorded = JSON.stringify({ rows, events });
    expect(recorded).not.toContain(pairing.userCode);
    expect(recorded).not.toContain(pairing.code);
    expect(recorded).not.toContain(pairing.deviceCode);
  });

  it('records an approval of a code that matches no request as a failure', async () => {
    const user = await signedInUser();

    const response = await approve(approveRequest('ZZZZ-ZZZZ'));

    expect(response.status).toBe(404);
    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.approve',
        outcome: 'failure',
        user_id: user.id,
        failure_reason: 'request_not_found',
        metadata: null,
      }),
    ]);
  });

  it('records a denial with the request id', async () => {
    const user = await signedInUser();
    const pairing = await createDeviceAuthRequest({ ipAddress: '198.51.100.21' });

    const response = await denyOrCancel(
      new Request(`${APP_URL}/api/device-auth/codes/${pairing.userCode}`, {
        method: 'DELETE',
        headers: {
          'x-device-auth-viewer-token': createDeviceAuthViewerToken(pairing.userCode, user.id),
        },
      }),
      { params: Promise.resolve({ code: pairing.userCode }) }
    );

    expect(response.status).toBe(200);
    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.deny',
        outcome: 'success',
        user_id: user.id,
        failure_reason: null,
        metadata: { deviceAuthRequestId: await requestRowId(pairing.userCode) },
      }),
    ]);
  });

  it('records a denial with a viewer token minted for another account as a failure', async () => {
    const user = await signedInUser();
    const pairing = await createDeviceAuthRequest({ ipAddress: '198.51.100.22' });

    const response = await denyOrCancel(
      new Request(`${APP_URL}/api/device-auth/codes/${pairing.userCode}`, {
        method: 'DELETE',
        headers: {
          'x-device-auth-viewer-token': createDeviceAuthViewerToken(
            pairing.userCode,
            'another-user'
          ),
        },
      }),
      { params: Promise.resolve({ code: pairing.userCode }) }
    );

    expect(response.status).toBe(403);
    expect(await authRowsFor(user.id)).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.deny',
        outcome: 'failure',
        user_id: user.id,
        failure_reason: 'viewer_token_user_mismatch',
      }),
    ]);
  });

  it('keeps a redemption refused before it names an account out of the table', async () => {
    const response = await redeem(
      new Request(`${APP_URL}/api/device-auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supportsRefresh: true }),
      })
    );

    expect(response.status).toBe(400);
    expect(
      await db
        .select()
        .from(auth_audit_logs)
        .where(
          and(
            eq(auth_audit_logs.action, 'auth.device_auth.redeem'),
            eq(auth_audit_logs.failure_reason, 'invalid_request')
          )
        )
    ).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.redeem',
        outcome: 'failure',
        userId: null,
        failureReason: 'invalid_request',
        auditLogId: null,
        stored: false,
        persisted: false,
        route: '/api/device-auth/token',
      }),
    ]);
  });

  it('keeps a rate-limited denial by a known account out of the table', async () => {
    const user = await signedInUser();
    const pairing = await createDeviceAuthRequest({ ipAddress: '198.51.100.23' });
    jest.mocked(checkRateLimit).mockResolvedValueOnce({ rateLimited: true } as never);

    const response = await denyOrCancel(
      new Request(`${APP_URL}/api/device-auth/codes/${pairing.userCode}`, {
        method: 'DELETE',
        headers: {
          'x-device-auth-viewer-token': createDeviceAuthViewerToken(pairing.userCode, user.id),
        },
      }),
      { params: Promise.resolve({ code: pairing.userCode }) }
    );

    expect(response.status).toBe(429);
    expect(await authRowsFor(user.id)).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.deny',
        outcome: 'failure',
        userId: user.id,
        failureReason: 'rate_limited',
        stored: false,
        persisted: false,
      }),
    ]);
  });

  /** A cancel by the device itself: the poll secret, no viewer token. */
  function cancelFromDevice(pollSecret: string) {
    return denyOrCancel(
      new Request(`${APP_URL}/api/device-auth/codes/${pollSecret}`, { method: 'DELETE' }),
      { params: Promise.resolve({ code: pollSecret }) }
    );
  }

  async function cancelRows() {
    return db
      .select()
      .from(auth_audit_logs)
      .where(eq(auth_audit_logs.action, 'auth.device_auth.cancel'));
  }

  it('keeps a device cancel out of the table, as one log line, and records nothing for a repeat', async () => {
    const pairing = await createDeviceAuthRequest({ ipAddress: '198.51.100.24' });

    expect((await cancelFromDevice(pairing.code)).status).toBe(200);
    // The request is already cancelled, so a repeat changes nothing.
    expect((await cancelFromDevice(pairing.code)).status).toBe(200);

    expect(await cancelRows()).toEqual([]);
    expect(events).toEqual([
      expect.objectContaining({
        action: 'auth.device_auth.cancel',
        outcome: 'success',
        userId: null,
        stored: false,
        persisted: false,
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain(pairing.code);
  });
});
