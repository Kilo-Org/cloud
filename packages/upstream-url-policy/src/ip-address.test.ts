import { describe, expect, test } from 'vitest';
import { isPublicIp } from './ip-address';

describe('IP policy', () => {
  test('allows ordinary public IPv4 addresses', () => {
    expect(isPublicIp('8.8.8.8')).toBe(true);
    expect(isPublicIp('1.1.1.1')).toBe(true);
  });

  test.each([
    '0.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ])('rejects non-public IPv4 %s', address => {
    expect(isPublicIp(address)).toBe(false);
  });

  test('allows ordinary public IPv6 addresses and bracketed literals', () => {
    expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('[2606:4700:4700::1111]')).toBe(true);
  });

  test.each([
    '::',
    '::1',
    '::ffff:0:0',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'ff00::1',
    '2001:db8::1',
    '2001:0::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '3fff::1',
  ])('rejects non-public IPv6 %s', address => {
    expect(isPublicIp(address)).toBe(false);
  });
});
