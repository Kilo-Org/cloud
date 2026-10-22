import { NextRequest } from 'next/server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';

jest.mock('next/headers', () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

jest.mock('@/lib/device-auth/device-auth', () => {
  const actual = jest.requireActual('@/lib/device-auth/device-auth');
  return {
    ...actual,
    createDeviceAuthRequest: jest.fn(),
  };
});

import {
  createDeviceAuthRequest,
  DeviceAuthPendingLimitError,
  DEVICE_AUTH_PENDING_LIMIT_MESSAGE,
} from '@/lib/device-auth/device-auth';
import { POST } from './route';

const mockCreate = jest.mocked(createDeviceAuthRequest);

describe('POST /api/device-auth/codes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns code, user_code, device_code, verificationUrl, and expiresIn', async () => {
    const expiresAt = new Date(Date.now() + 600_000);
    mockCreate.mockResolvedValue({
      code: 'ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      deviceCode: 'base64url-device-secret',
      expiresAt,
      requestingClient: null,
    });

    const req = new NextRequest('http://localhost:3000/api/device-auth/codes', {
      method: 'POST',
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.code).toBe('ABCD-EFGH');
    expect(data.user_code).toBe('ABCD-EFGH');
    expect(data.device_code).toBe('base64url-device-secret');
    expect(data.verificationUrl).toContain('/device-auth');
    expect(data.verificationUrl).toContain('ABCD-EFGH');
    // The device secret must never appear in a URL.
    expect(data.verificationUrl).not.toContain('base64url-device-secret');
    expect(data.expiresIn).toBeGreaterThan(0);
    expect(data.expiresIn).toBeLessThanOrEqual(600);
  });

  test('verificationUrl uses the user code, never the device secret', async () => {
    const expiresAt = new Date(Date.now() + 600_000);
    mockCreate.mockResolvedValue({
      code: 'WXYZ-1234',
      userCode: 'WXYZ-1234',
      deviceCode: 'super-long-secret-that-should-not-leak',
      expiresAt,
      requestingClient: null,
    });

    const req = new NextRequest('http://localhost:3000/api/device-auth/codes', {
      method: 'POST',
    });

    const response = await POST(req);
    const data = await response.json();

    // The URL contains only the 9-char user code, never the 43+ char device secret.
    expect(data.verificationUrl).toMatch(/code=WXYZ-1234/);
    expect(data.verificationUrl).not.toContain('super-long-secret-that-should-not-leak');
    expect(data.verificationUrl).toEqual(
      expect.stringContaining(`${APP_URL}/device-auth?code=WXYZ-1234`)
    );
  });

  test('returns 429 with non-empty message when pending limit is hit', async () => {
    mockCreate.mockRejectedValue(new DeviceAuthPendingLimitError());

    const req = new NextRequest('http://localhost:3000/api/device-auth/codes', {
      method: 'POST',
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(429);
    expect(data.error).toBe(DEVICE_AUTH_PENDING_LIMIT_MESSAGE);
    expect(data.error.length).toBeGreaterThan(0);
  });

  test('re-throws unexpected errors to the global 500 handler', async () => {
    mockCreate.mockRejectedValue(new Error('unexpected'));

    const req = new NextRequest('http://localhost:3000/api/device-auth/codes', {
      method: 'POST',
    });

    await expect(POST(req)).rejects.toThrow('unexpected');
  });

  test('stores the requesting client named by the body and echoes it', async () => {
    const requestingClient = {
      clientId: 'client-abc',
      clientName: 'Claude Desktop',
      redirectOrigin: 'https://client.test',
    };
    mockCreate.mockResolvedValue({
      code: 'ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 600_000),
      requestingClient,
    });

    const req = new NextRequest('http://localhost:3000/api/device-auth/codes', {
      method: 'POST',
      body: JSON.stringify({
        requesting_client: {
          client_id: 'client-abc',
          client_name: 'Claude Desktop',
          redirect_origin: 'https://client.test',
        },
      }),
      headers: { 'Content-Type': 'application/json' },
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ requestingClient }));
    expect(data.requestingClient).toEqual(requestingClient);
  });

  test('opens a plain pairing for a body that names no client', async () => {
    mockCreate.mockResolvedValue({
      code: 'ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 600_000),
      requestingClient: null,
    });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/device-auth/codes', { method: 'POST' })
    );

    expect(response.status).toBe(200);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.not.objectContaining({ requestingClient: expect.anything() })
    );
    expect((await response.json()).requestingClient).toBeNull();
  });

  test.each([
    [
      'an empty client id',
      { client_id: '', client_name: 'Acme', redirect_origin: 'https://a.test' },
    ],
    [
      'a control character in the name',
      { client_id: 'client-abc', client_name: 'Acme\u0007', redirect_origin: 'https://a.test' },
    ],
    [
      'an oversized redirect origin',
      {
        client_id: 'client-abc',
        client_name: 'Acme',
        redirect_origin: `https://${'a'.repeat(300)}`,
      },
    ],
    [
      'a redirect origin with a path',
      { client_id: 'client-abc', client_name: 'Acme', redirect_origin: 'https://a.test/cb' },
    ],
    [
      'a relative redirect origin',
      { client_id: 'client-abc', client_name: 'Acme', redirect_origin: '/cb' },
    ],
    [
      'a redirect origin that is prose',
      { client_id: 'client-abc', client_name: 'Acme', redirect_origin: 'the trusted app' },
    ],
    [
      'a bare web scheme',
      { client_id: 'client-abc', client_name: 'Acme', redirect_origin: 'https:' },
    ],
    [
      'a bare script scheme',
      { client_id: 'client-abc', client_name: 'Acme', redirect_origin: 'javascript:' },
    ],
  ])('refuses a client description with %s', async (_label, requesting_client) => {
    const response = await POST(
      new NextRequest('http://localhost:3000/api/device-auth/codes', {
        method: 'POST',
        body: JSON.stringify({ requesting_client }),
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(response.status).toBe(400);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test('accepts a native app scheme as the redirect origin', async () => {
    const requestingClient = {
      clientId: 'client-abc',
      clientName: 'Example App',
      redirectOrigin: 'cursor://anysphere.cursor',
    };
    mockCreate.mockResolvedValue({
      code: 'ABCD-EFGH',
      userCode: 'ABCD-EFGH',
      deviceCode: 'device-secret',
      expiresAt: new Date(Date.now() + 600_000),
      requestingClient,
    });

    const response = await POST(
      new NextRequest('http://localhost:3000/api/device-auth/codes', {
        method: 'POST',
        body: JSON.stringify({
          requesting_client: {
            client_id: 'client-abc',
            client_name: 'Example App',
            redirect_origin: 'cursor://anysphere.cursor',
          },
        }),
        headers: { 'Content-Type': 'application/json' },
      })
    );

    expect(response.status).toBe(200);
    expect((await response.json()).requestingClient).toEqual(requestingClient);
  });
});
