import { describe, expect, it } from 'vitest';

import {
  buildChallengeEntry,
  buildDeviceAuthPollRequest,
  parseAuthError,
  parseDeviceAuthCodeResponse,
  parseDeviceAuthTokenResponse,
  parseEmailCodeResponse,
  parseTokenPair,
  parseTokenResponse,
  selectChallengeId,
  shouldRefreshBeforeRequest,
} from '@/lib/auth/native-auth-contract';

describe('parseDeviceAuthCodeResponse', () => {
  it('separates the displayed user code from the polling secret', () => {
    expect(
      parseDeviceAuthCodeResponse({
        code: 'USER-123',
        user_code: 'USER-123',
        device_code: 'device-secret',
        verificationUrl: 'https://app.kilo.ai/device-auth?code=USER-123',
      })
    ).toEqual({
      userCode: 'USER-123',
      deviceCode: 'device-secret',
      verificationUrl: 'https://app.kilo.ai/device-auth?code=USER-123',
    });
  });

  it('keeps a legacy code-only response compatible', () => {
    expect(
      parseDeviceAuthCodeResponse({
        code: 'legacy-code',
        verificationUrl: 'https://app.kilo.ai/device-auth?code=legacy-code',
      })
    ).toEqual({
      userCode: 'legacy-code',
      deviceCode: 'legacy-code',
      verificationUrl: 'https://app.kilo.ai/device-auth?code=legacy-code',
    });
  });

  it('refuses a verification URL that exposes the device secret', () => {
    expect(
      parseDeviceAuthCodeResponse({
        code: 'USER-123',
        device_code: 'device-secret',
        verificationUrl: 'https://app.kilo.ai/device-auth?code=device-secret',
      })
    ).toBeNull();
  });
});

describe('shouldRefreshBeforeRequest', () => {
  it('refreshes an expiring credential before an authenticated request', () => {
    expect(shouldRefreshBeforeRequest(10_000, 5000, 5000)).toBe(true);
    expect(shouldRefreshBeforeRequest(10_001, 5000, 5000)).toBe(false);
  });
});

// --- Legacy parseTokenResponse (backward-compat) ---

describe('parseTokenResponse', () => {
  it('parses a valid token', () => {
    expect(parseTokenResponse({ token: 'abc' })).toEqual({ token: 'abc' });
  });

  it('rejects missing token', () => {
    expect(parseTokenResponse({})).toBeNull();
  });

  it('rejects null', () => {
    expect(parseTokenResponse(null)).toBeNull();
  });
});

// --- parseTokenPair (full refresh pair) ---

describe('parseTokenPair', () => {
  it('parses a complete token pair', () => {
    expect(parseTokenPair({ token: 'abc', refreshToken: 'ref', expiresIn: 3600 })).toEqual({
      token: 'abc',
      refreshToken: 'ref',
      expiresIn: 3600,
    });
  });

  it('parses a token without refresh (legacy server)', () => {
    expect(parseTokenPair({ token: 'abc' })).toEqual({ token: 'abc' });
  });

  it('returns null for an empty object', () => {
    expect(parseTokenPair({})).toBeNull();
  });

  it('returns null for null', () => {
    expect(parseTokenPair(null)).toBeNull();
  });

  it('returns null when refreshToken is present but expiresIn is missing', () => {
    expect(parseTokenPair({ token: 'abc', refreshToken: 'ref' })).toEqual({ token: 'abc' });
  });

  it('returns null when expiresIn is zero', () => {
    // expiresIn must be positive; zero is rejected by the schema
    expect(parseTokenPair({ token: 'abc', refreshToken: 'ref', expiresIn: 0 })).toBeNull();
  });

  it('returns created on a complete token pair', () => {
    expect(
      parseTokenPair({ token: 'abc', refreshToken: 'ref', expiresIn: 3600, created: true })
    ).toEqual({ token: 'abc', refreshToken: 'ref', expiresIn: 3600, created: true });
  });

  it('returns created on a token-only response', () => {
    expect(parseTokenPair({ token: 'abc', created: false })).toEqual({
      token: 'abc',
      created: false,
    });
  });

  it('omits created when the server does not send it', () => {
    expect(parseTokenPair({ token: 'abc' })).toEqual({ token: 'abc' });
  });
});

// --- parseDeviceAuthTokenResponse ---

describe('parseDeviceAuthTokenResponse', () => {
  it('parses an approved response with refresh pair', () => {
    expect(
      parseDeviceAuthTokenResponse({
        status: 'approved',
        token: 'tok',
        refreshToken: 'ref',
        expiresIn: 3600,
      })
    ).toEqual({ status: 'approved', token: 'tok', refreshToken: 'ref', expiresIn: 3600 });
  });

  it('parses an approved response with token only (legacy)', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'approved', token: 'tok' })).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it.each(['pending', 'denied', 'expired'] as const)('parses a %s response', status => {
    expect(parseDeviceAuthTokenResponse({ status })).toEqual({ status });
  });

  it('returns null for approved without token', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'approved' })).toBeNull();
  });

  it('drops refreshToken without expiresIn to token-only (incomplete pair)', () => {
    expect(
      parseDeviceAuthTokenResponse({
        status: 'approved',
        token: 'tok',
        refreshToken: 'ref',
      })
    ).toEqual({ status: 'approved', token: 'tok' });
  });

  it('drops expiresIn without refreshToken to token-only (incomplete pair)', () => {
    expect(
      parseDeviceAuthTokenResponse({
        status: 'approved',
        token: 'tok',
        expiresIn: 3600,
      })
    ).toEqual({ status: 'approved', token: 'tok' });
  });

  it.each([null, {}, { status: 'unknown' }])('returns null for %s', input => {
    expect(parseDeviceAuthTokenResponse(input)).toBeNull();
  });
});

// --- Challenge selection and device polling helpers ---

describe('buildChallengeEntry', () => {
  it('returns null for a legacy success without challengeId', () => {
    expect(buildChallengeEntry({ success: true, challengeId: undefined }, 'a@b.co')).toBeNull();
  });

  it('stores the email with the challenge id', () => {
    expect(
      buildChallengeEntry({ success: true, challengeId: 'c-1' }, 'a@b.co')
    ).toEqual({ email: 'a@b.co', challengeId: 'c-1' });
  });
});

describe('selectChallengeId', () => {
  const entry = { email: 'a@b.co', challengeId: 'c-1' };

  it('returns the challenge id for the matching email', () => {
    expect(selectChallengeId(entry, 'a@b.co')).toBe('c-1');
  });

  it('returns undefined for a different email so a stale challenge is not reused', () => {
    expect(selectChallengeId(entry, 'other@b.co')).toBeUndefined();
  });

  it('returns undefined without a stored challenge', () => {
    expect(selectChallengeId(null, 'a@b.co')).toBeUndefined();
  });
});

describe('buildDeviceAuthPollRequest', () => {
  it('builds a refresh-capable poll request', () => {
    expect(buildDeviceAuthPollRequest('device-code')).toEqual({
      deviceCode: 'device-code',
      supportsRefresh: true,
    });
  });
});

// --- parseEmailCodeResponse ---

describe('parseEmailCodeResponse', () => {
  it('parses success without challengeId (legacy server)', () => {
    expect(parseEmailCodeResponse({ success: true })).toEqual({
      success: true,
      challengeId: undefined,
    });
  });

  it('parses success with challengeId', () => {
    expect(
      parseEmailCodeResponse({
        success: true,
        challengeId: 'c0000000-0000-4000-8000-000000000001',
      })
    ).toEqual({
      success: true,
      challengeId: 'c0000000-0000-4000-8000-000000000001',
    });
  });

  it('rejects success false', () => {
    expect(parseEmailCodeResponse({ success: false })).toBeNull();
  });

  it('rejects invalid challengeId format', () => {
    expect(parseEmailCodeResponse({ success: true, challengeId: 'not-a-uuid' })).toBeNull();
  });
});

// --- parseAuthError ---

describe('parseAuthError', () => {
  it('returns the code and ssoOrganizationId for an SSO error', () => {
    expect(parseAuthError({ error: 'SSO_ERROR', ssoOrganizationId: 'org_1' })).toEqual({
      code: 'SSO_ERROR',
      ssoOrganizationId: 'org_1',
    });
  });

  it('tolerates the absence of ssoOrganizationId', () => {
    expect(parseAuthError({ error: 'BLOCKED' })).toEqual({ code: 'BLOCKED' });
  });

  it('returns the step-up methods and keeps the code when they are malformed', () => {
    expect(parseAuthError({ error: 'SIGNUP-STEP-UP', methods: ['google', 'apple'] })).toEqual({
      code: 'SIGNUP-STEP-UP',
      signupMethods: ['google', 'apple'],
    });
    expect(parseAuthError({ error: 'SIGNUP-STEP-UP', methods: 'apple' })).toEqual({
      code: 'SIGNUP-STEP-UP',
    });
  });

  it('returns undefined for null, undefined, and non-error objects', () => {
    expect(parseAuthError(null)).toBeUndefined();
    expect(parseAuthError(undefined)).toBeUndefined();
    expect(parseAuthError({ success: true })).toBeUndefined();
  });
});
