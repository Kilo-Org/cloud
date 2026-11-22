import { ModelStatsBenchmarksSchema } from '@kilocode/db/schema';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import {
  getModelStatsSnapshot,
  type ModelStatsCacheEntry,
  type ModelStatsLoadClient,
  type ModelStatsSnapshot,
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

/**
 * The snapshot is cached and reused by identity, so one entry per snapshot object means the
 * summaries are built once per snapshot load rather than once per caller. A new snapshot (after a
 * TTL expiry or `invalidateModelStatsCache`) gets its own entry, and the WeakMap releases the old
 * one with the snapshot.
 */
const summariesBySnapshot = new WeakMap<ModelStatsSnapshot, TerminalBenchSummaries>();

function summariesOf(snapshot: ModelStatsSnapshot): TerminalBenchSummaries {
  const cached = summariesBySnapshot.get(snapshot);
  if (cached) return cached;
  const summaries = summarizeTerminalBench(snapshot.entries, snapshot.customLlmIds);
  summariesBySnapshot.set(snapshot, summaries);
  return summaries;
}

/**
 * Reports one failure per failed load. During its cooldown the snapshot cache rethrows the recorded
 * error on every call, so keying the warning on that error object keeps an outage to one line
 * instead of one per catalog request. A successful load clears it, so a later failure reports even
 * when it reuses an error object that already warned.
 */
let reportedFailure: unknown = undefined;

function reportLoadFailure(error: unknown): void {
  if (reportedFailure === error) return;
  reportedFailure = error;
  const reason = (error instanceof Error ? error.message : String(error))
    .replace(/\s+/g, ' ')
    .trim();
  warnExceptInTest(
    `[model-stats] terminal-bench summaries unavailable: ${reason}; serving no benchmark summaries`
  );
}

export async function getTerminalBenchSummaries({
  fromDb,
}: { fromDb?: ModelStatsLoadClient } = {}): Promise<TerminalBenchSummaries> {
  const snapshot = await getModelStatsSnapshot({ fromDb }).catch((error: unknown) => {
    reportLoadFailure(error);
    return null;
  });
  if (!snapshot) return new Map();
  reportedFailure = undefined;
  return summariesOf(snapshot);
}
