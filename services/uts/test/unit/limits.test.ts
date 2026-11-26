import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousWriteRefusal } from '../../src/signin/limits';
import { clientNetwork } from '../../src/signin/network';

/**
 * The isolate's anonymous sign-in write limit (design 3, "Anonymous sign-in writes"). The windows
 * live in module state, so each test uses its own networks and its own clock.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spends the network's 10 writes of the window that starts at `start`. */
function spend(address: string | null, start: number) {
  for (let write = 0; write < 10; write++) {
    expect(anonymousWriteRefusal(address, 'device_authorization', start + write)).toBeNull();
  }
}

describe('client network', () => {
  it('is the IPv4 /24 or the IPv6 /48 of the address', () => {
    expect(clientNetwork('192.0.2.77')).toBe('192.0.2.0/24');
    expect(clientNetwork('2001:db8:1:2::5')).toBe('2001:db8:1::/48');
    expect(clientNetwork('2001:0db8:0001:ffff:ffff:ffff:ffff:ffff')).toBe('2001:db8:1::/48');
    expect(clientNetwork('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(clientNetwork('1::2:3:4:5:6:7')).toBe('1:0:2::/48');
    expect(clientNetwork('::ffff:192.0.2.1')).toBe('0:0:0::/48');
    expect(clientNetwork(null)).toBeNull();
  });
});

describe('anonymous sign-in write limit', () => {
  it('allows 10 writes per network per minute, then answers 429 with the seconds left', async () => {
    const start = 1_000_000;
    spend('198.51.1.1', start);
    // Another address of the same /24 shares the count.
    const refused = anonymousWriteRefusal('198.51.1.200', 'device_authorization', start + 15_000);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('Retry-After')).toBe('45');
    expect(await refused?.json()).toEqual({ error: 'rate_limited' });
    // Under a second left still asks for one second.
    const last = anonymousWriteRefusal('198.51.1.1', 'device_authorization', start + 59_900);
    expect(last?.headers.get('Retry-After')).toBe('1');
  });

  it('counts every address of one IPv6 /64, and of its /48, as one network', () => {
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
});
