import { ModelStatsBenchmarksSchema } from '@kilocode/db/schema';
import {
  getModelStatsSnapshot,
  type ModelStatsCacheEntry,
  type ModelStatsLoadClient,
} from './model-stats-cache';
import { lookupModelWithKiloGatewayFallback } from './model-id-lookup';

const TerminalBenchSchema = ModelStatsBenchmarksSchema.unwrap()
  .pick({ kiloBench: true })
  .optional();

export type TerminalBenchSummary = {
  overallScore: number;
  avgAttemptCostUsd: number;
};

export type TerminalBenchSummaries = ReadonlyMap<string, TerminalBenchSummary>;

/**
 * The terminal-bench view is derived from the model-stats snapshot, so one cached read and
 * `invalidateModelStatsCache` govern it together with the enkrypt publication.
 * `customLlmIds` holds lowercased custom LLM ids, whose results are never published.
 */
export function summarizeTerminalBench(
  entries: readonly ModelStatsCacheEntry[],
  customLlmIds: ReadonlySet<string>
): TerminalBenchSummaries {
  const summaries = new Map<string, TerminalBenchSummary>();

  for (const entry of entries) {
    const stat = entry.stat;
    if (stat.isActive !== true || customLlmIds.has(stat.openrouterId.toLowerCase())) continue;
    const result = TerminalBenchSchema.safeParse(stat.benchmarks);
    if (!result.success) continue;
    const bench = result.data?.kiloBench?.evals['terminal-bench'];
    if (
      !bench ||
      (bench.nAttempts ?? 0) < 5 ||
      bench.avgAttemptCostUsd === null ||
      bench.avgAttemptCostUsd === undefined
    ) {
      continue;
    }
    summaries.set(stat.openrouterId, {
      overallScore: bench.overallScore,
      avgAttemptCostUsd: bench.avgAttemptCostUsd,
    });
  }

  return summaries;
}

export function terminalBenchFor(
  summaries: TerminalBenchSummaries,
  id: string
): TerminalBenchSummary | undefined {
  return lookupModelWithKiloGatewayFallback(id, candidate => summaries.get(candidate));
}

export async function getTerminalBenchSummaries({
  fromDb,
}: { fromDb?: ModelStatsLoadClient } = {}): Promise<TerminalBenchSummaries> {
  const snapshot = await getModelStatsSnapshot({ fromDb }).catch(() => null);
  return snapshot ? summarizeTerminalBench(snapshot.entries, snapshot.customLlmIds) : new Map();
}
