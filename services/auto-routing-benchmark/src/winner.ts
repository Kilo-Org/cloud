import type { BenchmarkModelSummary } from '@kilocode/auto-routing-contracts';

// Same bang-for-buck rule as the routing table, applied to classifier
// summaries (tier '*'): cheapest candidate meeting the accuracy threshold,
// else the most accurate one. Null when there are no graded summaries.
export function pickClassifierWinner(
  summaries: BenchmarkModelSummary[],
  minAccuracy: number
): BenchmarkModelSummary | null {
  const graded = summaries.filter(s => s.tier === '*' && s.cases > 0);
  if (graded.length === 0) return null;
  const cost = (s: BenchmarkModelSummary) => s.avgCostUsd ?? Number.POSITIVE_INFINITY;
  const meeting = graded.filter(s => s.accuracy >= minAccuracy);
  if (meeting.length > 0) {
    return meeting.toSorted((a, b) => cost(a) - cost(b) || b.accuracy - a.accuracy)[0];
  }
  return graded.toSorted((a, b) => b.accuracy - a.accuracy || cost(a) - cost(b))[0];
}
