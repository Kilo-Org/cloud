import { describe, expect, it } from 'vitest';

// login-screen.test.tsx — narrow contract tests.
// The LoginScreen component mounts native modules (expo-clipboard,
// expo-web-browser, react-native-safe-area-context) that are not available
// in the Vitest environment, so we verify the refresh boundary contract
// through the useDeviceAuth hook's output shape.

import { parseDeviceAuthTokenResponse } from '@/lib/auth/native-auth-contract';
import { errorMessage } from './login-screen-state';

describe('login-screen refresh boundary', () => {
  it('passes refreshToken and expiresIn through the approved token response', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
      expiresIn: 3600,
    });
  });

  it('handles an approved response without refresh pair (legacy)', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('drops an incomplete pair (refreshToken without expiresIn) to token-only', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
    });

    // An incomplete pair must never reach signIn as a refresh token.
    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('drops an incomplete pair (expiresIn without refreshToken) to token-only', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      expiresIn: 3600,
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('handles a denied response', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'denied' });
    expect(result).toEqual({ status: 'denied' });
  });

  it('handles an expired response', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'expired' });
    expect(result).toEqual({ status: 'expired' });
  });

  it('handles a pending response', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'pending' });
    expect(result).toEqual({ status: 'pending' });
  });
});

describe('login-screen error mapping', () => {
  it('maps expired to a distinct message', () => {
    expect(errorMessage('expired', undefined)).toBe(
      'Your sign-in code has expired. Please try again.'
    );
  });

  it('maps denied to a distinct message', () => {
    expect(errorMessage('denied', undefined)).toBe('Access was denied.');
  });

  it('falls back to the provided error for unknown status', () => {
    expect(errorMessage('error', 'custom error')).toBe('custom error');
  });

  it('falls back to default when no error is provided', () => {
    expect(errorMessage('error', undefined)).toBe('Something went wrong. Please try again.');
  });
});

describe('login-screen malformed poll boundary', () => {
  it('returns null for a 200 body with no token — prevents signIn call', () => {
    // When the server returns HTTP 200 but parse fails (no token),
    // the hook transitions to 'error' state, not 'approved'.
    // signIn is never called with a missing token.
    const result = parseDeviceAuthTokenResponse({ status: 'approved' });
    expect(result).toBeNull();
  });

  it('returns null for an empty 200 body — prevents signIn call', () => {
    const result = parseDeviceAuthTokenResponse({});
    expect(result).toBeNull();
  });

  it('returns null for a non-object 200 body — prevents signIn call', () => {
    const result = parseDeviceAuthTokenResponse(null);
    expect(result).toBeNull();
  });

  it('drops a partial pair so incomplete credentials never reach signIn', () => {
    // refreshToken present but expiresIn missing — must not reach signIn as a pair.
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'tok',
      refreshToken: 'ref',
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'tok',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });
});
