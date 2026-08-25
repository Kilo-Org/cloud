import { describe, expect, it } from 'vitest';

import { isVersionBelow } from './app-version';

describe('isVersionBelow', () => {
  it('returns true when current is below minimum', () => {
    expect(isVersionBelow('1.0.3', '1.0.4')).toBe(true);
    expect(isVersionBelow('1.9.0', '2.0.0')).toBe(true);
  });

  it('returns false when current equals minimum', () => {
    expect(isVersionBelow('1.0.4', '1.0.4')).toBe(false);
  });

  it('returns false when current is above minimum', () => {
    expect(isVersionBelow('1.0.5', '1.0.4')).toBe(false);
    expect(isVersionBelow('2.0.0', '1.9.9')).toBe(false);
  });

  it('treats a missing segment as 0', () => {
    expect(isVersionBelow('1', '1.0.0')).toBe(false);
    expect(isVersionBelow('1', '1.0.1')).toBe(true);
  });

  it('treats a non-numeric segment as 0', () => {
    // "1.x" coerces to "1.0"
    expect(isVersionBelow('1.x', '1.0.0')).toBe(false);
    expect(isVersionBelow('1.x', '1.1.0')).toBe(true);
    expect(isVersionBelow('1.x', '2.0.0')).toBe(true);
  });
});
