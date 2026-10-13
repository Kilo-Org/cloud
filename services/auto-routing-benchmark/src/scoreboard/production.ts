type ClassifiedDecisionGroup = {
  n: number;
  sampled: boolean;
  route: string;
  cacheHit: boolean | null;
  cost: number | null;
};

export function estimateClassifiedMetrics(
  groups: readonly ClassifiedDecisionGroup[],
  sampleRate: number
) {
  const sampledWeight = sampleRate > 0 ? 1 / sampleRate : 0;
  let classifiedCount = 0;
  let cacheCount = 0;
  let cacheHits = 0;
  let costCount = 0;
  let costTotal = 0;
  const routeCounts: Record<string, number> = {};
  for (const group of groups) {
    const weightedCount = group.n * (group.sampled ? sampledWeight : 1);
    classifiedCount += weightedCount;
    routeCounts[group.route] = (routeCounts[group.route] ?? 0) + weightedCount;
    if (group.cacheHit !== null) {
      cacheCount += weightedCount;
      if (group.cacheHit) cacheHits += weightedCount;
    }
    if (group.cost !== null) {
      costCount += weightedCount;
      costTotal += group.cost * weightedCount;
    }
  }
  return {
    cacheHitRate: cacheCount ? cacheHits / cacheCount : null,
    classifierPerRequestUsd: costCount ? costTotal / costCount : null,
    routeMix: classifiedCount
      ? Object.fromEntries(
          Object.entries(routeCounts).map(([route, n]) => [route, n / classifiedCount])
        )
      : {},
  };
}
