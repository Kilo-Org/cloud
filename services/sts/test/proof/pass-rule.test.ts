import { describe, expect, it } from 'vitest';
import {
  isDefinitiveRefusal,
  personTokenGate,
  sharedChecks,
  tokenExpOk,
  type SharedRunFacts,
} from '../../proof/vercel-exchange/lib/pass-rule';

// The proof run 3 pass rule (design 4.4): the hard limit of about 100 exchanges and, separately,
// the claim step holding on the real Runtime Cache (at most 3 attempts per region, no 429).

const PASSING: SharedRunFacts = {
  invocations: 2_500,
  served: 2_500,
  functionFailures: 0,
  inMemoryBackend: false,
  attemptsByRegion: { iad1: 1 },
  rateLimited: 0,
  timeToTokenP99: 900,
  timeToTokenMax: 2_000,
  expMatchesBase: true,
  actOk: true,
  distinctInstances: 400,
};

function passed(facts: SharedRunFacts): boolean {
  return Object.values(sharedChecks(facts)).every(Boolean);
}

describe('proof run 3 pass rule', () => {
  it('passes a wave with one exchange per region and no 429', () => {
    expect(passed(PASSING)).toBe(true);
    expect(passed({ ...PASSING, attemptsByRegion: { iad1: 3, fra1: 3 } })).toBe(true);
  });

  it('fails claimHolds for a wave within the hard limit but with many attempts', () => {
    const checks = sharedChecks({ ...PASSING, attemptsByRegion: { iad1: 60 } });
    expect(checks.withinExchangeBudget).toBe(true);
    expect(checks.claimHolds).toBe(false);
  });

  it('fails claimHolds on any 429', () => {
    const checks = sharedChecks({ ...PASSING, attemptsByRegion: { iad1: 2 }, rateLimited: 1 });
    expect(checks.claimHolds).toBe(false);
  });

  it('fails the hard limit above 100 attempts in total', () => {
    const checks = sharedChecks({ ...PASSING, attemptsByRegion: { iad1: 60, fra1: 41 } });
    expect(checks.withinExchangeBudget).toBe(false);
  });

  it('is inconclusive below 200 instances', () => {
    expect(sharedChecks({ ...PASSING, distinctInstances: 199 }).coldWave).toBe(false);
  });
});

describe('served token exp check', () => {
  const now = 1_795_648_600;

  it('needs the exchanging invocation to see its base token exp', () => {
    const exchanged = { source: 'exchanged', baseExp: now + 7200, nowSeconds: now };
    expect(tokenExpOk({ ...exchanged, exchangedExp: now + 7200 })).toBe(true);
    expect(tokenExpOk({ ...exchanged, exchangedExp: now + 7167 })).toBe(false);
  });

  it('accepts a cached token from an earlier base token while it has 60 s left', () => {
    // Vercel renewed the base token 33 s after the one the cached token was exchanged from.
    const renewed = { baseExp: now + 7233, exchangedExp: now + 7200, nowSeconds: now };
    for (const source of ['memory', 'cache', 'cache_after_jitter', 'poll']) {
      expect(tokenExpOk({ ...renewed, source })).toBe(true);
    }
    expect(tokenExpOk({ ...renewed, source: 'cache', exchangedExp: now + 60 })).toBe(true);
    expect(tokenExpOk({ ...renewed, source: 'cache', exchangedExp: now + 59 })).toBe(false);
  });

  it('fails a served answer without an exchanged exp', () => {
    expect(
      tokenExpOk({ source: 'cache', baseExp: now + 7200, exchangedExp: null, nowSeconds: now })
    ).toBe(false);
  });
});

describe('exchange refusals', () => {
  it('counts only a 4xx other than 408 and 429 as a refusal', () => {
    for (const status of [400, 401, 403]) expect(isDefinitiveRefusal(status)).toBe(true);
    for (const status of [408, 429, 500, 502, 503, 'timeout', 'network_error', 'invalid_body']) {
      expect(isDefinitiveRefusal(status)).toBe(false);
    }
  });
});

describe('person-token gate', () => {
  it('holds when user_id survives the exchange or Vercel refuses it', () => {
    expect(personTokenGate(true, 200, true)).toBe('holds');
    expect(personTokenGate(true, 401, null)).toBe('holds');
  });

  it('stops when either token lacks user_id', () => {
    expect(personTokenGate(true, 200, false)).toBe('stops');
    expect(personTokenGate(false, 200, true)).toBe('stops');
    expect(personTokenGate(false, 401, null)).toBe('stops');
  });

  it('is inconclusive when the exchange was unavailable or its answer unreadable', () => {
    for (const status of [429, 500, 503, 'network_error', 'invalid_body']) {
      expect(personTokenGate(true, status, null)).toBe('inconclusive');
    }
  });
});
