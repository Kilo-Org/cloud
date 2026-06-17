import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { readDb } from '@/lib/drizzle';
import { ModelStatsBenchmarksSchema, modelStats } from '@kilocode/db/schema';
import { and, eq, notLike } from 'drizzle-orm';

const TerminalBenchSchema = ModelStatsBenchmarksSchema.unwrap()
  .pick({ kiloBench: true })
  .optional();

export const AUTO_DECIDER_MIN_COST_USD = 15;
export const AUTO_DECIDER_MAX_COST_USD = 25;

export type AutoRoutingDeciderCandidate = {
  id: string;
  avgAttemptCostUsd: number;
};

type Row = {
  openrouterId: string;
  isActive: boolean | null;
  benchmarks: unknown;
};

function isInAutoCostBand(avgAttemptCostUsd: number): boolean {
  const floored = Math.floor(avgAttemptCostUsd);
  return floored >= AUTO_DECIDER_MIN_COST_USD && floored <= AUTO_DECIDER_MAX_COST_USD;
}

export function summarizeAutoRoutingDeciderCandidates(
  rows: readonly Row[]
): AutoRoutingDeciderCandidate[] {
  const candidates: AutoRoutingDeciderCandidate[] = [];

  for (const row of rows) {
    if (!row.isActive || row.openrouterId.startsWith(CUSTOM_LLM_PREFIX)) continue;
    const result = TerminalBenchSchema.safeParse(row.benchmarks);
    if (!result.success) continue;
    const bench = result.data?.kiloBench?.evals['terminal-bench'];
    if (
      !bench ||
      (bench.nAttempts ?? 0) < 5 ||
      bench.avgAttemptCostUsd === null ||
      bench.avgAttemptCostUsd === undefined ||
      !isInAutoCostBand(bench.avgAttemptCostUsd)
    ) {
      continue;
    }
    candidates.push({ id: row.openrouterId, avgAttemptCostUsd: bench.avgAttemptCostUsd });
  }

  return candidates.sort((left, right) => {
    const costDelta = right.avgAttemptCostUsd - left.avgAttemptCostUsd;
    return costDelta === 0 ? left.id.localeCompare(right.id) : costDelta;
  });
}

export async function listAutoRoutingDeciderCandidates(): Promise<AutoRoutingDeciderCandidate[]> {
  const rows = await readDb
    .select({
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      benchmarks: modelStats.benchmarks,
    })
    .from(modelStats)
    .where(
      and(eq(modelStats.isActive, true), notLike(modelStats.openrouterId, `${CUSTOM_LLM_PREFIX}%`))
    );
  return summarizeAutoRoutingDeciderCandidates(rows);
}
