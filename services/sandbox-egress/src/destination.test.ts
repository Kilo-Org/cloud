import { describe, expect, it } from 'vitest';
import { connectHostname, isPublicAddress } from './destination.js';

describe('CONNECT destination boundary', () => {
  it.each(['github.com:443', 'GITHUB.COM.:443'])('normalizes %s', authority => {
    expect(connectHostname(authority)).toBe('github.com');
  });
  it.each([
    'github.com',
    'github.com:80',
    'github.com:0443',
    'github.com:443/path',
    'user@github.com:443',
    'github.com:443?x=y',
    'github.com:443#x',
    '[::1]:443',
    '127.0.0.1:443',
    '2130706433:443',
    '0x7f000001:443',
    'github.com :443',
    'github.com:443\r\nHost: other.example',
    'github.com:443@other.example',
    'github.com..:443',
  ])('refuses ambiguous authority %s', authority => expect(connectHostname(authority)).toBeNull());
  it.each([
    '0.0.0.0',
    '10.84.1.1',
    '100.100.100.200',
    '127.0.0.1',
    '169.254.169.254',
    '169.254.170.2',
    '172.16.1.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.19.255.255',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::1',
    '::ffff:8.8.8.8',
    '8.8.8.8.evil',
  ])('refuses a non-public or unsupported address %s', address =>
    expect(isPublicAddress(address)).toBe(false)
  );
  it.each(['1.1.1.1', '8.8.8.8', '140.82.112.3'])('permits public IPv4 %s', address =>
    expect(isPublicAddress(address)).toBe(true)
  );
});
