import { describe, expect, it } from '@jest/globals';

import { bareIpLiteral, bouncerDecideTier, payerSharingIp } from '@/lib/bouncer/inference';

describe('bareIpLiteral', () => {
  it('keeps a bare IPv4 or IPv6 literal', () => {
    expect(bareIpLiteral('203.0.113.9')).toBe('203.0.113.9');
    expect(bareIpLiteral('2001:db8::1')).toBe('2001:db8::1');
  });

  it('drops brackets and a port', () => {
    expect(bareIpLiteral('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(bareIpLiteral('203.0.113.9:8443')).toBe('203.0.113.9');
  });

  it('drops a scoped IPv6 address instead of sending a value bouncer rejects', () => {
    expect(bareIpLiteral('fe80::1%eth0')).toBeUndefined();
  });

  it('drops a value that is not an address', () => {
    expect(bareIpLiteral('unknown')).toBeUndefined();
    expect(bareIpLiteral(undefined)).toBeUndefined();
  });
});

describe('payerSharingIp', () => {
  it('omits a shared Cloudflare address for a server-side Kilo feature', () => {
    expect(payerSharingIp('104.16.0.1', 'cloud-agent')).toBeUndefined();
    expect(payerSharingIp('2606:4700::1', 'code-review')).toBeUndefined();
  });

  it('keeps a Cloudflare address for a client-facing feature', () => {
    expect(payerSharingIp('104.16.0.1', 'quick-chat')).toBe('104.16.0.1');
    expect(payerSharingIp('104.16.0.1', null)).toBe('104.16.0.1');
  });

  it('keeps an address outside Cloudflare even for a server-side feature', () => {
    expect(payerSharingIp('203.0.113.9', 'cloud-agent')).toBe('203.0.113.9');
  });

  it('stays undefined when no address resolved', () => {
    expect(payerSharingIp(undefined, 'app-builder')).toBeUndefined();
  });
});

describe('bouncerDecideTier', () => {
  it('keeps a team plan as team even without a positive balance', () => {
    expect(bouncerDecideTier('org-1', 'teams', 0)).toBe('team');
    expect(bouncerDecideTier('org-1', 'enterprise', -5)).toBe('team');
  });
});
