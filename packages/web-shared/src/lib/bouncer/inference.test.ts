import { describe, expect, it } from '@jest/globals';

import {
  bareIpLiteral,
  bouncerDecideTier,
  bouncerRejectionResponse,
  payerSharingIp,
} from '@kilocode/web-shared/lib/bouncer/inference';

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

describe('bouncerRejectionResponse', () => {
  const allow = { enforced: false, spendWatch: false, flags: [] };

  it('sends the request on a null verdict (timeout, error, non-2xx, unknown shape)', () => {
    expect(bouncerRejectionResponse(null, 'r')).toBeNull();
  });

  it('sends the request unless the verdict is enforced', () => {
    expect(bouncerRejectionResponse(allow, 'r')).toBeNull();
    expect(
      bouncerRejectionResponse({ ...allow, code: 'rate_limited', retryAfterMs: 10 }, 'r')
    ).toBeNull();
  });

  it('maps an enforced throttle to a 429 with ceil-second and millisecond retry headers', async () => {
    const response = bouncerRejectionResponse(
      { ...allow, enforced: true, code: 'rate_limited', retryAfterMs: 1_001 },
      'r'
    );
    if (!response) throw new Error('Expected a rejection');
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('2');
    expect(response.headers.get('retry-after-ms')).toBe('1001');
    expect((await response.json()).error_type).toBe('rate_limit_exceeded');
  });

  it('maps an enforced restriction to a 403 without returning flags', async () => {
    const response = bouncerRejectionResponse(
      {
        ...allow,
        enforced: true,
        code: 'restricted',
        flags: [{ name: 'fraud:card_testing', decision: 'block', enforced: true, until: null }],
      },
      'r'
    );
    if (!response) throw new Error('Expected a rejection');
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain('card_testing');
  });
});
