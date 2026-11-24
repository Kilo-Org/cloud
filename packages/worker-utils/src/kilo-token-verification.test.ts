import { describe, it, expect } from 'vitest';
import {
  KILO_TOKEN_MAX_LIFETIME_SECONDS,
  assertKiloTokenIssuedAt,
  assertKiloTokenLifetime,
  isKiloTokenLifetimeAllowed,
} from './kilo-token-verification.js';

describe('assertKiloTokenIssuedAt', () => {
  it('rejects a missing iat', () => {
    expect(() => assertKiloTokenIssuedAt(undefined, 1_000)).toThrow(
      'Missing or invalid token issued-at'
    );
  });

  it('rejects an iat in the future', () => {
    expect(() => assertKiloTokenIssuedAt(1_001, 1_000)).toThrow('Token issued in the future');
  });

  it('accepts an iat in the past', () => {
    expect(() => assertKiloTokenIssuedAt(999, 1_000)).not.toThrow();
  });
});

describe('Kilo token lifetime cap', () => {
  const iat = 1_900_000_000;

  it('caps the lifetime at 30 days', () => {
    expect(KILO_TOKEN_MAX_LIFETIME_SECONDS).toBe(30 * 24 * 60 * 60);
  });

  it.each([
    ['one hour', 60 * 60],
    ['exactly the cap', KILO_TOKEN_MAX_LIFETIME_SECONDS],
  ])('accepts a lifetime of %s', (_name, lifetime) => {
    expect(isKiloTokenLifetimeAllowed({ iat, exp: iat + lifetime })).toBe(true);
    expect(() => assertKiloTokenLifetime({ iat, exp: iat + lifetime })).not.toThrow();
  });

  it.each([
    ['one second above the cap', { iat, exp: iat + KILO_TOKEN_MAX_LIFETIME_SECONDS + 1 }],
    ['five years', { iat, exp: iat + 157_680_000 }],
    ['a missing iat', { exp: iat + 60 }],
    ['a missing exp', { iat }],
    ['no dates at all', {}],
    ['a string iat', { iat: String(iat), exp: iat + 60 }],
    ['a string exp', { iat, exp: String(iat + 60) }],
    ['a null iat', { iat: null, exp: iat + 60 }],
    ['a non-finite iat', { iat: Number.NEGATIVE_INFINITY, exp: iat + 60 }],
    ['a non-finite exp', { iat, exp: Number.NaN }],
  ])('refuses %s', (_name, claims) => {
    expect(isKiloTokenLifetimeAllowed(claims)).toBe(false);
    expect(() => assertKiloTokenLifetime(claims)).toThrow(
      'Token lifetime is missing or exceeds the maximum'
    );
  });
});
