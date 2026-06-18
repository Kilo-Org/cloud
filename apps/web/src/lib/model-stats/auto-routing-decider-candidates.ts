import { CUSTOM_LLM_PREFIX } from '@/lib/ai-gateway/model-utils';
import { readDb } from '@/lib/drizzle';
import {
  AUTO_DECIDER_DEFAULT_MAX_COST_USD,
  AUTO_DECIDER_DEFAULT_MIN_COST_USD,
} from '@kilocode/auto-routing-contracts';
import { ModelStatsBenchmarksSchema, modelStats } from '@kilocode/db/schema';
import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';
import { and, eq, notLike } from 'drizzle-orm';

const TerminalBenchSchema = ModelStatsBenchmarksSchema.unwrap()
  .pick({ kiloBench: true })
  .optional();

export const AUTO_DECIDER_MIN_COST_USD = AUTO_DECIDER_DEFAULT_MIN_COST_USD;
export const AUTO_DECIDER_MAX_COST_USD = AUTO_DECIDER_DEFAULT_MAX_COST_USD;

export type AutoRoutingDeciderCandidate = {
  id: string;
  avgAttemptCostUsd: number;
};

export type AutoRoutingDeciderCandidateOptions = {
  minCostUsd?: number;
  maxCostUsd?: number;
};

type Row = {
  openrouterId: string;
  isActive: boolean | null;
  benchmarks: unknown;
};

function isInAutoCostBand(
  avgAttemptCostUsd: number,
  { minCostUsd, maxCostUsd }: Required<AutoRoutingDeciderCandidateOptions>
): boolean {
  const floored = Math.floor(avgAttemptCostUsd);
  return floored >= minCostUsd && floored <= maxCostUsd;
}

export function summarizeAutoRoutingDeciderCandidates(
  rows: readonly Row[],
  options: AutoRoutingDeciderCandidateOptions = {}
): AutoRoutingDeciderCandidate[] {
  const candidates: AutoRoutingDeciderCandidate[] = [];
  const costBounds = {
    minCostUsd: options.minCostUsd ?? AUTO_DECIDER_MIN_COST_USD,
    maxCostUsd: options.maxCostUsd ?? AUTO_DECIDER_MAX_COST_USD,
  };

  for (const row of rows) {
    if (!row.isActive || row.openrouterId.startsWith(CUSTOM_LLM_PREFIX)) continue;
    const result = TerminalBenchSchema.safeParse(row.benchmarks);
    if (!result.success) continue;
    const bench = result.data?.kiloBench?.evals['terminal-bench'];
    if (
      !bench ||
      bench.avgAttemptCostUsd === null ||
      bench.avgAttemptCostUsd === undefined ||
      !isInAutoCostBand(bench.avgAttemptCostUsd, costBounds)
    ) {
      continue;
    }
    candidates.push({
      id: unprefixKiloGatewayModelId(row.openrouterId) ?? row.openrouterId,
      avgAttemptCostUsd: bench.avgAttemptCostUsd,
    });
  }

  return candidates.sort((left, right) => {
    const costDelta = right.avgAttemptCostUsd - left.avgAttemptCostUsd;
    return costDelta === 0 ? left.id.localeCompare(right.id) : costDelta;
  });
}

export async function listAutoRoutingDeciderCandidates(
  options: AutoRoutingDeciderCandidateOptions = {}
): Promise<AutoRoutingDeciderCandidate[]> {
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
  return summarizeAutoRoutingDeciderCandidates(rows, options);
}
