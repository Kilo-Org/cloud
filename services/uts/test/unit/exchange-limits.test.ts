import { type UtsPublicJwk, UtsPublicJwkSchema } from '@kilocode/uts-contracts';
import { describe, expect, it } from 'vitest';
import {
  KEY_COPY_FAILURE_HOLD_MS,
  KEY_COPY_LIFETIME_MS,
  KEY_REREAD_INTERVAL_MS,
  type SignerKeySource,
  isolateSignerKeys,
  newKeyCopyState,
} from '../../src/exchange/keys';
import { exchangeRetryAfter, newExchangeWindows } from '../../src/exchange/limits';

/** The broker exchange's per-isolate limits and its copy of the signer keys. */

describe('exchange limits', () => {
  it('allows 60 a minute per sid and 600 per caller, then names the seconds to the window end', () => {
    const windows = newExchangeWindows();
    const start = 1_000_000;
    for (let index = 0; index < 60; index += 1) {
      expect(exchangeRetryAfter(windows, 'subject', 'sid-a', start + index)).toBeNull();
    }
    expect(exchangeRetryAfter(windows, 'subject', 'sid-a', start + 30_000)).toBe(30);
    expect(exchangeRetryAfter(windows, 'subject', 'sid-a', start + 59_999)).toBe(1);
    expect(exchangeRetryAfter(windows, 'subject', 'sid-b', start + 59_999)).toBeNull();
    // A new window opens a minute after the first exchange.
    expect(exchangeRetryAfter(windows, 'subject', 'sid-a', start + 60_000)).toBeNull();

    for (let index = 0; index < 600; index += 1) {
      expect(exchangeRetryAfter(windows, 'caller', 'kilo-mcp', start)).toBeNull();
    }
    expect(exchangeRetryAfter(windows, 'caller', 'kilo-mcp', start)).toBe(60);
    // The two limits keep separate windows, so a sid named like a caller is not limited by it.
    expect(exchangeRetryAfter(windows, 'subject', 'kilo-mcp', start)).toBeNull();
  });

  it('keeps at most 10,000 windows a limit, dropping the oldest', () => {
    const windows = newExchangeWindows();
    for (let index = 0; index < 10_001; index += 1) {
      exchangeRetryAfter(windows, 'subject', `sid-${index}`, 0);
    }
    expect(windows.subject.size).toBe(10_000);
    expect(windows.subject.has('sid-0')).toBe(false);
    expect(windows.subject.has('sid-10000')).toBe(true);
  });
});

const jwk = (kid: string): UtsPublicJwk =>
  UtsPublicJwkSchema.parse({
    kty: 'OKP',
    crv: 'Ed25519',
    x: 'A'.repeat(43),
    kid,
    alg: 'EdDSA',
    use: 'sig',
  });
const KID_A = `uts-token-00-${'A'.repeat(43)}`;
const KID_B = `uts-token-01-${'B'.repeat(43)}`;

describe('the exchange key copy', () => {
  function source(answers: (readonly UtsPublicJwk[] | null)[]) {
    let reads = 0;
    const read: SignerKeySource = async () => {
      const answer = answers[Math.min(reads, answers.length - 1)];
      reads += 1;
      return answer;
    };
    return { read, reads: () => reads };
  }

  it('reads once, then serves known kids from memory for 5 minutes', async () => {
    let now = 0;
    const keys = source([[jwk(KID_A)]]);
    const lookup = isolateSignerKeys(keys.read, newKeyCopyState(), () => now);
    expect(await lookup(KID_A)).toEqual({ status: 'found', key: jwk(KID_A) });
    now = KEY_COPY_LIFETIME_MS - 1;
    expect(await lookup(KID_A)).toMatchObject({ status: 'found' });
    expect(keys.reads()).toBe(1);
    now = KEY_COPY_LIFETIME_MS;
    await lookup(KID_A);
    expect(keys.reads()).toBe(2);
  });

  it('reads again for an unknown kid at most once per 10 seconds', async () => {
    let now = 0;
    const keys = source([[jwk(KID_A)], [jwk(KID_A), jwk(KID_B)]]);
    const lookup = isolateSignerKeys(keys.read, newKeyCopyState(), () => now);
    await lookup(KID_A);
    now = 1_000;
    expect(await lookup(KID_B)).toEqual({ status: 'unknown' });
    expect(keys.reads()).toBe(1);
    now = KEY_REREAD_INTERVAL_MS;
    expect(await lookup(KID_B)).toMatchObject({ status: 'found' });
    expect(keys.reads()).toBe(2);
  });

  it('shares one read between concurrent lookups', async () => {
    const keys = source([[jwk(KID_A)]]);
    const lookup = isolateSignerKeys(keys.read, newKeyCopyState(), () => 0);
    await Promise.all([lookup(KID_A), lookup(KID_A), lookup(KID_B)]);
    expect(keys.reads()).toBe(1);
  });

  it('keeps a copy under 1 hour old through failed reads, then answers unavailable', async () => {
    let now = 0;
    const keys = source([[jwk(KID_A)], null]);
    const lookup = isolateSignerKeys(keys.read, newKeyCopyState(), () => now);
    await lookup(KID_A);
    now = KEY_COPY_LIFETIME_MS + 1;
    expect(await lookup(KID_A)).toMatchObject({ status: 'found' });
    now = KEY_COPY_FAILURE_HOLD_MS;
    expect(await lookup(KID_A)).toEqual({ status: 'unavailable' });
  });

  it('answers unavailable before any read succeeded, and reads at most once per 10 seconds meanwhile', async () => {
    let now = 0;
    const keys = source([null, null, [jwk(KID_A)]]);
    const lookup = isolateSignerKeys(keys.read, newKeyCopyState(), () => now);
    expect(await lookup(KID_A)).toEqual({ status: 'unavailable' });
    now = KEY_REREAD_INTERVAL_MS - 1;
    for (let index = 0; index < 5; index += 1) {
      expect(await lookup(KID_A)).toEqual({ status: 'unavailable' });
    }
    expect(keys.reads()).toBe(1);
    now = KEY_REREAD_INTERVAL_MS;
    expect(await lookup(KID_A)).toEqual({ status: 'unavailable' });
    expect(keys.reads()).toBe(2);
    now = 2 * KEY_REREAD_INTERVAL_MS;
    expect(await lookup(KID_A)).toMatchObject({ status: 'found' });
    expect(keys.reads()).toBe(3);
  });
});
