// The proof run 3 pass rule for `drive.ts --mode shared` (design 4.4), kept apart from the driver so
// `test/proof/pass-rule.test.ts` can check it. No imports: `node drive.ts` loads it as is.

/** About 100 exchanges per burst per project or team (proof runs 1 and 3): the hard limit. */
export const BUDGET_EXCHANGES_PER_WAVE = 100;
/**
 * The claim step should leave about one exchange per region and audience; 3 allows a lost
 * exchanger or a marker race. More means the claim does not hold on the real Runtime Cache.
 */
export const CLAIM_EXCHANGES_PER_REGION = 3;
/**
 * Design 3 states the cold-start budget as one exchange per audience, then two parallel fetches,
 * with no millisecond figure. The harness holds time-to-token to p99 3 s and max 20 s (the longest
 * STS waits for a bundle) inside the function.
 */
export const TIME_TO_TOKEN_P99_MS = 3_000;
export const TIME_TO_TOKEN_MAX_MS = 20_000;
/** Fewer distinct instances than this is not a cold wave: the run is inconclusive, not a pass. */
export const MIN_DISTINCT_INSTANCES = 200;
/** Design 3: about 2,200 Vercel instance starts per release, reported next to the measured count. */
export const DESIGN_PEAK_INSTANCES = 2_200;

export type SharedRunFacts = {
  invocations: number;
  served: number;
  functionFailures: number;
  inMemoryBackend: boolean;
  /** One audience per run, so this is per region and audience. */
  attemptsByRegion: Record<string, number>;
  rateLimited: number;
  timeToTokenP99: number | null;
  timeToTokenMax: number | null;
  expMatchesBase: boolean;
  actOk: boolean;
  distinctInstances: number;
};

export function sharedChecks(facts: SharedRunFacts) {
  const attempts = Object.values(facts.attemptsByRegion);
  const total = attempts.reduce((sum, value) => sum + value, 0);
  return {
    allServed: facts.served === facts.invocations && facts.functionFailures === 0,
    sharedBackend: !facts.inMemoryBackend,
    withinExchangeBudget:
      total <= BUDGET_EXCHANGES_PER_WAVE &&
      attempts.every(value => value <= BUDGET_EXCHANGES_PER_WAVE),
    claimHolds:
      attempts.every(value => value <= CLAIM_EXCHANGES_PER_REGION) && facts.rateLimited === 0,
    withinTimeToTokenBudget:
      (facts.timeToTokenP99 ?? Infinity) <= TIME_TO_TOKEN_P99_MS &&
      (facts.timeToTokenMax ?? Infinity) <= TIME_TO_TOKEN_MAX_MS,
    expMatchesBase: facts.expMatchesBase,
    actOk: facts.actOk,
    coldWave: facts.distinctInstances >= MIN_DISTINCT_INSTANCES,
  };
}
