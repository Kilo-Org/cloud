import { describe, expect, it } from 'vitest';

import { parseParam } from './route-params';

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
