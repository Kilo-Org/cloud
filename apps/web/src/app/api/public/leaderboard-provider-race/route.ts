import { z } from 'zod';

import {
  createPublicSnowflakeReport,
  publicSnowflakeReportOptions,
} from '@/lib/public-snowflake-report';
import { LEADERBOARD_PROVIDER_RACE_REDIS_KEY } from '@/lib/redis-keys';

// Weekly token volume per model lab, from a fixed start date through the most
// recent complete week. Grouped at week x model_provider_company x
// is_open_weights so a single payload drives both the per-lab "race" view and
// an open-weight vs proprietary toggle. model_provider_company and
// is_open_weights are maintained in the dbt model_dim seed (kilocode-dbt), so
// the lab mapping lives in one place rather than being re-derived here.
// The partial current week is excluded so every returned week is complete.
const LEADERBOARD_PROVIDER_RACE_QUERY = `
select
    to_char(date_trunc('week', ud.usage_date), 'YYYY-MM-DD') as week_start
    , ud.model_provider_company as provider
    , ud.is_open_weights
    , sum(ud.total_tokens) as tokens
from kilo_dw.dbt_prod.usage_daily as ud
where
    ud.usage_date >= '2025-07-01'
    and date_trunc('week', ud.usage_date) < date_trunc('week', current_date())
    and ud.total_tokens > 0
group by 1, 2, 3
order by 1, 4 desc;
`;

const providerRaceSchema = z.array(
  z.object({
    weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    provider: z.string().min(1),
    isOpenWeights: z.boolean(),
    tokens: z.number(),
  })
);

type ProviderRace = z.infer<typeof providerRaceSchema>;

function parseProviderRace(rows: string[][]): ProviderRace {
  return rows.map(row => {
    const [weekStart, provider, rawOpenWeights, rawTokens] = row;
    const tokens = Number(rawTokens);

    if (!weekStart || !provider || !Number.isFinite(tokens)) {
      throw new Error('Snowflake returned an invalid provider race row');
    }

    return providerRaceSchema.element.parse({
      weekStart,
      provider,
      isOpenWeights: rawOpenWeights === 'true' || rawOpenWeights === true,
      tokens,
    });
  });
}

export const GET = createPublicSnowflakeReport({
  cacheKey: LEADERBOARD_PROVIDER_RACE_REDIS_KEY,
  errorMessage: 'Failed to fetch leaderboard provider race',
  parseRows: parseProviderRace,
  query: LEADERBOARD_PROVIDER_RACE_QUERY,
  schema: providerRaceSchema,
  source: 'public-leaderboard-provider-race-api',
});

export const OPTIONS = publicSnowflakeReportOptions;
