import { describe, test, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { TOKEN_EXPIRY, validateAuthorizationHeader, JWT_TOKEN_VERSION } from './tokens';
import { getEnvVariable } from '@/lib/dotenvx';

describe('TOKEN_EXPIRY', () => {
  test('default is five years in seconds', () => {
    const FIVE_YEARS_IN_SECONDS = 5 * 365 * 24 * 60 * 60;
    expect(TOKEN_EXPIRY.default).toBe(FIVE_YEARS_IN_SECONDS);
  });
});

describe('validateAuthorizationHeader (C15 device-session compatibility)', () => {
  test('accepts a signed Bearer JWT carrying deviceSessionId', () => {
    const token = jwt.sign(
      {
        env: process.env.NODE_ENV,
        kiloUserId: 'test-user-c15',
        apiTokenPepper: 'test-pepper',
        version: JWT_TOKEN_VERSION,
        deviceSessionId: 'device-session-c15-test',
      },
      getEnvVariable('NEXTAUTH_SECRET'),
      { algorithm: 'HS256', expiresIn: '5y' }
    );

    const headers = new Headers();
    headers.set('authorization', `Bearer ${token}`);

    const result = validateAuthorizationHeader(headers);

    expect(result.error).toBeUndefined();
    expect(result.kiloUserId).toBe('test-user-c15');
    expect(result.apiTokenPepper).toBe('test-pepper');
    expect(result.deviceSessionId).toBe('device-session-c15-test');
  });

  test('preserves the deviceSessionId claim on the validated payload', () => {
    const deviceSessionId = 'device-session-preserved';
    const token = jwt.sign(
      {
        env: process.env.NODE_ENV,
        kiloUserId: 'test-user-c15',
        apiTokenPepper: 'test-pepper',
        version: JWT_TOKEN_VERSION,
        deviceSessionId,
      },
      getEnvVariable('NEXTAUTH_SECRET'),
      { algorithm: 'HS256', expiresIn: '5y' }
    );

    const headers = new Headers();
    headers.set('authorization', `Bearer ${token}`);

    const result = validateAuthorizationHeader(headers);

    expect(result.error).toBeUndefined();
    expect(result.deviceSessionId).toBe(deviceSessionId);
  });

  test('leaves deviceSessionId undefined when the token has no claim', () => {
    const token = jwt.sign(
      {
        env: process.env.NODE_ENV,
        kiloUserId: 'test-user-c15',
        apiTokenPepper: 'test-pepper',
        version: JWT_TOKEN_VERSION,
      },
      getEnvVariable('NEXTAUTH_SECRET'),
      { algorithm: 'HS256', expiresIn: '5y' }
    );

    const headers = new Headers();
    headers.set('authorization', `Bearer ${token}`);

    const result = validateAuthorizationHeader(headers);

    expect(result.error).toBeUndefined();
    expect(result.deviceSessionId).toBeUndefined();
  });
});
