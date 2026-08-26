import { describe, expect, it } from 'vitest';

import { parseParam, parsePositiveIntParam } from './route-params';

describe('parseParam', () => {
  it('returns null for a missing value', () => {
    expect(parseParam(undefined)).toBeNull();
  });

  it('returns null for an array value', () => {
    expect(parseParam(['a', 'b'])).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseParam('')).toBeNull();
  });

  it('returns the value when no allowlist is given', () => {
    expect(parseParam('anything')).toBe('anything');
  });

  it('returns null when the value is not in the allowlist', () => {
    expect(parseParam('carrot', ['github', 'gitlab'] as const)).toBeNull();
  });

  it('returns the value when it is in the allowlist', () => {
    expect(parseParam('gitlab', ['github', 'gitlab'] as const)).toBe('gitlab');
  });
});

describe('parsePositiveIntParam', () => {
  it('accepts a plain positive integer', () => {
    expect(parsePositiveIntParam('42')).toBe(42);
  });

  it.each(['12abc', '1.5', '0', '-3', '007', ' 12', '1e3', ''])(
    'rejects the malformed segment %o',
    value => {
      expect(parsePositiveIntParam(value)).toBeNull();
    }
  );

  it('rejects a value beyond exact integer range', () => {
    expect(parsePositiveIntParam('9007199254740993')).toBeNull();
  });

  it('rejects a missing or repeated segment', () => {
    expect(parsePositiveIntParam(undefined)).toBeNull();
    expect(parsePositiveIntParam(['1', '2'])).toBeNull();
  });
});
