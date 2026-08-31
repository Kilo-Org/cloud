const mockHeaders = jest.fn<Promise<Headers>, []>();
const mockGetServerSession = jest.fn();
const mockApproveDeviceAuthRequest = jest.fn();

jest.mock('next/headers', () => ({
  headers: () => mockHeaders(),
  cookies: jest.fn(),
}));

jest.mock('next-auth', () => ({
  __esModule: true,
  ...jest.requireActual('next-auth'),
  getServerSession: (...args: unknown[]) => mockGetServerSession(...args),
}));

jest.mock('@/lib/device-auth/device-auth', () => ({
  approveDeviceAuthRequest: (...args: unknown[]) => mockApproveDeviceAuthRequest(...args),
}));

import { POST } from './route';
import { APP_URL } from '@/lib/constants';
import { generateApiToken } from '@/lib/tokens';
import { insertTestUser } from '@/tests/helpers/user.helper';

function createRequest(headers: Record<string, string> = {}) {
  return new Request(`${APP_URL}/api/device-auth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: new URL(APP_URL).origin, ...headers },
    body: JSON.stringify({ code: 'ABCD-EFGH' }),
  });
}

describe('POST /api/device-auth/tokens integration', () => {
  beforeEach(() => {
    mockHeaders.mockReset();
    mockGetServerSession.mockReset();
    mockApproveDeviceAuthRequest.mockReset();
  });

  test('approves with a valid same-origin current session', async () => {
    const user = await insertTestUser({ web_session_pepper: 'current-session-pepper' });
    mockHeaders.mockResolvedValue(new Headers({ Cookie: 'next-auth.session-token=valid-cookie' }));
    mockGetServerSession.mockResolvedValue({
      kiloUserId: user.id,
      webSessionPepper: user.web_session_pepper,
    });
    mockApproveDeviceAuthRequest.mockResolvedValue(undefined);

    const response = await POST(createRequest({ Cookie: 'next-auth.session-token=valid-cookie' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(mockApproveDeviceAuthRequest).toHaveBeenCalledWith('ABCD-EFGH', user.id);
  });

  test.each(['valid bearer', 'empty authorization'])(
    'never approves with %s and a cookie',
    async kind => {
      const user = await insertTestUser({ api_token_pepper: crypto.randomUUID() });
      const authorization = kind === 'valid bearer' ? `Bearer ${generateApiToken(user)}` : '';
      mockHeaders.mockResolvedValue(
        new Headers({
          Authorization: authorization,
          Cookie: 'next-auth.session-token=valid-cookie',
        })
      );
      mockGetServerSession.mockResolvedValue({ kiloUserId: user.id, webSessionPepper: null });

      const response = await POST(createRequest({ Authorization: authorization }));

      expect(response.status).toBe(401);
      expect(mockGetServerSession).not.toHaveBeenCalled();
      expect(mockApproveDeviceAuthRequest).not.toHaveBeenCalled();
    }
  );
});
