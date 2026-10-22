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

  test('returns code as the poll secret plus user_code, device_code, verificationUrl, and expiresIn', async () => {
    const expiresAt = new Date(Date.now() + 600_000);
    mockCreate.mockResolvedValue({
      code: 'poll-secret-value-for-the-requesting-client',
      userCode: 'ABCD-EFGH',
      deviceCode: 'base64url-device-secret',
      expiresAt,
    });

    const req = new NextRequest('http://localhost:3000/api/device-auth/codes', {
      method: 'POST',
    });

    const response = await POST(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.code).toBe('poll-secret-value-for-the-requesting-client');
    expect(data.user_code).toBe('ABCD-EFGH');
    expect(data.device_code).toBe('base64url-device-secret');
    expect(data.verificationUrl).toContain('/device-auth');
    expect(data.verificationUrl).toContain('ABCD-EFGH');
    // Neither secret may appear in the verification URL.
    expect(data.verificationUrl).not.toContain('base64url-device-secret');
    expect(data.verificationUrl).not.toContain('poll-secret-value-for-the-requesting-client');
    expect(data.expiresIn).toBeGreaterThan(0);
    expect(data.expiresIn).toBeLessThanOrEqual(600);
  });

  test('verificationUrl uses the user code, never the poll secret', async () => {
    const expiresAt = new Date(Date.now() + 600_000);
    mockCreate.mockResolvedValue({
      code: 'poll-secret-value-for-the-requesting-client',
      userCode: 'WXYZ-1234',
      deviceCode: 'super-long-secret-that-should-not-leak',
      expiresAt,
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
});
