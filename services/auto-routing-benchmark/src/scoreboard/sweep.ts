import type { OfflineSweep } from './schema';

type SweepResult = OfflineSweep['pairs'][number]['results'][number];

export function summarizeSweep(pairs: OfflineSweep['pairs']): OfflineSweep['summaries'] {
  return pairs.flatMap(pair => {
    const groups = new Map<string, SweepResult[]>();
    for (const result of pair.results) {
      const key = JSON.stringify([result.routeKey, result.split]);
      const group = groups.get(key);
      if (group) group.push(result);
      else groups.set(key, [result]);
    }
    return [...groups.values()].map(results => {
      const graded = results.filter(
        (result): result is SweepResult & { score: number } =>
          result.score !== null &&
          (result.error === null ||
            result.error === 'usage_missing' ||
            result.error === 'OpenRouter response is missing answer content')
      );
      const costs = graded.flatMap(result => (result.costUsd === null ? [] : [result.costUsd]));
      const latencies = graded.map(result => result.latencyMs).sort((a, b) => a - b);
      const middle = Math.floor(latencies.length / 2);
      return {
        model: pair.model,
        variant: pair.variant,
        routeKey: results[0].routeKey,
        split: results[0].split,
        accuracy:
          graded.length > 0
            ? graded.reduce((sum, result) => sum + result.score, 0) / graded.length
            : null,
        cases: graded.length,
        errors: results.length - graded.length,
        avgCostUsd:
          costs.length > 0 ? costs.reduce((sum, cost) => sum + cost, 0) / costs.length : null,
        p50LatencyMs:
          latencies.length === 0
            ? null
            : latencies.length % 2 === 0
              ? (latencies[middle - 1] + latencies[middle]) / 2
              : latencies[middle],
      };
    });
  });
}
