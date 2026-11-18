/**
 * Unit tests for the dependency-free TOTP core (src/otp/totp.ts).
 *
 * Every test injects the timestamp; nothing here reads the wall clock. The
 * RFC 6238 vectors pin the HMAC-SHA-1 construction and the dynamic truncation
 * against the published values, and the boundary tests pin the ±1-step window.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHENTICATOR_DIGITS,
  AUTHENTICATOR_STEP_SECONDS,
  AUTHENTICATOR_WINDOW_STEPS,
  InvalidBase32Error,
  authenticatorUri,
  currentStep,
  decodeBase32,
  encodeBase32,
  generateAuthenticatorSecret,
  totpCode,
  verifyTotp,
} from './totp';

/** The RFC 6238 Appendix B shared secret, `12345678901234567890` as ASCII. */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** The first millisecond of a step, so `currentStep` is exactly that step. */
const stepMs = (step: number): number => step * AUTHENTICATOR_STEP_SECONDS * 1000;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('constants', () => {
  it('exposes the RFC 6238 parameters the worker relies on', () => {
    expect(AUTHENTICATOR_STEP_SECONDS).toBe(30);
    expect(AUTHENTICATOR_DIGITS).toBe(6);
    expect(AUTHENTICATOR_WINDOW_STEPS).toBe(1);
  });
});

describe('encodeBase32 / decodeBase32', () => {
  it('encodes RFC 4648 vectors, unpadded and uppercase', () => {
    expect(encodeBase32(utf8('foo'))).toBe('MZXW6');
    expect(encodeBase32(utf8('foobar'))).toBe('MZXW6YTBOI');
    expect(encodeBase32(utf8('12345678901234567890'))).toBe(RFC_SECRET);
  });

  it('round-trips arbitrary bytes, including each length that shifts the bit boundary', () => {
    for (let length = 1; length <= 20; length++) {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        bytes[index] = (index * 37 + length * 11) & 0xff;
      }
      expect(decodeBase32(encodeBase32(bytes))).toEqual(bytes);
    }
  });

  it('accepts the padded form an external authenticator app may use', () => {
    expect(decodeBase32('MZXW6===')).toEqual(utf8('foo'));
    expect(decodeBase32('MZXW6YTBOI======')).toEqual(utf8('foobar'));
  });

  it('rejects an empty secret', () => {
    expect(() => decodeBase32('')).toThrow(InvalidBase32Error);
  });

  it('rejects characters outside the base32 alphabet', () => {
    for (const secret of ['abc', 'A1', 'AAAAAAAA!!!!', 'MZXW6-YTBOI', 'A C']) {
      expect(() => decodeBase32(secret), secret).toThrow(InvalidBase32Error);
    }
  });

  it('rejects a truncated secret rather than returning a partial key', () => {
    // 1, 3 and 6 data characters leave a partial byte; a padded secret whose
    // length is not a multiple of eight is equally incomplete.
    for (const secret of ['A', 'AAA', 'AAAAAA', 'MZXW6=']) {
      expect(() => decodeBase32(secret), secret).toThrow(InvalidBase32Error);
    }
  });

  it('rejects a secret whose unused trailing bits are set (non-canonical)', () => {
    // '74' encodes one 0xff byte; '75' differs only in the unused trailing bit.
    expect(decodeBase32('74')).toEqual(new Uint8Array([0xff]));
    expect(() => decodeBase32('75')).toThrow(InvalidBase32Error);
  });
});

describe('generateAuthenticatorSecret', () => {
  it('returns 32 unpadded base32 characters (20 bytes)', () => {
    const secret = generateAuthenticatorSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeBase32(secret)).toHaveLength(20);
  });

  it('returns a fresh secret on every call', () => {
    expect(generateAuthenticatorSecret()).not.toBe(generateAuthenticatorSecret());
  });
});

describe('currentStep', () => {
  it('maps a timestamp onto the 30-second step grid', () => {
    expect(currentStep(0)).toBe(0);
    expect(currentStep(29_999)).toBe(0);
    expect(currentStep(30_000)).toBe(1);
    expect(currentStep(59_999)).toBe(1);
    expect(currentStep(60_000)).toBe(2);
  });
});

describe('totpCode', () => {
  it('matches the RFC 6238 Appendix B vectors truncated to 6 digits', async () => {
    const vectors: Array<[number, string]> = [
      [59, '287082'],
      [1_111_111_109, '081804'],
      [1_111_111_111, '050471'],
      [1_234_567_890, '005924'],
      [2_000_000_000, '279037'],
      [20_000_000_000, '353130'],
    ];
    for (const [seconds, expected] of vectors) {
      await expect(totpCode(RFC_SECRET, seconds * 1000)).resolves.toBe(expected);
    }
  });

  it('zero-pads a code that truncates below six digits', async () => {
    await expect(totpCode(RFC_SECRET, 1_234_567_890 * 1000)).resolves.toBe('005924');
  });

  it('is deterministic for one secret and step', async () => {
    const nowMs = stepMs(37_037_036);
    const sameStep = nowMs + 29_000; // the last second of the same 30-second step
    expect(currentStep(sameStep)).toBe(currentStep(nowMs));
    const first = await totpCode(RFC_SECRET, nowMs);
    const second = await totpCode(RFC_SECRET, sameStep);
    expect(second).toBe(first);
  });

  it('rejects a malformed secret instead of deriving a code', async () => {
    await expect(totpCode('not-base32!', 0)).rejects.toThrow(InvalidBase32Error);
  });
});

describe('verifyTotp', () => {
  it('accepts the current step and reports which step matched', async () => {
    const nowMs = 1_111_111_109 * 1000;
    const step = currentStep(nowMs);
    const code = await totpCode(RFC_SECRET, nowMs);
    await expect(verifyTotp(RFC_SECRET, code, nowMs)).resolves.toEqual({ ok: true, step });
  });

  it('accepts the neighbouring steps and rejects two steps away', async () => {
    const step = 37_037_036;
    const nowMs = stepMs(step);
    const previous = await totpCode(RFC_SECRET, stepMs(step - 1));
    const next = await totpCode(RFC_SECRET, stepMs(step + 1));
    const tooOld = await totpCode(RFC_SECRET, stepMs(step - 2));
    const tooNew = await totpCode(RFC_SECRET, stepMs(step + 2));

    await expect(verifyTotp(RFC_SECRET, previous, nowMs)).resolves.toEqual({
      ok: true,
      step: step - 1,
    });
    await expect(verifyTotp(RFC_SECRET, next, nowMs)).resolves.toEqual({
      ok: true,
      step: step + 1,
    });
    await expect(verifyTotp(RFC_SECRET, tooOld, nowMs)).resolves.toEqual({ ok: false });
    await expect(verifyTotp(RFC_SECRET, tooNew, nowMs)).resolves.toEqual({ ok: false });
  });

  it('verifies the same secret across successive steps and reports the old step', async () => {
    const step = 37_037_036;
    const code = await totpCode(RFC_SECRET, stepMs(step));

    // A code from step k is still within the window at k+1, and the matched
    // step stays k so the caller can refuse a replay of a recorded step.
    await expect(verifyTotp(RFC_SECRET, code, stepMs(step))).resolves.toEqual({
      ok: true,
      step,
    });
    await expect(verifyTotp(RFC_SECRET, code, stepMs(step + 1))).resolves.toEqual({
      ok: true,
      step,
    });
    await expect(verifyTotp(RFC_SECRET, code, stepMs(step + 2))).resolves.toEqual({ ok: false });
  });

  it('rejects a code from a different secret', async () => {
    const nowMs = 1_111_111_109 * 1000;
    const otherSecret = encodeBase32(utf8('abcdefghijklmnopqrst'));
    const otherCode = await totpCode(otherSecret, nowMs);
    expect(otherCode).not.toBe(await totpCode(RFC_SECRET, nowMs));
    await expect(verifyTotp(RFC_SECRET, otherCode, nowMs)).resolves.toEqual({ ok: false });
    // The other secret still verifies its own code: the two are not interchangeable.
    await expect(verifyTotp(otherSecret, otherCode, nowMs)).resolves.toEqual({
      ok: true,
      step: currentStep(nowMs),
    });
  });

  it('normalizes surrounding whitespace and a single interior space', async () => {
    const nowMs = 1_111_111_109 * 1000;
    const code = await totpCode(RFC_SECRET, nowMs);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    for (const submitted of [spaced, `  ${spaced}  `, `\t${code}\n`]) {
      await expect(verifyTotp(RFC_SECRET, submitted, nowMs)).resolves.toEqual({
        ok: true,
        step: currentStep(nowMs),
      });
    }
  });

  it('refuses a value that is not exactly six digits', async () => {
    const nowMs = 1_111_111_109 * 1000;
    const code = await totpCode(RFC_SECRET, nowMs);
    const malformed = [
      '',
      '   ',
      '12345',
      '1234567',
      'abcdef',
      `${code.slice(0, 3)} ${code.slice(3, 4)} ${code.slice(4)}`, // two spaces
      `-${code}`,
    ];
    for (const submitted of malformed) {
      await expect(verifyTotp(RFC_SECRET, submitted, nowMs), submitted).resolves.toEqual({
        ok: false,
      });
    }
  });

  it('refuses a malformed code without decoding the secret (no HMAC runs)', async () => {
    // A malformed secret would throw from decodeBase32; a `{ ok: false }` here
    // proves the length gate answers before any key is imported.
    await expect(verifyTotp('not-base32!', 'abc', 0)).resolves.toEqual({ ok: false });
    await expect(verifyTotp('', '', 0)).resolves.toEqual({ ok: false });
  });

  it('never logs a secret or a code', async () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(method =>
      vi.spyOn(console, method as 'log')
    );
    const secret = generateAuthenticatorSecret();
    const nowMs = 1_111_111_109 * 1000;
    const code = await totpCode(secret, nowMs);
    await verifyTotp(secret, code, nowMs);
    await verifyTotp(secret, '000000', nowMs);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});

describe('authenticatorUri', () => {
  it('is deterministic and carries the encoded secret and issuer', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const first = authenticatorUri({ secret, account: 'admin@kilo.ai' });
    const second = authenticatorUri({ secret, account: 'admin@kilo.ai' });

    expect(second).toBe(first);
    expect(first).toBe(
      `otpauth://totp/Kilo%3AMCP-admin%40kilo.ai?secret=${secret}` +
        '&issuer=Kilo&algorithm=SHA1&digits=6&period=30'
    );
  });

  it('URL-encodes an account with reserved characters', () => {
    const uri = authenticatorUri({ secret: 'MZXW6', account: 'a/b c' });
    expect(uri.startsWith('otpauth://totp/Kilo%3AMCP-a%2Fb%20c?')).toBe(true);
  });
});
