import type { Dist, Scoreboard } from './schema';

type Axis = 'latency' | 'cost' | 'quality';
type Direction = 'better' | 'worse' | 'flat';
type Metric = {
  name: string;
  axis: Axis;
  base: number | null;
  head: number | null;
  higherIsBetter: boolean;
};

export function compareScoreboards(
  base: Scoreboard,
  head: Scoreboard,
  { relativeOnly }: { relativeOnly: boolean }
): string {
  const metrics: Metric[] = [];
  const add = (
    name: string,
    axis: Axis,
    baseValue: number | null,
    headValue: number | null,
    higherIsBetter = false
  ) => metrics.push({ name, axis, base: baseValue, head: headValue, higherIsBetter });
  const addDist = (name: string, baseValue: Dist | null, headValue: Dist | null) => {
    for (const percentile of ['p50', 'p90', 'p99'] as const) {
      add(
        `${name}.${percentile}`,
        'latency',
        baseValue?.[percentile] ?? null,
        headValue?.[percentile] ?? null
      );
    }
  };

  for (const source of ['gateway', 'worker'] as const) {
    addDist(
      `latency.routerOverheadMs.${source}`,
      base.latency.routerOverheadMs[source],
      head.latency.routerOverheadMs[source]
    );
  }
  for (const scenario of ['cold', 'warm_new_turn', 'exact_repeat'] as const) {
    const before = base.latency.routerOverheadMs.replay?.[scenario] ?? null;
    const after = head.latency.routerOverheadMs.replay?.[scenario] ?? null;
    addDist(`latency.routerOverheadMs.replay.${scenario}`, before, after);
    add(
      `latency.routerOverheadMs.replay.${scenario}.errors`,
      'latency',
      before?.errors ?? null,
      after?.errors ?? null
    );
    add(`replay.${scenario}.costUsd`, 'cost', before?.costUsd ?? null, after?.costUsd ?? null);
  }
  const phases = new Set([
    ...Object.keys(base.latency.workerPhasesMs ?? {}),
    ...Object.keys(head.latency.workerPhasesMs ?? {}),
  ]);
  for (const phase of [...phases].sort()) {
    addDist(
      `latency.workerPhasesMs.${phase}`,
      base.latency.workerPhasesMs?.[phase] ?? null,
      head.latency.workerPhasesMs?.[phase] ?? null
    );
  }
  add(
    'latency.cacheHitRate',
    'latency',
    base.latency.cacheHitRate,
    head.latency.cacheHitRate,
    true
  );
  addDist('latency.modelTtftMs.prod', base.latency.modelTtftMs.prod, head.latency.modelTtftMs.prod);
  add(
    'latency.modelTtftMs.benchmarkP50Weighted',
    'latency',
    base.latency.modelTtftMs.benchmarkP50Weighted,
    head.latency.modelTtftMs.benchmarkP50Weighted
  );
  for (const statistic of ['mean', 'p50'] as const) {
    add(
      `cost.prodPerRequestUsd.${statistic}`,
      'cost',
      base.cost.prodPerRequestUsd[statistic],
      head.cost.prodPerRequestUsd[statistic]
    );
  }
  for (const name of [
    'prodCacheReadShare',
    'classifierPerRequestUsd',
    'switchRate',
    'benchmarkPerTaskUsdWeighted',
  ] as const) {
    add(`cost.${name}`, 'cost', base.cost[name], head.cost[name], name === 'prodCacheReadShare');
  }
  for (const name of ['benchmarkAccuracyWeighted', 'classifierRouteAccuracy', 'heldOut'] as const) {
    add(`quality.${name}`, 'quality', base.quality[name], head.quality[name], true);
  }

  const directions: Record<Axis, Set<Direction>> = {
    latency: new Set(),
    cost: new Set(),
    quality: new Set(),
  };
  const lines = relativeOnly
    ? ['| Metric | Relative delta % | Direction |', '|---|---|---|']
    : ['| Metric | Base | Head | Relative delta % | Direction |', '|---|---|---|---|---|'];
  for (const metric of metrics) {
    if (metric.base === null && metric.head === null) continue;
    let deltaText = 'n/a';
    let direction: Direction | null = null;
    if (metric.base !== null && metric.head !== null) {
      const delta =
        metric.base === 0
          ? metric.head === 0
            ? 0
            : Number.POSITIVE_INFINITY
          : ((metric.head - metric.base) / metric.base) * 100;
      direction =
        Math.abs(delta) < 1 ? 'flat' : delta > 0 === metric.higherIsBetter ? 'better' : 'worse';
      deltaText = Number.isFinite(delta) ? `${delta > 0 ? '+' : ''}${delta.toFixed(2)}%` : '+∞%';
      directions[metric.axis].add(direction);
    }
    const cells = [metric.name];
    if (!relativeOnly) cells.push(String(metric.base ?? 'n/a'), String(metric.head ?? 'n/a'));
    cells.push(deltaText, direction ?? 'n/a');
    lines.push(`| ${cells.join(' | ')} |`);
  }
  lines.push('');
  for (const axis of ['latency', 'cost', 'quality'] as const) {
    const observed = directions[axis];
    const summary =
      observed.has('better') && !observed.has('worse')
        ? 'better'
        : observed.has('worse') && !observed.has('better')
          ? 'worse'
          : observed.has('better') && observed.has('worse')
            ? 'mixed'
            : 'flat';
    lines.push(`${axis}: ${summary}`);
  }
  return lines.join('\n');
}
