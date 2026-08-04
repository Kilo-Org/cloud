import { describe, expect, it } from 'vitest';

import {
  parseAuthErrorCode,
  parseEmailCodeResponse,
  parseTokenResponse,
} from '@/lib/auth/native-auth-contract';

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

describe('parseAuthErrorCode', () => {
  it('parses an error', () => {
    expect(parseAuthErrorCode({ error: 'BLOCKED' })).toBe('BLOCKED');
  });

  it('returns undefined for non-object', () => {
    expect(parseAuthErrorCode(null)).toBeUndefined();
  });
});
