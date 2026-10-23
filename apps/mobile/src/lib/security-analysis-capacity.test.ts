import { describe, expect, it } from 'vitest';

import {
  getSecurityAnalysisCapacityState,
  SECURITY_ANALYSIS_CAPACITY_POLL_MS,
} from '@/lib/security-analysis-capacity';

const idle = { isLoading: false, isError: false };

describe('Security Agent analysis capacity state', () => {
  it('is available exactly when the server would allow a start', () => {
    // Matches canStartAnalysis: runningCount < concurrencyLimit.
    expect(
      getSecurityAnalysisCapacityState({ ...idle, runningCount: 0, concurrencyLimit: 3 })
    ).toBe('available');
    expect(
      getSecurityAnalysisCapacityState({ ...idle, runningCount: 2, concurrencyLimit: 3 })
    ).toBe('available');
    expect(
      getSecurityAnalysisCapacityState({ ...idle, runningCount: 3, concurrencyLimit: 3 })
    ).toBe('full');
  });

  it('reports full when the owner already exceeds the limit', () => {
    // A lowered limit (or a cap change mid-flight) can leave more analyses
    // running than the limit allows; the action must stay blocked either way.
    expect(
      getSecurityAnalysisCapacityState({ ...idle, runningCount: 4, concurrencyLimit: 3 })
    ).toBe('full');
    expect(
      getSecurityAnalysisCapacityState({ ...idle, runningCount: 0, concurrencyLimit: 0 })
    ).toBe('full');
  });

  it('reports a failed read before any count state', () => {
    expect(
      getSecurityAnalysisCapacityState({
        isLoading: false,
        isError: true,
        runningCount: undefined,
        concurrencyLimit: undefined,
      })
    ).toBe('error');
    // A failed background refetch keeps the last counts, but the read itself
    // still failed: a retry, not a spinner, is what the user needs.
    expect(
      getSecurityAnalysisCapacityState({
        isLoading: false,
        isError: true,
        runningCount: 0,
        concurrencyLimit: 3,
      })
    ).toBe('error');
  });

  it('stays loading until a read settles with both counters', () => {
    expect(
      getSecurityAnalysisCapacityState({
        isLoading: true,
        isError: false,
        runningCount: undefined,
        concurrencyLimit: undefined,
      })
    ).toBe('loading');
    expect(
      getSecurityAnalysisCapacityState({
        isLoading: false,
        isError: false,
        runningCount: 1,
        concurrencyLimit: undefined,
      })
    ).toBe('loading');
  });

  it('polls on a bounded interval while at the limit', () => {
    expect(SECURITY_ANALYSIS_CAPACITY_POLL_MS).toBeGreaterThan(0);
    expect(SECURITY_ANALYSIS_CAPACITY_POLL_MS).toBeLessThanOrEqual(10_000);
  });
});
