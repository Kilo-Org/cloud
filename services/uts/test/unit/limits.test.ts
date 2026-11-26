import { afterEach, describe, expect, it, vi } from 'vitest';
import { anonymousWriteRefusal } from '../../src/signin/limits';

/**
 * The isolate's anonymous sign-in write limit (design 3, "Anonymous sign-in writes"). The windows
 * live in module state, so each test uses its own addresses and its own clock.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Spends the address's 10 writes of the window that starts at `start`. */
function spend(address: string | null, start: number) {
  for (let write = 0; write < 10; write++) {
    expect(anonymousWriteRefusal(address, 'device_authorization', start + write)).toBeNull();
  }
}

describe('anonymous sign-in write limit', () => {
  it('allows 10 writes per address per minute, then answers 429 with the seconds left', async () => {
    const start = 1_000_000;
    spend('192.0.2.1', start);
    const refused = anonymousWriteRefusal('192.0.2.1', 'device_authorization', start + 15_000);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('Retry-After')).toBe('45');
    expect(await refused?.json()).toEqual({ error: 'rate_limited' });
    // Under a second left still asks for one second.
    const last = anonymousWriteRefusal('192.0.2.1', 'device_authorization', start + 59_900);
    expect(last?.headers.get('Retry-After')).toBe('1');
  });

  it('starts a new window a minute after the first write', () => {
    const start = 2_000_000;
    spend('192.0.2.2', start);
    expect(
      anonymousWriteRefusal('192.0.2.2', 'device_authorization', start + 59_999)
    ).not.toBeNull();
    expect(anonymousWriteRefusal('192.0.2.2', 'device_authorization', start + 60_000)).toBeNull();
  });

  it('counts each address on its own, over both write kinds', () => {
    const start = 3_000_000;
    for (let write = 0; write < 5; write++) {
      expect(anonymousWriteRefusal('192.0.2.3', 'device_authorization', start)).toBeNull();
      expect(anonymousWriteRefusal('192.0.2.3', 'passkey_sign_in_challenge', start)).toBeNull();
    }
    expect(anonymousWriteRefusal('192.0.2.3', 'passkey_sign_in_challenge', start)).not.toBeNull();
    expect(anonymousWriteRefusal('192.0.2.4', 'passkey_sign_in_challenge', start)).toBeNull();
  });

  it('shares one window among requests without an address', () => {
    const start = 4_000_000;
    spend(null, start);
    expect(anonymousWriteRefusal(null, 'passkey_sign_in_challenge', start + 1)).not.toBeNull();
  });

  it('logs a refusal as an auth action that stored nothing, and a write it allows not at all', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const start = 5_000_000;
    spend('192.0.2.5', start);
    expect(log).not.toHaveBeenCalled();
    anonymousWriteRefusal('192.0.2.5', 'passkey_sign_in_challenge', start + 1);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual({
      event: 'auth_action',
      action: 'passkey_sign_in_challenge',
      outcome: 'rate_limited',
      stored: false,
    });
  });

  it('drops the oldest window once it holds 10,000 addresses', () => {
    const start = 6_000_000;
    spend('192.0.2.6', start);
    for (let index = 0; index < 10_000; index++) {
      expect(
        anonymousWriteRefusal(`2001:db8::${index.toString(16)}`, 'device_authorization', start + 1)
      ).toBeNull();
    }
    expect(anonymousWriteRefusal('192.0.2.6', 'device_authorization', start + 2)).toBeNull();
  });
});
