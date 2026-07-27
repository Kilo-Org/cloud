import { describe, expect, it } from 'vitest';
import { prefixUpperBound } from './events.js';

/**
 * `findByEntityPrefix` matches entity_id prefixes with a half-open range
 * [prefix, prefixUpperBound(prefix)) instead of a SQL LIKE, because LIKE throws
 * "LIKE or GLOB pattern too complex" once the pattern exceeds 50 KB. These
 * cover the bound arithmetic that makes the range equivalent to `LIKE prefix%`.
 */
describe('prefixUpperBound', () => {
  it('increments the final code unit so the range is a half-open prefix scan', () => {
    // entity_id prefixes end in '/'; keys under them (e.g. `${p}<id>`) sort
    // below the incremented bound because '/'(0x2F) < the next code unit.
    expect(prefixUpperBound('preparation/attempt/')).toBe('preparation/attempt0');
    expect(prefixUpperBound('preparation/attempt/abc/step/')).toBe('preparation/attempt/abc/step0');
  });

  it('brackets exactly the keys that LIKE `${prefix}%` would match', () => {
    const prefix = 'preparation/attempt/abc/step/';
    const upper = prefixUpperBound(prefix);
    expect(upper).not.toBeNull();
    const matches = (key: string) => key >= prefix && (upper === null || key < upper);

    expect(matches('preparation/attempt/abc/step/1')).toBe(true);
    expect(matches('preparation/attempt/abc/step/zzz')).toBe(true);
    expect(matches('preparation/attempt/abc/step/')).toBe(true);
    // Not under the prefix.
    expect(matches('preparation/attempt/abc/steq')).toBe(false);
    expect(matches('preparation/attempt/abd')).toBe(false);
  });

  it('does not throw on a pathologically large prefix (the crash this replaces)', () => {
    const huge = 'preparation/attempt/' + 'a'.repeat(100_000) + '/step/';
    expect(() => prefixUpperBound(huge)).not.toThrow();
    expect(prefixUpperBound(huge)).toBe('preparation/attempt/' + 'a'.repeat(100_000) + '/step0');
  });

  it('returns null when no finite upper bound exists', () => {
    expect(prefixUpperBound('')).toBeNull();
    expect(prefixUpperBound('￿')).toBeNull();
  });

  it('carries when the final code units are U+FFFF', () => {
    // 'A￿' -> increment carries past the max unit to 'B'.
    expect(prefixUpperBound('A￿')).toBe('B');
  });
});
