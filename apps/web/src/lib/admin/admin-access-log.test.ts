import { describe, expect, test } from '@jest/globals';
import { authViaTokenFromHeaders, clientIpFromHeaders } from './admin-access-log';

describe('clientIpFromHeaders', () => {
  test('returns the first hop of x-forwarded-for', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe(
      '203.0.113.7'
    );
  });

  test('trims surrounding whitespace', () => {
    expect(
      clientIpFromHeaders(new Headers({ 'x-forwarded-for': '  203.0.113.9 , 10.0.0.1' }))
    ).toBe('203.0.113.9');
  });

  test('falls back to x-vercel-forwarded-for when x-forwarded-for is absent', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-vercel-forwarded-for': '198.51.100.5' }))).toBe(
      '198.51.100.5'
    );
  });

  test('returns null when no forwarding header is present', () => {
    expect(clientIpFromHeaders(new Headers())).toBeNull();
  });

  test('returns null for an empty x-forwarded-for header', () => {
    expect(clientIpFromHeaders(new Headers({ 'x-forwarded-for': '' }))).toBeNull();
  });
});

describe('authViaTokenFromHeaders', () => {
  test('is true when an Authorization header is present', () => {
    expect(authViaTokenFromHeaders(new Headers({ Authorization: 'Bearer abc' }))).toBe(true);
  });

  test('is false when no Authorization header is present', () => {
    expect(authViaTokenFromHeaders(new Headers())).toBe(false);
  });

  test('is false for an empty Authorization header (matches the session auth branch)', () => {
    // An empty header is non-null but falsy; getUserFromAuth treats it as the
    // session path, so the discriminator must agree.
    expect(authViaTokenFromHeaders(new Headers({ Authorization: '' }))).toBe(false);
  });
});
