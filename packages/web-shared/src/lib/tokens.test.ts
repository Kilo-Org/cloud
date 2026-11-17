import { describe, test, expect } from '@jest/globals';
import jwt from 'jsonwebtoken';
import {
  validateAuthorizationHeader,
  JWT_TOKEN_VERSION,
  isRejectedCredentialReason,
} from './tokens';
import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';

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

describe('the anonymous bearer sentinel', () => {
  test('means no credential, not a refused one', () => {
    // The Kilo clients send `apiKey: "anonymous"` when nobody is signed in.
    // Failing that request closed would take the free tier down with it.
    const result = validateAuthorizationHeader(new Headers({ authorization: 'Bearer anonymous' }));

    expect(result.reason).toBe('missing_credentials');
    expect(isRejectedCredentialReason(result.reason)).toBe(false);
  });

  test('does not swallow a real token that merely starts the same way', () => {
    const result = validateAuthorizationHeader(
      new Headers({ authorization: 'Bearer anonymous-ish-token' })
    );

    expect(result.reason).toBe('invalid_token');
    expect(isRejectedCredentialReason(result.reason)).toBe(true);
  });
});

describe('isRejectedCredentialReason', () => {
  test.each([
    ['missing_credentials', false],
    ['invalid_token', true],
    ['token_version_outdated', true],
    ['runtime_attestation_required', true],
    ['audience_not_allowed', true],
    ['a_reason_added_later', true],
    [undefined, true],
  ])('%s -> %s', (reason, expected) => {
    // Only the absence of a credential may continue anonymously. Every other
    // reason, including one this version does not know, fails the request.
    expect(isRejectedCredentialReason(reason)).toBe(expected);
  });
});

describe('the verified payload schema', () => {
  const validClaims = {
    env: process.env.NODE_ENV,
    kiloUserId: 'test-user-schema',
    apiTokenPepper: 'test-pepper',
    version: JWT_TOKEN_VERSION,
  };

  const validate = (claims: Record<string, unknown>) => {
    const token = jwt.sign(claims, getEnvVariable('NEXTAUTH_SECRET'), {
      algorithm: 'HS256',
      expiresIn: '5y',
    });
    return validateAuthorizationHeader(new Headers({ authorization: `Bearer ${token}` }));
  };

  test('accepts a token whose claims match the schema', () => {
    const result = validate(validClaims);

    expect(result.error).toBeUndefined();
    expect(result.kiloUserId).toBe('test-user-schema');
  });

  test('refuses a token whose kiloUserId is not a string', () => {
    expect(validate({ ...validClaims, kiloUserId: 42 }).reason).toBe('invalid_token');
  });

  test('refuses a token with no version claim', () => {
    expect(validate({ env: process.env.NODE_ENV, kiloUserId: 'test-user-schema' }).reason).toBe(
      'invalid_token'
    );
  });

  test('refuses a token whose organizationId is not a string', () => {
    expect(validate({ ...validClaims, organizationId: 7 }).reason).toBe('invalid_token');
  });

  test('refuses a token whose internalApiUse is not a boolean', () => {
    expect(validate({ ...validClaims, internalApiUse: 'true' }).reason).toBe('invalid_token');
  });

  test('leaves an outdated version to the version refusal', () => {
    expect(validate({ ...validClaims, version: JWT_TOKEN_VERSION - 1 }).reason).toBe(
      'token_version_outdated'
    );
  });

  test('keeps an unknown claim and leaves the audience check to its own rules', () => {
    const result = validate({ ...validClaims, someFutureClaim: 'x' });

    expect(result.error).toBeUndefined();
    expect(result.kiloUserId).toBe('test-user-schema');
  });

  test('does not decide a null audience in the schema', () => {
    // The audience policy refuses a null audience on its own; the schema only
    // has to let the claim through so that check stays reachable.
    expect(validate({ ...validClaims, aud: null }).reason).toBe('audience_not_allowed');
  });
});
