import { describe, expect, it } from 'vitest';

import { clampPollIntervalSeconds } from '../../src/util/interval';

describe('clampPollIntervalSeconds', () => {
  it('falls back to 60 seconds for a value that is not a number', () => {
    // A blank var is the common case: `Number('')` is `0`, which is finite, so
    // a naive clamp would floor it to 10 rather than fall back.
    expect(clampPollIntervalSeconds('')).toBe(60);
    expect(clampPollIntervalSeconds('   ')).toBe(60);
    expect(clampPollIntervalSeconds(undefined)).toBe(60);
    expect(clampPollIntervalSeconds('soon')).toBe(60);
  });

  it('clamps to 10..3600 seconds', () => {
    expect(clampPollIntervalSeconds('0')).toBe(10);
    expect(clampPollIntervalSeconds('-5')).toBe(10);
    expect(clampPollIntervalSeconds('9')).toBe(10);
    expect(clampPollIntervalSeconds('10')).toBe(10);
    expect(clampPollIntervalSeconds('120')).toBe(120);
    expect(clampPollIntervalSeconds('3600')).toBe(3600);
    expect(clampPollIntervalSeconds('86400')).toBe(3600);
  });

  it('truncates a fractional value, so a sub-second interval cannot survive', () => {
    expect(clampPollIntervalSeconds('0.5')).toBe(10);
    expect(clampPollIntervalSeconds('90.9')).toBe(90);
  });
});
