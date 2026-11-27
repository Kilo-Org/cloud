import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  LEADERBOARD_MODEL_SQL,
  LEADERBOARD_SERVED_MODEL_SQL,
  resolveLeaderboardModel,
} from '@/lib/leaderboard-model';
import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';
import { createPublicReport, publicReportOptions } from '@/lib/public-report';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

const MINIMUM_TOKENS = 10_000_000;
const MAXIMUM_ERROR_RATE = 0.5;

type ModelProviderUsageRow = {
  model: string | null;
  provider: string | null;
  sum_cost: number;
  sum_tokens: number;
  sum_input_tokens: number;
  sum_cache_hit_tokens: number;
  sum_request_count: number;
  sum_error_count: number;
  served_model: string | null;
};

const LEADERBOARD_MODEL_PROVIDER_USAGE_QUERY = sql`
select
     ${sql.raw(LEADERBOARD_MODEL_SQL)} as "model"
    , mu.inference_provider as "provider"
    , sum(mu.cost_microdollars)::float8 as "sum_cost"
    , (sum(mu.input_tokens) + sum(mu.output_tokens))::float8 as "sum_tokens"
    , sum(mu.input_tokens)::float8 as "sum_input_tokens"
    , sum(mu.cache_hit_tokens)::float8 as "sum_cache_hit_tokens"
    , sum(mu.request_count)::float8 as "sum_request_count"
    , sum(mu.error_count)::float8 as "sum_error_count"
    , ${sql.raw(LEADERBOARD_SERVED_MODEL_SQL)} as "served_model"
from leaderboard_usage_daily as mu
where
    mu.usage_date >= (now() at time zone 'UTC')::date - 7
    and mu.usage_date < (now() at time zone 'UTC')::date
    and (
        mu.provider != 'custom'
        or mu.requested_model = 'reflection/beam-free'
        or mu.requested_model = 'stealth/glyph-cluster'
    )
    and mu.output_tokens > 0
    and mu.is_user_byok = false
    and mu.requested_model not ilike '%mercury-edit%'
group by 1, 2, 9
`;

const modelProviderUsageSchema = z.array(
  z.object({
    model: z.string().min(1),
    provider: z.string().min(1),
    sumTokens: z.number(),
    costPerRequest: z.number(),
    costPerMillionTokens: z.number(),
    cacheRatio: z.number(),
    errorRate: z.number(),
    percentageOfModel: z.number(),
  })
);

type ModelProviderUsage = z.infer<typeof modelProviderUsageSchema>[number];

type AggregatedUsage = {
  model: string;
  provider: string;
  sumCost: number;
  sumTokens: number;
  sumInputTokens: number;
  sumCacheHitTokens: number;
  sumRequestCount: number;
  sumErrorCount: number;
};

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

async function aggregateUsage(rows: ModelProviderUsageRow[]): Promise<ModelProviderUsage[]> {
  const usageByModelAndProvider = new Map<string, AggregatedUsage>();

  for (const row of rows) {
    const {
      sum_cost: sumCost,
      sum_tokens: sumTokens,
      sum_input_tokens: sumInputTokens,
      sum_cache_hit_tokens: sumCacheHitTokens,
      sum_request_count: sumRequestCount,
      sum_error_count: sumErrorCount,
    } = row;
    const model = await resolveLeaderboardModel(row.model ?? '', row.served_model ?? undefined);
    const provider = normalizePublicInferenceProvider(row.provider?.trim() || 'unknown');

    if (!model) {
      throw new Error('Leaderboard model provider usage row has no model');
    }

    if (provider.key === 'other') {
      continue;
    }

    const aggregationKey = `${model}\0${provider.key}`;
    const existing = usageByModelAndProvider.get(aggregationKey);

    if (existing) {
      existing.sumCost += sumCost;
      existing.sumTokens += sumTokens;
      existing.sumInputTokens += sumInputTokens;
      existing.sumCacheHitTokens += sumCacheHitTokens;
      existing.sumRequestCount += sumRequestCount;
      existing.sumErrorCount += sumErrorCount;
    } else {
      usageByModelAndProvider.set(aggregationKey, {
        model,
        provider: provider.name,
        sumCost,
        sumTokens,
        sumInputTokens,
        sumCacheHitTokens,
        sumRequestCount,
        sumErrorCount,
      });
    }
  }

  const aggregatedUsage = [...usageByModelAndProvider.values()];
  const totalTokensByModel = new Map<string, number>();

  for (const usage of aggregatedUsage) {
    totalTokensByModel.set(
      usage.model,
      (totalTokensByModel.get(usage.model) ?? 0) + usage.sumTokens
    );
  }

  return aggregatedUsage
    .filter(usage => usage.sumTokens >= MINIMUM_TOKENS)
    .sort(
      (left, right) =>
        right.sumTokens - left.sumTokens ||
        left.model.localeCompare(right.model) ||
        left.provider.localeCompare(right.provider)
    )
    .map(usage => ({
      model: usage.model,
      provider: usage.provider,
      sumTokens: usage.sumTokens,
      costPerRequest: ratio(usage.sumCost, usage.sumRequestCount - usage.sumErrorCount) / 1e6,
      costPerMillionTokens: ratio(usage.sumCost, usage.sumTokens),
      cacheRatio: ratio(usage.sumCacheHitTokens, usage.sumInputTokens),
      errorRate: ratio(usage.sumErrorCount, usage.sumRequestCount),
      percentageOfModel: ratio(usage.sumTokens, totalTokensByModel.get(usage.model) ?? 0) * 100,
    }))
    .filter(usage => usage.errorRate < MAXIMUM_ERROR_RATE);
}

export const GET = createPublicReport({
  errorMessage: 'Failed to fetch leaderboard model provider usage',
  load: async () => {
    const { rows } = await readDb.execute<ModelProviderUsageRow>(
      LEADERBOARD_MODEL_PROVIDER_USAGE_QUERY
    );
    // An empty window means the rollup has not been built yet; failing keeps
    // the last good report in the in-process cache instead of caching nothing.
    if (rows.length === 0) {
      throw new Error('leaderboard_usage_daily has no rows for the leaderboard window');
    }
    return await aggregateUsage(rows);
  },
  schema: modelProviderUsageSchema,
  source: 'public-leaderboard-model-provider-usage-api',
});

export const OPTIONS = publicReportOptions;
