/**
 * Client-side view of an owner's analysis capacity.
 *
 * `loading`, `error`, `full` and `available` used to collapse into a single
 * boolean, so a row could only disable its Analyze action without saying why.
 * The state is derived here once and shared by every surface that offers the
 * action (the findings list and the analysis detail panel).
 */
export type SecurityAnalysisCapacityState = 'loading' | 'error' | 'available' | 'full';

/**
 * How often the capacity read repeats while the owner is at the limit. Bounded
 * to the confirmed-full state: a user who stays on the list sees the action
 * re-enable once a running analysis finishes, and a settled or free capacity
 * never polls.
 */
export const SECURITY_ANALYSIS_CAPACITY_POLL_MS = 5000;

export type SecurityAnalysisCapacityCounts = {
  runningCount?: number | undefined;
  concurrencyLimit?: number | undefined;
  isLoading: boolean;
  isError: boolean;
};

/**
 * Derive the state from the `listFindings` counters the server computes with
 * `canStartAnalysis` (`runningCount < concurrencyLimit` is exactly `allowed`).
 *
 * A failed read is reported before a loading one so a retryable error never
 * masquerades as a spinner, and absent counters under a settled read stay
 * `loading`: the client has no authoritative count, so it must not offer the
 * action.
 */
export function getSecurityAnalysisCapacityState(
  capacity: SecurityAnalysisCapacityCounts
): SecurityAnalysisCapacityState {
  if (capacity.isError) {
    return 'error';
  }
  if (capacity.isLoading) {
    return 'loading';
  }
  const { runningCount, concurrencyLimit } = capacity;
  if (runningCount === undefined || concurrencyLimit === undefined) {
    return 'loading';
  }
  return runningCount < concurrencyLimit ? 'available' : 'full';
}
