import { describe, it, expect, beforeEach } from '@jest/globals';
import { verifyTurnstileJWT } from './verify-turnstile-jwt';
import jwt from 'jsonwebtoken';
import type { TurnstileJwtPayload } from '@/lib/user.server';

// Mock Next.js server functions - must be before imports that use them
// Note: Next.js may show runtime warnings about calling cookies/headers outside request scope,
// but these are expected in test environment and the mocks will work correctly.
const mockCookiesGet = jest.fn();
const mockHeadersGet = jest.fn();

// Mock Next.js headers module - using any for test mocks is acceptable
jest.mock('next/headers', () => {
  return {
    cookies: jest.fn(() =>
      Promise.resolve({
        get: (name: string) => mockCookiesGet(name),
      })
    ),
    headers: jest.fn(() =>
      Promise.resolve({
        get: (name: string) => mockHeadersGet(name),
      })
    ),
  };
});

// Mock config
jest.mock('@/lib/config.server', () => ({
  NEXTAUTH_SECRET: 'test-secret-key-for-testing-purposes-only',
}));

// Mock sentry logger
jest.mock('@/lib/utils.server', () => ({
  sentryLogger: jest.fn(() => jest.fn()),
}));

describe('verifyTurnstileJWT', () => {
  const testIP = '192.168.1.1';
  const testSecret = 'test-secret-key-for-testing-purposes-only';

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should successfully verify valid JWT with matching IP', async () => {
    const payload: TurnstileJwtPayload = {
      guid: '00000000-0000-0000-0000-000000000000' as const,
      ip: testIP,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = jwt.sign(payload, testSecret, { algorithm: 'HS256' });

    mockCookiesGet.mockReturnValue({ value: token });
    mockHeadersGet.mockReturnValue(testIP);

    const result = await verifyTurnstileJWT('test-context');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.token.ip).toBe(testIP);
      expect(result.token.guid).toBe(payload.guid);
    }
  });

  it('should return error when JWT cookie is missing', async () => {
    mockCookiesGet.mockReturnValue(undefined);

    const result = await verifyTurnstileJWT('test-context');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(401);
      const data = await result.response.json();
      expect(data.error).toBe('Security verification required');
    }
  });

  it('should return error for invalid JWT (malformed, expired, or wrong secret)', async () => {
    const invalidToken = 'invalid.jwt.token';

    mockCookiesGet.mockReturnValue({ value: invalidToken });

    const result = await verifyTurnstileJWT('test-context');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(401);
      const data = await result.response.json();
      expect(data.error).toBe('Invalid security verification');
    }
  });

  it('should return error when IP addresses do not match', async () => {
    const payload: TurnstileJwtPayload = {
      guid: '00000000-0000-0000-0000-000000000000' as const,
      ip: testIP,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
    const token = jwt.sign(payload, testSecret, { algorithm: 'HS256' });

    mockCookiesGet.mockReturnValue({ value: token });
    mockHeadersGet.mockReturnValue('10.0.0.1'); // Different IP

    const result = await verifyTurnstileJWT('test-context');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.response.status).toBe(401);
      const data = await result.response.json();
      expect(data.error).toBe('Security verification failed');
    }
  });
});
