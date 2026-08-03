import { NextRequest } from 'next/server';
import { APP_URL } from '@/lib/constants';

jest.mock('next/headers', () => ({
  headers: jest.fn().mockResolvedValue(new Headers()),
}));

jest.mock('@/lib/device-auth/device-auth');

import { createDeviceAuthRequest } from '@/lib/device-auth/device-auth';
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
});
