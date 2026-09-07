import { APP_URL } from '@/lib/constants';
import { NextResponse } from 'next/server';
import { failureResult } from '@/lib/maybe-result';
import { defineTestUser } from '@/tests/helpers/user.helper';

jest.mock('@/lib/user/server', () => ({
  getUserFromSessionForCredentialIssuance: jest.fn(),
}));
jest.mock('@/lib/device-auth/device-auth', () => ({
  approveDeviceAuthRequest: jest.fn(),
}));

import { approveDeviceAuthRequest } from '@/lib/device-auth/device-auth';
import { getUserFromSessionForCredentialIssuance } from '@/lib/user/server';
import { POST } from './route';

const mockApprove = jest.mocked(approveDeviceAuthRequest);
const mockGetUserFromSession = jest.mocked(getUserFromSessionForCredentialIssuance);

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
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1');
  });

  it.each([
    {
      message: 'Device authorization request not found',
      status: 404,
      error: 'Not found',
    },
    {
      message: 'Device authorization request is not pending',
      status: 409,
      error: 'Device authorization request can no longer be approved',
    },
    {
      message: 'Device authorization request has expired',
      status: 410,
      error: 'Device authorization request has expired',
    },
  ])('returns $status when approval fails with "$message"', async ({ message, status, error }) => {
    mockGetUserFromSession.mockResolvedValue({
      user: defineTestUser({ id: 'user-1' }),
      authFailedResponse: null,
    });
    mockApprove.mockRejectedValueOnce(new Error(message));

    const response = await POST(
      createRequest(JSON.stringify({ code: 'ABCD-EFGH' }), sessionHeaders)
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(mockApprove).toHaveBeenCalledWith('ABCD-EFGH', 'user-1');
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
