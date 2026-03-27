import { describe, test, expect } from '@jest/globals';
import { isCloudflareIP } from './cloudflare-ip';

describe('isCloudflareIP', () => {
  describe('IPv4 addresses within Cloudflare ranges', () => {
    test('returns true for 173.245.48.1 (in 173.245.48.0/20)', () => {
      expect(isCloudflareIP('173.245.48.1')).toBe(true);
    });

    test('returns true for 104.16.0.1 (in 104.16.0.0/13)', () => {
      expect(isCloudflareIP('104.16.0.1')).toBe(true);
    });

    test('returns true for 162.158.0.1 (in 162.158.0.0/15)', () => {
      expect(isCloudflareIP('162.158.0.1')).toBe(true);
    });
  });

  describe('IPv4 range boundaries', () => {
    test('returns true for the network address itself (173.245.48.0)', () => {
      expect(isCloudflareIP('173.245.48.0')).toBe(true);
    });

    test('returns true for the last IP in a /20 range (173.245.63.255)', () => {
      expect(isCloudflareIP('173.245.63.255')).toBe(true);
    });
  });

  describe('IPv4 addresses outside Cloudflare ranges', () => {
    test('returns false for 1.2.3.4', () => {
      expect(isCloudflareIP('1.2.3.4')).toBe(false);
    });

    test('returns false for 192.168.1.1', () => {
      expect(isCloudflareIP('192.168.1.1')).toBe(false);
    });

    test('returns false for 10.0.0.1', () => {
      expect(isCloudflareIP('10.0.0.1')).toBe(false);
    });
  });

  describe('IPv6 addresses within Cloudflare ranges', () => {
    test('returns true for 2606:4700::1', () => {
      expect(isCloudflareIP('2606:4700::1')).toBe(true);
    });

    test('returns true for 2400:cb00::1', () => {
      expect(isCloudflareIP('2400:cb00::1')).toBe(true);
    });
  });

  describe('IPv6 addresses outside Cloudflare ranges', () => {
    test('returns false for ::1', () => {
      expect(isCloudflareIP('::1')).toBe(false);
    });

    test('returns false for 2001:db8::1', () => {
      expect(isCloudflareIP('2001:db8::1')).toBe(false);
    });
  });

  describe('invalid IP strings', () => {
    test('returns false for "not-an-ip"', () => {
      expect(isCloudflareIP('not-an-ip')).toBe(false);
    });

    test('returns false for empty string', () => {
      expect(isCloudflareIP('')).toBe(false);
    });
  });
});
