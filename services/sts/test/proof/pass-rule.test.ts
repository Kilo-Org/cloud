import { describe, expect, it } from 'vitest';
import { sharedChecks, type SharedRunFacts } from '../../proof/vercel-exchange/lib/pass-rule';

// The proof run 2 pass rule (design 4.4): the hard limit of about 100 exchanges and, separately,
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

describe('proof run 2 pass rule', () => {
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
