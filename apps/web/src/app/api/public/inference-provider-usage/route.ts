import { z } from 'zod';

import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';
import {
  getPublicSnowflakeReport,
  publicSnowflakeReportOptions,
} from '@/lib/public-snowflake-report';
import { INFERENCE_PROVIDER_USAGE_REDIS_KEY } from '@/lib/redis-keys';

const INFERENCE_PROVIDER_USAGE_QUERY = `
select
    to_char(mu.usage_date, 'YYYY-MM-DD') as usage_date
    , mu.inference_provider as provider
    , sum(coalesce(mu.total_input_tokens, 0) + coalesce(mu.total_output_tokens, 0)) as tokens
from kilo_dw.dbt_prod.microdollar_usage_daily as mu
where
    mu.usage_date >= dateadd(week, -1, current_date())
    and mu.usage_date < current_date()
group by
    mu.usage_date
    , mu.inference_provider;
`;

const inferenceProviderUsageSchema = z.array(
  z.object({
    usageDate: z.string(),
    provider: z.string().min(1),
    tokens: z.number(),
  })
);

type InferenceProviderUsage = z.infer<typeof inferenceProviderUsageSchema>[number];

function parseAndAggregateUsage(rows: string[][]): InferenceProviderUsage[] {
  const usageByDateAndProvider = new Map<string, InferenceProviderUsage>();

  for (const row of rows) {
    const [usageDate, rawProvider, tokenValue] = row;
    const tokens = Number(tokenValue);

    if (!usageDate || !Number.isFinite(tokens)) {
      throw new Error('Snowflake returned an invalid inference provider usage row');
    }

    const provider = normalizePublicInferenceProvider(rawProvider?.trim() || 'unknown');
    const aggregationKey = `${usageDate}\0${provider.key}`;
    const existing = usageByDateAndProvider.get(aggregationKey);

    if (existing) {
      existing.tokens += tokens;
    } else {
      usageByDateAndProvider.set(aggregationKey, {
        usageDate,
        provider: provider.name,
        tokens,
      });
    }
  }

  return [...usageByDateAndProvider.values()].sort(
    (left, right) =>
      right.usageDate.localeCompare(left.usageDate) ||
      right.tokens - left.tokens ||
      left.provider.localeCompare(right.provider)
  );
}

export async function GET() {
  return getPublicSnowflakeReport({
    cacheKey: INFERENCE_PROVIDER_USAGE_REDIS_KEY,
    errorMessage: 'Failed to fetch inference provider usage',
    parseRows: parseAndAggregateUsage,
    query: INFERENCE_PROVIDER_USAGE_QUERY,
    schema: inferenceProviderUsageSchema,
    source: 'public-inference-provider-usage-api',
  });
}

export const OPTIONS = publicSnowflakeReportOptions;
