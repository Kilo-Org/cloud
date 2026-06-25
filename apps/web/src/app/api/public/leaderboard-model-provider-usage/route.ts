import { z } from 'zod';

import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';
import {
  getPublicSnowflakeReport,
  publicSnowflakeReportOptions,
} from '@/lib/public-snowflake-report';
import { LEADERBOARD_MODEL_PROVIDER_USAGE_REDIS_KEY } from '@/lib/redis-keys';

const MINIMUM_TOKENS = 10_000_000;
const MAXIMUM_ERROR_RATE = 0.5;

const LEADERBOARD_MODEL_PROVIDER_USAGE_QUERY = `
select
     mu.requested_model as "model"
    , mu.inference_provider as "provider"
    , sum(mu.total_cost_microdollars) as "sum_cost"
    , sum(mu.total_input_tokens) + sum(mu.total_output_tokens) as "sum_tokens"
    , sum(mu.total_input_tokens) as "sum_input_tokens"
    , sum(mu.total_cache_hit_tokens) as "sum_cache_hit_tokens"
    , sum(mu.request_count) as "sum_request_count"
    , sum(mu.error_count) as "sum_error_count"
from kilo_dw.dbt_prod.microdollar_usage_daily as mu
where
    mu.usage_date >= dateadd(week, -1, current_date())
    and mu.usage_date < current_date()
    and mu.provider not in ('custom', 'direct-byok')
    and mu.total_output_tokens > 0
    and mu.is_user_byok = false
group by 1, 2
order by 4 desc;
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

function normalizeModel(model: string): string {
  const withoutTrailingSlashes = model.replace(/\/+$/, '');
  const slashIndex = withoutTrailingSlashes.lastIndexOf('/');
  const withoutProvider = withoutTrailingSlashes.startsWith('openrouter/')
    ? withoutTrailingSlashes
    : slashIndex >= 0
      ? withoutTrailingSlashes.slice(slashIndex + 1)
      : withoutTrailingSlashes;
  const colonIndex = withoutProvider.indexOf(':');

  if (colonIndex < 0 || withoutProvider.slice(colonIndex) === ':free') {
    return withoutProvider;
  }

  return withoutProvider.slice(0, colonIndex);
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function parseAndAggregateUsage(rows: string[][]): ModelProviderUsage[] {
  const usageByModelAndProvider = new Map<string, AggregatedUsage>();

  for (const row of rows) {
    const [rawModel, rawProvider, ...rawAggregates] = row;
    const [sumCost, sumTokens, sumInputTokens, sumCacheHitTokens, sumRequestCount, sumErrorCount] =
      rawAggregates.map(Number);
    const model = normalizeModel(rawModel?.trim() || '');
    const provider = normalizePublicInferenceProvider(rawProvider?.trim() || 'unknown');

    if (
      !model ||
      ![
        sumCost,
        sumTokens,
        sumInputTokens,
        sumCacheHitTokens,
        sumRequestCount,
        sumErrorCount,
      ].every(Number.isFinite)
    ) {
      throw new Error('Snowflake returned an invalid leaderboard model provider usage row');
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
      percentageOfModel:
        ratio(usage.sumTokens, totalTokensByModel.get(usage.model) ?? 0) * 100,
    })).filter(usage => usage.errorRate < MAXIMUM_ERROR_RATE);
}

export async function GET() {
  return getPublicSnowflakeReport({
    cacheKey: LEADERBOARD_MODEL_PROVIDER_USAGE_REDIS_KEY,
    errorMessage: 'Failed to fetch leaderboard model provider usage',
    parseRows: parseAndAggregateUsage,
    query: LEADERBOARD_MODEL_PROVIDER_USAGE_QUERY,
    schema: modelProviderUsageSchema,
    source: 'public-leaderboard-model-provider-usage-api',
  });
}

export const OPTIONS = publicSnowflakeReportOptions;
