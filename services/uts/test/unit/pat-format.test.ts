import { describe, expect, it } from 'vitest';
import {
  createSecret,
  hashOfHex,
  hexOfHash,
  isWellFormedSecret,
  lastFour,
  secretHash,
  secretOfBytes,
} from '../../src/pat/format';
import { credentialScopeCheck } from '../../src/scopes/policy';

/**
 * The PAT and bot key format (design 5.3). The vectors were computed with Node's own
 * `zlib.crc32` and `crypto.createHash('sha256')`, apart from this code, from synthetic bytes.
 */
const SEQUENTIAL = Uint8Array.from({ length: 32 }, (_, index) => index);
const VECTORS = [
  {
    kind: 'pat',
    bytes: new Uint8Array(32),
    value: 'kilo_pat_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcoHjiQ',
    sha256: '967e3e01bee92eb2a3bf0ac49cad013073d1b2bf3da904fedbfbf5324347ff36',
  },
  {
    kind: 'pat',
    bytes: SEQUENTIAL,
    value: 'kilo_pat_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8kQBWZg',
    sha256: 'bd99d4024079f377019377166a2067ee8efdeea24f7491b84f7df04c8b79b753',
  },
  {
    kind: 'bot_key',
    bytes: SEQUENTIAL,
    value: 'kilo_bot_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh88b1miA',
    sha256: 'c64d045ef064390d87d6396298c25d928dc74b8f74d75ef311f9bdd414959517',
  },
] as const;

describe('PAT and bot key format', () => {
  it.each(VECTORS)('builds and accepts the $kind vector', async vector => {
    expect(secretOfBytes(vector.kind, vector.bytes)).toBe(vector.value);
    expect(isWellFormedSecret(vector.kind, vector.value)).toBe(true);
    expect(hexOfHash(await secretHash(vector.value))).toBe(vector.sha256);
    expect(hashOfHex(vector.sha256)).toEqual(await secretHash(vector.value));
    expect(lastFour(vector.value)).toBe(vector.value.slice(-4));
  });

  it('creates 58-character values that pass the offline check, each one new', () => {
    const values = new Set(Array.from({ length: 50 }, () => createSecret('pat')));
    expect(values.size).toBe(50);
    for (const value of values) {
      expect(value).toHaveLength(58);
      expect(isWellFormedSecret('pat', value)).toBe(true);
      expect(isWellFormedSecret('bot_key', value)).toBe(false);
    }
  });

  it('refuses a changed character, a wrong checksum, a non-canonical body and a wrong length', () => {
    const value = VECTORS[1].value;
    const swap = (index: number, character: string) =>
      `${value.slice(0, index)}${character}${value.slice(index + 1)}`;
    for (const changed of [
      swap(20, value[20] === 'B' ? 'C' : 'B'),
      swap(57, value[57] === 'A' ? 'B' : 'A'),
      // The 43rd body character carries 2 bits of padding; a set padding bit is not canonical.
      swap(51, 'f'),
      value.slice(0, -1),
      `${value}A`,
      value.replace('kilo_pat_', 'kilo_rt__'),
      value.replace('kilo_pat_', 'KILO_PAT_'),
    ]) {
      expect(isWellFormedSecret('pat', changed)).toBe(false);
    }
    expect(() => secretOfBytes('pat', new Uint8Array(31))).toThrow();
  });
});

describe('credential scope check', () => {
  it('allows a registered PAT-eligible scope and refuses every other', () => {
    expect(credentialScopeCheck('uts:probe.read', null)).toEqual({ status: 'allowed' });
    expect(credentialScopeCheck('uts:pats.manage', null)).toEqual({ status: 'not_pat_eligible' });
    expect(credentialScopeCheck('gateway:models.read', null)).toEqual({ status: 'unknown_scope' });
  });
});
