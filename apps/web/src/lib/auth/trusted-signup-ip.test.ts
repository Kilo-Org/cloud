import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { getTrustedSignupClientIp } from './trusted-signup-ip';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
});

afterEach(() => {
  process.env = originalEnv;
});

describe('getTrustedSignupClientIp', () => {
  test('returns the client address of a single-entry forwarded header', () => {
    expect(getTrustedSignupClientIp(new Headers({ 'x-forwarded-for': '203.0.113.7' }))).toBe(
      '203.0.113.7'
    );
  });

  test('returns the first hop of a forwarded chain', () => {
    expect(
      getTrustedSignupClientIp(
        new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1, 10.0.0.2' })
      )
    ).toBe('203.0.113.7');
  });

  test('prefers the platform address over a forwarded chain when Vercel labels the request', () => {
    process.env.VERCEL = '1';
    expect(
      getTrustedSignupClientIp(
        new Headers({
          'x-forwarded-for': '192.0.2.11, 10.0.0.1',
          'x-vercel-forwarded-for': '198.51.100.5',
        })
      )
    ).toBe('198.51.100.5');
  });

  test('does not read an unlabelled forwarded chain on Vercel', () => {
    process.env.VERCEL = '1';
    expect(
      getTrustedSignupClientIp(new Headers({ 'x-forwarded-for': '192.0.2.11, 10.0.0.1' }))
    ).toBeUndefined();
  });

  test('returns undefined without a forwarded header', () => {
    expect(getTrustedSignupClientIp(new Headers({ 'accept-language': 'en-US' }))).toBeUndefined();
  });

  test('returns undefined for a value that is not an address', () => {
    expect(getTrustedSignupClientIp(new Headers({ 'x-forwarded-for': 'unknown' }))).toBeUndefined();
    expect(getTrustedSignupClientIp(new Headers({ 'x-forwarded-for': '  ' }))).toBeUndefined();
  });

  test('returns undefined in a production deployment without the platform header', () => {
    process.env = { ...process.env, NODE_ENV: 'production' };
    expect(
      getTrustedSignupClientIp(new Headers({ 'x-forwarded-for': '203.0.113.7' }))
    ).toBeUndefined();
  });
});
