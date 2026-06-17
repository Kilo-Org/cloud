import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';

// Picks the best classifier candidate from summaries (routeKey '*') applying:
//   1. Accuracy gate: must meet minAccuracy.
//   2. Optional p95 latency gate: when maxP95LatencyMs is non-null, prefer
//      candidates whose measured p95 latency is within budget.
// Selection order:
//   - Candidates meeting BOTH accuracy and latency → cheapest (tie: highest accuracy).
//   - Candidates meeting accuracy only (latency gate not met) → lowest p95
//     (tie: cheapest). This ensures the admin always sees a winner, even
//     when all models are over budget.
//   - No accuracy threshold met → most accurate (tie: cheapest).
// Returns null when there are no graded summaries at all.
export function pickClassifierWinner(
  summaries: BenchmarkModelSummary[],
  minAccuracy: number,
  maxP95LatencyMs: number | null = null
): BenchmarkModelSummary | null {
  const graded = summaries.filter(s => s.routeKey === '*' && s.cases > 0);
  if (graded.length === 0) return null;
  const cost = (s: BenchmarkModelSummary) => s.avgCostUsd ?? Number.POSITIVE_INFINITY;
  const p95 = (s: BenchmarkModelSummary) => s.p95LatencyMs ?? Number.POSITIVE_INFINITY;

  const meetingAccuracy = graded.filter(s => s.accuracy >= minAccuracy);
  const meetingBoth =
    maxP95LatencyMs !== null
      ? meetingAccuracy.filter(s => s.p95LatencyMs !== null && s.p95LatencyMs <= maxP95LatencyMs)
      : meetingAccuracy;

  if (meetingBoth.length > 0) {
    return meetingBoth.toSorted((a, b) => cost(a) - cost(b) || b.accuracy - a.accuracy)[0];
  }
  if (meetingAccuracy.length > 0) {
    // Latency gate not met: pick lowest p95 (null p95 sorts last), tie-break cheapest.
    return meetingAccuracy.toSorted((a, b) => p95(a) - p95(b) || cost(a) - cost(b))[0];
  }
  return graded.toSorted((a, b) => b.accuracy - a.accuracy || cost(a) - cost(b))[0];
}
