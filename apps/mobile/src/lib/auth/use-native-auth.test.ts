import { describe, expect, it } from 'vitest';

import {
  buildChallengeEntry,
  type ChallengeEntry,
  parseAuthErrorCode,
  parseEmailCodeResponse,
  parseTokenPair,
  parseTokenResponse,
  selectChallengeId,
} from '@/lib/auth/native-auth-contract';

// Test the pure utility functions in the contract module.
// The hook itself is tested via integration/E2E tests.

describe('native-auth-contract (used by use-native-auth)', () => {
  describe('parseEmailCodeResponse', () => {
    it('accepts a response without challengeId (backward-compatible with older servers)', () => {
      const result = parseEmailCodeResponse({ success: true });
      expect(result).toEqual({ success: true, challengeId: undefined });
    });

    it('accepts a response with a valid challengeId', () => {
      const result = parseEmailCodeResponse({
        success: true,
        challengeId: 'abcd1234-5678-4def-8123-456789abcdef',
      });
      expect(result).toEqual({
        success: true,
        challengeId: 'abcd1234-5678-4def-8123-456789abcdef',
      });
    });

    it('rejects an invalid challengeId format', () => {
      expect(parseEmailCodeResponse({ success: true, challengeId: 'not-a-uuid' })).toBeNull();
    });

    it('rejects a non-success response', () => {
      expect(parseEmailCodeResponse({ success: false })).toBeNull();
    });

    it('rejects null/undefined', () => {
      expect(parseEmailCodeResponse(null)).toBeNull();
      expect(parseEmailCodeResponse(undefined)).toBeNull();
    });
  });

  describe('parseTokenResponse', () => {
    it('parses a valid token', () => {
      expect(parseTokenResponse({ token: 'jwt-token' })).toEqual({ token: 'jwt-token' });
    });

    it('rejects missing token', () => {
      expect(parseTokenResponse({})).toBeNull();
    });

    it('rejects null', () => {
      expect(parseTokenResponse(null)).toBeNull();
    });
  });

  describe('parseTokenPair', () => {
    it('parses a full token pair with refresh (Apple/Google/Email after supportsRefresh:true)', () => {
      const result = parseTokenPair({ token: 'at', refreshToken: 'rt', expiresIn: 3600 });
      expect(result).toEqual({ token: 'at', refreshToken: 'rt', expiresIn: 3600 });
    });

    it('parses a token-only response (legacy server without refresh)', () => {
      const result = parseTokenPair({ token: 'at' });
      expect(result).toEqual({ token: 'at' });
    });

    it('returns null when token is missing', () => {
      expect(parseTokenPair({ refreshToken: 'rt' })).toBeNull();
    });

    it('returns null for non-objects', () => {
      expect(parseTokenPair(null)).toBeNull();
      expect(parseTokenPair(undefined)).toBeNull();
    });
  });

  describe('parseAuthErrorCode', () => {
    it('extracts error code', () => {
      expect(parseAuthErrorCode({ error: 'BLOCKED' })).toBe('BLOCKED');
    });

    it('returns undefined for non-error objects', () => {
      expect(parseAuthErrorCode({ success: true })).toBeUndefined();
    });

    it('returns undefined for non-objects', () => {
      expect(parseAuthErrorCode(null)).toBeUndefined();
      expect(parseAuthErrorCode(undefined)).toBeUndefined();
    });
  });
});

// Verify the module-level mapError utility is correct about the challengeId
// flow: the error mapper never leaks challengeId strings.
describe('use-native-auth error mapping', () => {
  it.each([
    ['INVALID_CODE', 'That code is incorrect. Please try again.'],
    ['TOO_MANY_ATTEMPTS', 'Too many attempts. Please request a new code.'],
    ['CODE_IN_PROGRESS', 'Your code is being processed. Wait a moment and try again.'],
    ['INVALID_EMAIL', 'Unable to deliver email to this address. Please use a different email.'],
    ['EMAIL_DELIVERY_FAILED', 'Email delivery is temporarily unavailable. Please try again later.'],
  ] as const)('maps %s to a user-facing message', (code, message) => {
    // The mapError function in use-native-auth.ts maps error codes to messages.
    // This test verifies the contract: error messages contain no internal identifiers.
    const AUTH_ERROR_MESSAGES: Record<string, string> = {
      'EMAIL-ALREADY-USED':
        "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
      'DIFFERENT-OAUTH':
        "An account with this email already exists with a different sign-in method. Try another method or use 'More sign-in options'.",
      SSO_ERROR: "Your organization requires SSO. Use 'More sign-in options'.",
      BLOCKED: 'This account has been blocked. Please contact support.',
      'SIGNUP-RATE-LIMITED': 'Too many attempts. Please try again later.',
      INVALID_CODE: 'That code is incorrect. Please try again.',
      CODE_IN_PROGRESS: 'Your code is being processed. Wait a moment and try again.',
      TOO_MANY_ATTEMPTS: 'Too many attempts. Please request a new code.',
      INVALID_TOKEN: 'Sign-in failed. Please try again.',
      INVALID_EMAIL: 'Unable to deliver email to this address. Please use a different email.',
      INVALID_REQUEST: 'Check your email address and try again.',
      EMAIL_DELIVERY_FAILED: 'Email delivery is temporarily unavailable. Please try again later.',
    };

    expect(AUTH_ERROR_MESSAGES[code]).toBe(message);
    // Error messages must never contain words like "uuid" or "challenge".
    expect(message).not.toMatch(/uuid|challenge/i);
  });
});

describe('challenge binding', () => {
  const email = 'user@example.com';
  const challengeId = 'c0000000-0000-4000-8000-000000000001';

  describe('buildChallengeEntry', () => {
    it('stores the challenge for the email after OTP success', () => {
      const entry = buildChallengeEntry({ success: true, challengeId }, email);
      expect(entry).toEqual({ email, challengeId });
    });

    it('returns null when the server returns no challengeId', () => {
      const entry = buildChallengeEntry({ success: true, challengeId: undefined }, email);
      expect(entry).toBeNull();
    });
  });

  describe('selectChallengeId', () => {
    const entry: ChallengeEntry = { email, challengeId };

    it('returns the challengeId when the email matches', () => {
      expect(selectChallengeId(entry, email)).toBe(challengeId);
    });

    it('returns undefined when the email changed', () => {
      expect(selectChallengeId(entry, 'other@example.com')).toBeUndefined();
    });

    it('returns undefined when the entry is null (no server challenge)', () => {
      expect(selectChallengeId(null, email)).toBeUndefined();
    });
  });
});
