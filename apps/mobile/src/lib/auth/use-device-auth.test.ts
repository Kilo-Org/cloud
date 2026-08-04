import { describe, expect, it } from 'vitest';
import { getDeviceAuth429Message } from '@/lib/auth/poll-response';
import {
  buildDeviceAuthPollRequest,
  parseDeviceAuthTokenResponse,
} from '@/lib/auth/native-auth-contract';

describe('device-auth polling request', () => {
  it('sends only the device secret as the polling credential', () => {
    expect(buildDeviceAuthPollRequest('device-secret')).toEqual({
      deviceCode: 'device-secret',
      supportsRefresh: true,
    });
  });
});

// --- Existing 429 tests (unchanged) ---

describe('use-device-auth start path — 429 rate-limit message', () => {
  it('extracts the server error field from a 429 JSON body', () => {
    const serverBody = {
      error: 'Too many sign-in attempts from this network. Wait a few minutes and try again.',
    };
    const message = getDeviceAuth429Message(serverBody);
    expect(message).toBe(serverBody.error);
  });

  it('falls back to a fixed string when the server body has no error field', () => {
    const serverBody: { error?: string } = {};
    const message = getDeviceAuth429Message(serverBody);
    expect(message).toBe('Too many sign-in attempts. Please wait and try again.');
  });

  it('falls back to the fixed string when JSON parsing fails', () => {
    const message = getDeviceAuth429Message(undefined);
    expect(message).toBe('Too many sign-in attempts. Please wait and try again.');
  });
});

// --- New: Device auth token response parsing ---

describe('use-device-auth token response parsing', () => {
  it('parses an approved response with full refresh pair', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
    });
  });

  it('parses an approved response with only a token (legacy server, no refresh)', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'access',
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'access',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('parses pending', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'pending' })).toEqual({
      status: 'pending',
    });
  });

  it('parses denied', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'denied' })).toEqual({
      status: 'denied',
    });
  });

  it('parses expired', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'expired' })).toEqual({
      status: 'expired',
    });
  });

  it('returns null for a non-object', () => {
    expect(parseDeviceAuthTokenResponse(null)).toBeNull();
  });

  it('returns null for an approved response without a token', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'approved' })).toBeNull();
  });

  it('returns null for a malformed response with wrong status', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'consumed' })).toBeNull();
  });
});

// --- Poll response terminal handling ---
// When the server returns a terminal HTTP status (200/403/410) but the body
// parse fails, classifyPollResponse reports approved/denied/expired based on
// the status code alone. The poll switch must turn those into terminal errors.

describe('use-device-auth malformed poll response — terminal state', () => {
  it('returns null for a 200 body with no status field — forces terminal error', () => {
    // Server returned HTTP 200 but the JSON body is malformed (e.g. empty object).
    // parseDeviceAuthTokenResponse returns null.
    expect(parseDeviceAuthTokenResponse({})).toBeNull();
  });

  it('returns null for a 200 body with approved but no token — forces terminal error', () => {
    // Server returned HTTP 200 with status 'approved' but no token field.
    // The hook must not proceed to signIn.
    expect(parseDeviceAuthTokenResponse({ status: 'approved' })).toBeNull();
  });

  it('returns null for a 403 body with malformed JSON — forces terminal error', () => {
    // Server returned HTTP 403 but the JSON body is not an object.
    // parseDeviceAuthTokenResponse returns null.
    expect(parseDeviceAuthTokenResponse(null)).toBeNull();
  });

  it('returns null for a 410 body with wrong shape — forces terminal error', () => {
    // Server returned HTTP 410 but the body has extra unknown fields.
    // Zod strips unknowns but required fields may still be missing.
    expect(parseDeviceAuthTokenResponse({ status: 'denied', extra: true })).toEqual({
      status: 'denied',
    });
  });

  it('parses a valid denied terminal state correctly', () => {
    // A correctly formed 403 response — the parser succeeds so the hook
    // transitions to the denied terminal state, not error.
    const result = parseDeviceAuthTokenResponse({ status: 'denied' });
    expect(result).toEqual({ status: 'denied' });
  });

  it('parses a valid expired terminal state correctly', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'expired' });
    expect(result).toEqual({ status: 'expired' });
  });
});
