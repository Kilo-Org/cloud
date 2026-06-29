import { z } from 'zod';

import {
  createPublicSnowflakeReport,
  publicSnowflakeReportOptions,
} from '@/lib/public-snowflake-report';
import { LEADERBOARD_MODEL_USAGE_REDIS_KEY } from '@/lib/redis-keys';

const LEADERBOARD_MODEL_USAGE_QUERY = `
select
    to_char(mu.usage_date, 'YYYY-MM-DD') as usage_date
    , coalesce(mu.requested_model, mu.model) as "model"
    , case
        when mu.feature ilike '%claw%' then 'kiloclaw'
        when mu.mode ilike '%code%' then 'code'
        when mu.mode ilike '%review%' then 'review'
        when mu.mode ilike '%plan%' then 'plan'
        when mu.mode ilike '%ask%' then 'ask'
        when mu.mode ilike '%debug%' then 'debug'
        else null
      end as mode
    , sum(coalesce(mu.total_input_tokens, 0)) + sum(coalesce(mu.total_output_tokens, 0)) as "tokens"
from kilo_dw.dbt_prod.microdollar_usage_daily as mu
where
    mu.usage_date >= dateadd(week, -1, current_date())
    and mu.usage_date < current_date()
    and mu.total_input_tokens > 0
    and mu.provider != 'custom'
group by 1, 2, 3
order by 1 desc, 4 desc;
`;

const modelUsageSchema = z.array(
  z.object({
    usageDate: z.string(),
    model: z.string().min(1),
    mode: z.enum(['kiloclaw', 'code', 'review', 'plan', 'ask', 'debug']).nullable(),
    tokens: z.number(),
  })
);

type ModelUsage = z.infer<typeof modelUsageSchema>[number];

function parseModelUsage(rows: string[][]): ModelUsage[] {
  return rows.map(row => {
    const [usageDate, model, modeValue, tokenValue] = row;
    const tokens = Number(tokenValue);
    const mode = modeValue || null;

    if (!usageDate || !model || !Number.isFinite(tokens)) {
      throw new Error('Snowflake returned an invalid model usage row');
    }

    return modelUsageSchema.element.parse({
      usageDate,
      model,
      mode,
      tokens,
    });
  });
}

export const GET = createPublicSnowflakeReport({
  cacheKey: LEADERBOARD_MODEL_USAGE_REDIS_KEY,
  errorMessage: 'Failed to fetch leaderboard model usage',
  parseRows: parseModelUsage,
  query: LEADERBOARD_MODEL_USAGE_QUERY,
  schema: modelUsageSchema,
  source: 'public-leaderboard-model-usage-api',
});

export const OPTIONS = publicSnowflakeReportOptions;
