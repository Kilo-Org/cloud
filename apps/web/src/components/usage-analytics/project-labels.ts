import {
  parseBenchmarkProjectId,
  type BenchmarkProjectRef,
} from '@kilocode/auto-routing-contracts';

/** Suffix that marks a project row as benchmark spend rather than a real workspace. */
const BENCHMARK_LABEL_SUFFIX = ' (benchmark pool)';

function benchmarkLabel(benchmark: BenchmarkProjectRef, ambiguousSlug: boolean): string {
  const suffix = ambiguousSlug
    ? ` (benchmark pool, ${benchmark.routerId.slice(0, 8)})`
    : BENCHMARK_LABEL_SUFFIX;
  return `${benchmark.slug}${suffix}`;
}

/**
 * Display label for one usage `project_id`.
 *
 * Benchmark spend is attributed to the reserved benchmark project namespace, so
 * its rows show the saved pool name instead of the raw identifier. Every other
 * project keeps its stored value, and the empty DBT sentinel reads as
 * unattributed.
 */
export function projectDisplayLabel(value: string, unattributedLabel: string): string {
  if (value === '') return unattributedLabel;
  const benchmark = parseBenchmarkProjectId(value);
  return benchmark ? `${benchmark.slug}${BENCHMARK_LABEL_SUFFIX}` : value;
}

/**
 * Labels for a set of project values, keyed by the full stored value so two
 * pools that share a slug never collapse into one row.
 *
 * A slug shared by more than one benchmark pool (a recreated pool, or the same
 * name in two child organizations) gets a short router-id suffix so the rows
 * stay distinguishable while both still read as the pool they belong to.
 */
export function projectDisplayLabels(
  values: readonly string[],
  unattributedLabel: string
): Map<string, string> {
  const parsed = values.flatMap(value => {
    const benchmark = parseBenchmarkProjectId(value);
    return benchmark ? [{ value, benchmark }] : [];
  });
  const slugCounts = new Map<string, number>();
  for (const { benchmark } of parsed) {
    slugCounts.set(benchmark.slug, (slugCounts.get(benchmark.slug) ?? 0) + 1);
  }
  const ambiguous = new Set([...slugCounts].filter(([, count]) => count > 1).map(([slug]) => slug));

  return new Map(
    values.map(value => {
      const benchmark = parseBenchmarkProjectId(value);
      return [
        value,
        benchmark
          ? benchmarkLabel(benchmark, ambiguous.has(benchmark.slug))
          : value === ''
            ? unattributedLabel
            : value,
      ];
    })
  );
}
