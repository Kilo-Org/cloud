import { describe, expect, it } from 'vitest';

import { checkGraceExpired, GATEWAY_502_GRACE_MS } from './gateway-502-grace';
import { INITIAL_STATE, reduce } from './machine';

describe('checkGraceExpired', () => {
  it('is false when no 502 has been observed', () => {
    expect(checkGraceExpired(INITIAL_STATE, 1_000_000)).toBe(false);
  });

  it('is false during the grace window', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 0,
    });
    expect(checkGraceExpired(s, GATEWAY_502_GRACE_MS - 1)).toBe(false);
  });

  it('is true exactly at the grace boundary', () => {
    const s = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 0,
    });
    expect(checkGraceExpired(s, GATEWAY_502_GRACE_MS)).toBe(true);
  });

  it('measures from the first 502, not the most recent', () => {
    let s = reduce(INITIAL_STATE, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 1000,
    });
    s = reduce(s, {
      type: 'gateway-readiness-changed',
      ready: false,
      settled: false,
      status: 502,
      nowMs: 5000,
    });
    // 1_000 + 30_000 = 31_000; at 30_999 we're still 1ms short.
    expect(checkGraceExpired(s, 30_999)).toBe(false);
    expect(checkGraceExpired(s, 31_000)).toBe(true);
  });
});
