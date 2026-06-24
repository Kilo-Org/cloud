import { z } from 'zod';

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

const PROVIDER_ALIASES: Record<string, string> = {
  amazonbedrock: 'bedrock',
  custom: 'other',
  directbyok: 'other',
  googleaistudio: 'google',
  inceptron: 'inception',
  martian: 'stealth',
  seed: 'bytedance',
  togetherai: 'together',
  unknown: 'other',
  vertex: 'google',
  vertexanthropic: 'google',
};

const PROVIDER_NAMES: Record<string, string> = {
  ai21: 'AI21',
  aionlabs: 'Aion Labs',
  akashml: 'Akash ML',
  arceeai: 'Arcee AI',
  atlascloud: 'Atlas Cloud',
  bedrock: 'Amazon Bedrock',
  bytedance: 'ByteDance',
  dekallm: 'DekaLLM',
  deepinfra: 'DeepInfra',
  deepseek: 'DeepSeek',
  digitalocean: 'DigitalOcean',
  fireworks: 'Fireworks AI',
  friendli: 'Friendli AI',
  gmicloud: 'GMI Cloud',
  google: 'Google',
  inception: 'Inception',
  ionet: 'IO.net',
  minimax: 'MiniMax',
  modelrun: 'ModelRun',
  moonshotai: 'Moonshot AI',
  nexagi: 'Nex AGI',
  nextbit: 'NextBit',
  novita: 'Novita AI',
  nvidia: 'NVIDIA',
  openai: 'OpenAI',
  openinference: 'OpenInference',
  other: 'Other',
  sambanova: 'SambaNova',
  siliconflow: 'SiliconFlow',
  stealth: 'Stealth',
  stepfun: 'StepFun',
  streamlake: 'StreamLake',
  together: 'Together AI',
  unknown: 'Unknown',
  wandb: 'Weights & Biases',
  xai: 'xAI',
  zai: 'Z.ai',
};

function normalizeProvider(provider: string): { key: string; name: string } {
  const normalizedKey = provider.toLowerCase().replace(/[^a-z0-9]/g, '');
  const key = PROVIDER_ALIASES[normalizedKey] ?? normalizedKey;
  const fallbackName = provider
    .trim()
    .toLowerCase()
    .replace(/(^|[\s_-])\w/g, character => character.toUpperCase());

  return { key, name: PROVIDER_NAMES[key] ?? fallbackName };
}

function parseAndAggregateUsage(rows: string[][]): InferenceProviderUsage[] {
  const usageByDateAndProvider = new Map<string, InferenceProviderUsage>();

  for (const row of rows) {
    const [usageDate, rawProvider, tokenValue] = row;
    const tokens = Number(tokenValue);

    if (!usageDate || !Number.isFinite(tokens)) {
      throw new Error('Snowflake returned an invalid inference provider usage row');
    }

    const provider = normalizeProvider(rawProvider?.trim() || 'unknown');
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
