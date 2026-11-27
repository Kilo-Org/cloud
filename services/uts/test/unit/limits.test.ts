import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousWriteRefusal, anonymousWriteRetryAfter } from '../../src/signin/limits';
import { anonymousWriter, requestNetwork } from '../../src/signin/network';

/**
 * The isolate's anonymous sign-in write limit (design 3, "Anonymous sign-in writes"). The windows
 * live in module state, so each test uses its own writers and its own clock.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spends the writer's 10 writes of the window that starts at `start`. */
function spend(address: string | null, start: number) {
  for (let write = 0; write < 10; write++) {
    expect(anonymousWriteRefusal(address, 'device_authorization', start + write)).toBeNull();
  }
}

describe('anonymous writer', () => {
  it('is the exact IPv4 address or the IPv6 /48', () => {
    expect(anonymousWriter('192.0.2.77')).toBe('192.0.2.77');
    expect(anonymousWriter('2001:db8:1:2::5')).toBe('2001:db8:1::/48');
    expect(anonymousWriter('2001:0db8:0001:ffff:ffff:ffff:ffff:ffff')).toBe('2001:db8:1::/48');
    expect(anonymousWriter('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(anonymousWriter('1::2:3:4:5:6:7')).toBe('1:0:2::/48');
    expect(anonymousWriter('::ffff:192.0.2.1')).toBe('0:0:0::/48');
    expect(anonymousWriter(null)).toBeNull();
  });
});

describe('client address', () => {
  const clientIp = (header: string) =>
    requestNetwork(new Request('https://uts.test/', { headers: { 'CF-Connecting-IP': header } }))
      .clientIp;

  it('reads an IPv4-mapped IPv6 address as its IPv4 address, so it groups by that /24', () => {
    expect(clientIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(clientIp('::FFFF:c000:0201')).toBe('192.0.2.1');
    expect(clientIp('0:0:0:0:0:ffff:198.51.100.7')).toBe('198.51.100.7');
  });

  it('keeps other addresses as they are and drops what is not an address', () => {
    expect(clientIp('192.0.2.77')).toBe('192.0.2.77');
    expect(clientIp('2001:db8::1')).toBe('2001:db8::1');
    expect(clientIp('::1')).toBe('::1');
    expect(clientIp('64:ff9b::192.0.2.1')).toBe('64:ff9b::192.0.2.1');
    expect(clientIp('not an address')).toBeNull();
  });
});

describe('anonymous sign-in write limit', () => {
  it('allows 10 writes per writer per minute, then answers 429 with the seconds left', async () => {
    const start = 1_000_000;
    spend('198.51.1.1', start);
    const refused = anonymousWriteRefusal('198.51.1.1', 'device_authorization', start + 15_000);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('Retry-After')).toBe('45');
    expect(await refused?.json()).toEqual({ error: 'rate_limited' });
    // Under a second left still asks for one second.
    const last = anonymousWriteRefusal('198.51.1.1', 'device_authorization', start + 59_900);
    expect(last?.headers.get('Retry-After')).toBe('1');
  });

  it('counts each IPv4 host on its own, so one host cannot block its /24', () => {
    const start = 1_250_000;
    spend('198.51.7.1', start);
    expect(anonymousWriteRefusal('198.51.7.1', 'device_authorization', start + 1)).not.toBeNull();
    expect(anonymousWriteRefusal('198.51.7.2', 'device_authorization', start + 1)).toBeNull();
  });

  it('counts every address of one IPv6 /64, and of its /48, as one writer', () => {
    const start = 1_500_000;
    for (let host = 0; host < 10; host++) {
      const address = `2001:db8:5:${host % 2}:${host.toString(16)}::1`;
      expect(anonymousWriteRefusal(address, 'device_authorization', start)).toBeNull();
    }
    expect(
      anonymousWriteRefusal('2001:db8:5:0:ffff::9', 'device_authorization', start)
    ).not.toBeNull();
    expect(anonymousWriteRefusal('2001:db8:6::1', 'device_authorization', start)).toBeNull();
  });

  it('starts a new window a minute after the first write', () => {
    const start = 2_000_000;
    spend('198.51.2.1', start);
    expect(
      anonymousWriteRefusal('198.51.2.1', 'device_authorization', start + 59_999)
    ).not.toBeNull();
    expect(anonymousWriteRefusal('198.51.2.1', 'device_authorization', start + 60_000)).toBeNull();
  });

  it('counts each network on its own, over both write kinds', () => {
    const start = 3_000_000;
    for (let write = 0; write < 5; write++) {
      expect(anonymousWriteRefusal('198.51.3.1', 'device_authorization', start)).toBeNull();
      expect(anonymousWriteRefusal('198.51.3.1', 'passkey_sign_in_challenge', start)).toBeNull();
    }
    expect(anonymousWriteRefusal('198.51.3.1', 'passkey_sign_in_challenge', start)).not.toBeNull();
    expect(anonymousWriteRefusal('198.51.4.1', 'passkey_sign_in_challenge', start)).toBeNull();
  });

  it('shares one window among requests without an address', () => {
    const start = 4_000_000;
    spend(null, start);
    expect(anonymousWriteRefusal(null, 'passkey_sign_in_challenge', start + 1)).not.toBeNull();
  });

  it('logs a refusal as an auth action that stored nothing, and a write it allows not at all', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const start = 5_000_000;
    spend('198.51.5.1', start);
    expect(log).not.toHaveBeenCalled();
    anonymousWriteRefusal('198.51.5.1', 'passkey_sign_in_challenge', start + 1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: 'auth_action',
      action: 'passkey_sign_in_challenge',
      outcome: 'rate_limited',
      stored: false,
    });
  });

  it('drops the oldest window once it holds 10,000 networks', () => {
    const start = 6_000_000;
    spend('198.51.6.1', start);
    for (let index = 0; index < 10_000; index++) {
      const address = `10.${index >> 8}.${index & 255}.1`;
      expect(anonymousWriteRefusal(address, 'device_authorization', start + 1)).toBeNull();
    }
    expect(anonymousWriteRefusal('198.51.6.1', 'device_authorization', start + 2)).toBeNull();
  });

  it('gives SSO starts their own 60 a minute, apart from the shared 10', () => {
    const start = 3_000_000;
    const office = '198.51.9.9';
    for (let write = 0; write < 60; write++) {
      expect(anonymousWriteRetryAfter(office, 'sso_sign_in_start', start + write)).toBeNull();
    }
    expect(anonymousWriteRetryAfter(office, 'sso_sign_in_start', start + 30_000)).toBe(30);
    // The SSO starts left the shared window untouched: 10 more writes of other kinds pass.
    for (let write = 0; write < 10; write++) {
      expect(anonymousWriteRetryAfter(office, 'provider_sign_in_start', start + write)).toBeNull();
    }
    expect(anonymousWriteRetryAfter(office, 'email_sign_in_start', start + 100)).toBe(60);
  });

  it('gives client metadata fetches their own 10 a minute, apart from the sign-in writes', () => {
    const start = 4_000_000;
    const network = '198.51.10.10';
    for (let lookup = 0; lookup < 10; lookup++) {
      expect(anonymousWriteRetryAfter(network, 'client_metadata_fetch', start + lookup)).toBeNull();
    }
    expect(anonymousWriteRetryAfter(network, 'client_metadata_fetch', start + 15_000)).toBe(45);
    // Client lookups never use up a sign-in of the same network.
    expect(anonymousWriteRetryAfter(network, 'passkey_sign_in_challenge', start + 100)).toBeNull();
  });
});
