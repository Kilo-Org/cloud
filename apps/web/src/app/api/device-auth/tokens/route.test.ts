import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { NextResponse } from 'next/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import { defineTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

jest.mock('@kilocode/web-shared/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@/lib/device-auth/device-auth', () => {
  const actual = jest.requireActual('@/lib/device-auth/device-auth');
  return { ...actual, approveDeviceAuthRequest: jest.fn() };
});
jest.mock('@/lib/security-notices', () => ({
  ...jest.requireActual('@/lib/security-notices'),
  scheduleSecurityNotice: jest.fn(),
}));
import {
  approveDeviceAuthRequest,
  DEVICE_AUTH_REFUSAL_CODES,
  DeviceAuthRefusalError,
  refusalCopyFor,
} from '@/lib/device-auth/device-auth';
import { scheduleSecurityNotice } from '@/lib/security-notices';
import { getUserFromSessionForCredentialIssuance } from '@kilocode/web-shared/lib/user/server';
import { POST } from './route';

const mockApprove = jest.mocked(approveDeviceAuthRequest);
const mockGetUserFromSession = jest.mocked(getUserFromSessionForCredentialIssuance);
const mockScheduleSecurityNotice = jest.mocked(scheduleSecurityNotice);

describe('POST /api/device-auth/tokens', () => {
  const createRequest = (body: string, headers: Record<string, string> = {}) =>
    new Request('http://localhost:3000/api/device-auth/tokens', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/json', ...headers },
    });

  const sessionHeaders = { Origin: new URL(APP_URL).origin };

  beforeEach(() => {
    jest.clearAllMocks();
    mockApprove.mockResolvedValue({
      id: 'request-1',
      requestingClientName: null,
      userAgent: 'Kilo-Code/1.2.3',
      ipAddress: '198.51.100.24',
    });
  });

  it('approves a valid code for an authenticated same-origin session', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1', {});
  });

  it('sends one approval notice naming the requesting device, not the approver', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });

    await POST(createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders));

    expect(mockScheduleSecurityNotice).toHaveBeenCalledTimes(1);
    expect(mockScheduleSecurityNotice).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'user-1' }),
      {
        type: 'device_sign_in_approved',
        deviceAuthRequestId: 'request-1',
        clientLabel: 'Kilo CLI',
        requestIp: '198.51.100.24',
      },
      expect.objectContaining({ occurredAt: expect.any(Date) })
    );
  });

  it('sends no notice when the approval is refused', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });
    mockApprove.mockRejectedValueOnce(
      new DeviceAuthRefusalError(DEVICE_AUTH_REFUSAL_CODES.requestNotPending)
    );

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(409);
    expect(mockScheduleSecurityNotice).not.toHaveBeenCalled();
  });

  it('passes the confirmed client to the approval', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });

    const response = await POST(
      createRequest(
        JSON.stringify({ code: 'ABCD-EFGH', confirmed_client_id: 'client-abc' }),
        sessionHeaders
      )
    );

    expect(response.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1', {
      confirmedClientId: 'client-abc',
    });
  });

  it('passes the pending link choice to the approval', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH', add_pending_link: false }), sessionHeaders)
    );

    expect(response.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1', { addPendingLink: false });
  });

  it('passes the emailed code and the approving browser session when it adds the pending link', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1', google_user_email: 'owner@example.com' }),
      authFailedResponse: null,
      webSessionId: 'web-session-1',
    });

    const response = await POST(
      createRequest(
        JSON.stringify({
          code: 'ABCD-EFGH',
          add_pending_link: true,
          pending_link_code: '123456',
          pending_link_challenge_id: '00000000-0000-4000-8000-000000000009',
        }),
        sessionHeaders
      )
    );

    expect(response.status).toBe(200);
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1', {
      addPendingLink: true,
      pendingLinkProof: {
        email: 'owner@example.com',
        webSessionId: 'web-session-1',
        code: '123456',
        challengeId: '00000000-0000-4000-8000-000000000009',
      },
    });
  });

  it('passes a proof without a code when it adds the pending link without one', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1', google_user_email: 'owner@example.com' }),
      authFailedResponse: null,
    });

    await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH', add_pending_link: true }), sessionHeaders)
    );

    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1', {
      addPendingLink: true,
      pendingLinkProof: { email: 'owner@example.com', webSessionId: undefined },
    });
  });

  it('answers 409 when the approval omits the pending link choice', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });
    mockApprove.mockRejectedValueOnce(
      new DeviceAuthRefusalError(DEVICE_AUTH_REFUSAL_CODES.pendingLinkChoiceRequired)
    );

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: DEVICE_AUTH_REFUSAL_CODES.pendingLinkChoiceRequired,
      message: refusalCopyFor(DEVICE_AUTH_REFUSAL_CODES.pendingLinkChoiceRequired),
    });
  });

  it('answers 409 when the approval does not confirm the client it names', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });
    mockApprove.mockRejectedValueOnce(
      new DeviceAuthRefusalError(DEVICE_AUTH_REFUSAL_CODES.clientConfirmationMismatch)
    );

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: DEVICE_AUTH_REFUSAL_CODES.clientConfirmationMismatch,
      message: refusalCopyFor(DEVICE_AUTH_REFUSAL_CODES.clientConfirmationMismatch),
    });
  });

  it.each([
    {
      code: DEVICE_AUTH_REFUSAL_CODES.requestNotFound,
      status: 404,
    },
    {
      code: DEVICE_AUTH_REFUSAL_CODES.requestNotPending,
      status: 409,
    },
    {
      code: DEVICE_AUTH_REFUSAL_CODES.requestExpired,
      status: 410,
    },
    {
      code: DEVICE_AUTH_REFUSAL_CODES.pendingLinkCodeInvalid,
      status: 400,
    },
    {
      code: DEVICE_AUTH_REFUSAL_CODES.pendingLinkCodeLocked,
      status: 429,
    },
    {
      code: DEVICE_AUTH_REFUSAL_CODES.pendingLinkReauthRequired,
      status: 403,
    },
  ])('returns $status when the approval refuses with $code', async ({ code, status }) => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });
    mockApprove.mockRejectedValueOnce(new DeviceAuthRefusalError(code));

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code, message: refusalCopyFor(code) });
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1', {});
  });

  it.each([new Error('Database unavailable'), 'Unexpected rejection'])(
    'rethrows unexpected approval failures: %s',
    async error => {
      mockGetUserFromSession.mockResolvedValue({
        user: defineTestUser({ id: 'user-1' }),
        authFailedResponse: null,
      });
      mockApprove.mockRejectedValueOnce(error);

      await expect(
        POST(createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders))
      ).rejects.toBe(error);
    }
  );

  it.each([undefined, 'https://evil.example'])(
    'rejects a %s origin before authenticating',
    async origin => {
      const headers: Record<string, string> = origin ? { Origin: origin } : {};

      const response = await POST(createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), headers));

      expect(response.status).toBe(403);
      expect(mockGetUserFromSession).not.toHaveBeenCalled();
      expect(mockApprove).not.toHaveBeenCalled();
    }
  );

  it('returns the session authentication failure without approving', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    });

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(401);
    expect(mockApprove).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload without approving', async () => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });

    const response = await POST(createRequest('{', sessionHeaders));

    expect(response.status).toBe(400);
    expect(mockApprove).not.toHaveBeenCalled();
  });
});
