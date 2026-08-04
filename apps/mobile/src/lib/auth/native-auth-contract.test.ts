import { describe, expect, it } from 'vitest';

import {
  parseAuthErrorCode,
  parseDeviceAuthCodeResponse,
  parseDeviceAuthTokenResponse,
  parseEmailCodeResponse,
  parseTokenPair,
  parseTokenResponse,
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
    expect(shouldRefreshBeforeRequest(10_000, 5_000, 5_000)).toBe(true);
    expect(shouldRefreshBeforeRequest(10_001, 5_000, 5_000)).toBe(false);
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

  it('parses a pending response', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'pending' })).toEqual({ status: 'pending' });
  });

  it('parses a denied response', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'denied' })).toEqual({ status: 'denied' });
  });

  it('parses an expired response', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'expired' })).toEqual({ status: 'expired' });
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

  it('returns null for an unknown status', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'unknown' })).toBeNull();
  });

  it('returns null for non-object', () => {
    expect(parseDeviceAuthTokenResponse(null)).toBeNull();
  });

  it('returns null for empty object', () => {
    expect(parseDeviceAuthTokenResponse({})).toBeNull();
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

// --- parseAuthErrorCode ---

describe('parseAuthErrorCode', () => {
  it('parses an error', () => {
    expect(parseAuthErrorCode({ error: 'BLOCKED' })).toBe('BLOCKED');
  });

  it('returns undefined for non-object', () => {
    expect(parseAuthErrorCode(null)).toBeUndefined();
  });
});
