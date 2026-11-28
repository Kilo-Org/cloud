import { validate, version } from 'uuid';
import { describe, expect, it } from 'vitest';
import { createUsageId, deterministicUuidV7 } from './usage-id';

describe('createUsageId', () => {
  it('mints distinct UUIDv7 ids', () => {
    const ids = Array.from({ length: 1000 }, () => createUsageId());

    for (const id of ids) {
      expect(validate(id)).toBe(true);
      expect(version(id)).toBe(7);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('embeds the minting time', () => {
    const before = Date.now();
    const id = createUsageId();
    const after = Date.now();

    const timestamp = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('deterministicUuidV7', () => {
  const hash = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const milliseconds = 1_767_225_600_123;

  it('is stable for the same inputs', () => {
    expect(deterministicUuidV7(milliseconds, hash)).toBe(deterministicUuidV7(milliseconds, hash));
  });

  it('is a valid UUIDv7 with the timestamp embedded', () => {
    const id = deterministicUuidV7(milliseconds, hash);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(7);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBe(milliseconds);
  });

  it('takes the 74 bits after version and variant from the hash', () => {
    expect(deterministicUuidV7(milliseconds, hash)).toBe('019b76da-a87b-7a1b-ac3d-4e5f60718293');
    expect(deterministicUuidV7(0, 'f'.repeat(64))).toBe('00000000-0000-7fff-bfff-ffffffffffff');
    expect(deterministicUuidV7(2 ** 48 - 1, '0'.repeat(64))).toBe(
      'ffffffff-ffff-7000-8000-000000000000'
    );
  });

  it('separates different times and different hashes', () => {
    const base = deterministicUuidV7(milliseconds, hash);

    expect(deterministicUuidV7(milliseconds + 1, hash)).not.toBe(base);
    expect(deterministicUuidV7(milliseconds, `${hash.slice(0, 18)}0${hash.slice(19)}`)).not.toBe(
      base
    );
  });

  it('rejects a timestamp outside 48 bits', () => {
    for (const bad of [-1, 1.5, 2 ** 48, Number.NaN]) {
      expect(() => deterministicUuidV7(bad, hash)).toThrow(RangeError);
    }
  });

  it('rejects a hash that is too short or not hex', () => {
    expect(() => deterministicUuidV7(milliseconds, 'abc')).toThrow(RangeError);
    expect(() => deterministicUuidV7(milliseconds, 'z'.repeat(64))).toThrow(RangeError);
  });
});
