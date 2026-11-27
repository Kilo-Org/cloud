import { sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  LEADERBOARD_MODEL_SQL,
  LEADERBOARD_SERVED_MODEL_SQL,
  resolveLeaderboardModel,
} from '@/lib/leaderboard-model';
import { createPublicReport, publicReportOptions } from '@/lib/public-report';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { LEADERBOARD_MODEL_USAGE_REDIS_KEY } from '@kilocode/web-shared/lib/redis-keys';

type ModelUsageRow = {
  usage_date: string;
  model: string | null;
  mode: string | null;
  tokens: number;
  served_model: string | null;
};

const LEADERBOARD_MODEL_USAGE_QUERY = sql`
select
    to_char(mu.usage_date, 'YYYY-MM-DD') as usage_date
    , ${sql.raw(LEADERBOARD_MODEL_SQL)} as "model"
    , case
        when mu.mode ilike '%code%' then 'code'
        when mu.mode ilike '%review%' then 'review'
        when mu.mode ilike '%plan%' then 'plan'
        when mu.mode ilike '%ask%' then 'ask'
        when mu.mode ilike '%debug%' then 'debug'
        else null
      end as mode
    , (sum(mu.input_tokens) + sum(mu.output_tokens))::float8 as "tokens"
    , ${sql.raw(LEADERBOARD_SERVED_MODEL_SQL)} as "served_model"
from leaderboard_usage_daily as mu
where
    mu.usage_date >= (now() at time zone 'UTC')::date - 7
    and mu.usage_date < (now() at time zone 'UTC')::date
    and mu.input_tokens > 0
    and (
        mu.provider != 'custom'
        or coalesce(mu.requested_model, mu.model) = 'reflection/beam-free'
        or coalesce(mu.requested_model, mu.model) = 'stealth/glyph-cluster'
    )
group by 1, 2, 3, 5
`;

const modelUsageSchema = z.array(
  z.object({
    usageDate: z.string(),
    model: z.string().min(1),
    mode: z.enum(['code', 'review', 'plan', 'ask', 'debug']).nullable(),
    tokens: z.number(),
  })
);

type ModelUsage = z.infer<typeof modelUsageSchema>[number];

async function aggregateModelUsage(rows: ModelUsageRow[]): Promise<ModelUsage[]> {
  const usageByKey = new Map<string, ModelUsage>();

  for (const row of rows) {
    const model = await resolveLeaderboardModel(row.model ?? '', row.served_model ?? undefined);
    const { usage_date: usageDate, mode, tokens } = row;

    if (!model) {
      throw new Error('Leaderboard model usage row has no model');
    }

    const key = `${usageDate}\0${model}\0${mode ?? ''}`;
    const existing = usageByKey.get(key);

    if (existing) {
      existing.tokens += tokens;
    } else {
      usageByKey.set(key, modelUsageSchema.element.parse({ usageDate, model, mode, tokens }));
    }
  }

  return [...usageByKey.values()].sort(
    (left, right) =>
      right.usageDate.localeCompare(left.usageDate) ||
      right.tokens - left.tokens ||
      left.model.localeCompare(right.model) ||
      (left.mode ?? '').localeCompare(right.mode ?? '')
  );
}

export const GET = createPublicReport({
  cacheKey: LEADERBOARD_MODEL_USAGE_REDIS_KEY,
  errorMessage: 'Failed to fetch leaderboard model usage',
  load: async () => {
    const { rows } = await readDb.execute<ModelUsageRow>(LEADERBOARD_MODEL_USAGE_QUERY);
    // An empty window means the rollup has not been built yet; failing keeps
    // the last good report in the in-process cache instead of caching nothing.
    if (rows.length === 0) {
      throw new Error('leaderboard_usage_daily has no rows for the leaderboard window');
    }
    return await aggregateModelUsage(rows);
  },
  schema: modelUsageSchema,
  source: 'public-leaderboard-model-usage-api',
});

export const OPTIONS = publicReportOptions;
