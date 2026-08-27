import 'server-only';

import {
  CUSTOM_LLM_PREFIX,
  KILO_AUTO_MODEL_PREFIX,
  KILOCLAW_KILO_PROVIDER_PREFIX,
  KILOCODE_KILO_PROVIDER_PREFIX,
} from '@/lib/ai-gateway/model-utils';
import { ENKRYPT_API_KEY } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { fetchWithBackoff } from '@/lib/fetchWithBackoff';
import { modelStats } from '@kilocode/db/schema';
import type { ModelStats } from '@kilocode/db/schema';
import { EnkryptScoreSchema } from '@kilocode/db/schema-types';
import type { EnkryptBenchmark, EnkryptScore } from '@kilocode/db/schema-types';
import { and, eq, notLike, sql } from 'drizzle-orm';
import * as z from 'zod';

const EnkryptResponseSchema = z.object({
  status: z.literal('success'),
  data: z.object({ scores: z.array(EnkryptScoreSchema) }),
});

const providerPrefixes = new Map([
  ['OpenAI', 'openai'],
  ['Anthropic', 'anthropic'],
  ['Google', 'google'],
  ['Meta', 'meta-llama'],
  ['Mistral AI', 'mistralai'],
  ['DeepSeek', 'deepseek'],
  ['xAI', 'x-ai'],
]);

const excludedPrefixes = [
  CUSTOM_LLM_PREFIX,
  KILO_AUTO_MODEL_PREFIX,
  KILOCLAW_KILO_PROVIDER_PREFIX,
  KILOCODE_KILO_PROVIDER_PREFIX,
  'internal/',
  'private/',
  'custom/',
  'openrouter/',
];

const publicModelConditions = and(
  eq(modelStats.isActive, true),
  eq(modelStats.isStealth, false),
  sql`${modelStats.openrouterId} ~ '^[^/[:space:]]+/[^/[:space:]]+$'`,
  ...excludedPrefixes.map(prefix => notLike(modelStats.openrouterId, `${prefix}%`))
);

type CatalogModel = Pick<ModelStats, 'id' | 'openrouterId' | 'isActive' | 'isStealth'>;

type SyncEnkryptResult = {
  fetchedCount: number;
  matchedCount: number;
  unmatchedCount: number;
  ambiguousCount: number;
  updatedCount: number;
  unmatchedModelNames: string[];
};

export function parseEnkryptScores(value: unknown): EnkryptScore[] {
  const result = EnkryptResponseSchema.safeParse(value);
  if (!result.success) {
    throw new Error('Invalid Enkrypt scores response');
  }
  return result.data.data.scores;
}

export function matchEnkryptScores(
  scores: readonly EnkryptScore[],
  models: readonly CatalogModel[]
) {
  const publicModels = models.filter(
    model =>
      model.isActive === true &&
      !model.isStealth &&
      /^[^/\s]+\/[^/\s]+$/.test(model.openrouterId) &&
      !excludedPrefixes.some(prefix => model.openrouterId.startsWith(prefix))
  );
  const modelsById = new Map(publicModels.map(model => [model.openrouterId, model]));
  const namespaces = new Set(publicModels.map(model => model.openrouterId.split('/')[0]));
  const candidates = new Map<string, { model: CatalogModel; scores: EnkryptScore[] }>();
  const unmatchedModelNames: string[] = [];

  for (const score of scores) {
    const prefix =
      providerPrefixes.get(score.provider) ??
      (namespaces.has(score.provider) ? score.provider : undefined);
    const modelId = score.model_name.includes('/')
      ? score.model_name
      : prefix
        ? `${prefix}/${score.model_name}`
        : undefined;
    const model = modelId ? modelsById.get(modelId) : undefined;

    if (!model) {
      unmatchedModelNames.push(score.model_name);
      continue;
    }

    const existing = candidates.get(model.id);
    if (existing) {
      existing.scores.push(score);
    } else {
      candidates.set(model.id, { model, scores: [score] });
    }
  }

  const matches: { model: CatalogModel; score: EnkryptScore }[] = [];
  let ambiguousCount = 0;
  for (const candidate of candidates.values()) {
    if (candidate.scores.length !== 1) {
      ambiguousCount += candidate.scores.length;
    } else {
      matches.push({ model: candidate.model, score: candidate.scores[0] });
    }
  }

  matches.sort((left, right) => left.model.id.localeCompare(right.model.id));
  return { matches, unmatchedModelNames, ambiguousCount };
}

export async function syncEnkryptBenchmarks() {
  if (!ENKRYPT_API_KEY?.trim()) {
    throw new Error('ENKRYPT_API_KEY is not configured');
  }

  const lastUpdated = new Date().toISOString();
  let response: Response;
  try {
    response = await fetchWithBackoff(
      'https://api.enkryptai.com/leaderboard/v2/scores',
      {
        method: 'GET',
        headers: { apikey: ENKRYPT_API_KEY },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
        cache: 'no-store',
      },
      {
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        retryResponse: result => result.status === 429 || result.status >= 500,
      }
    );
  } catch {
    throw new Error('Enkrypt scores request failed');
  }

  if (!response.ok) {
    throw new Error(`Enkrypt scores request failed (HTTP ${response.status})`);
  }

  let scores: EnkryptScore[];
  try {
    const value: unknown = await response.json();
    scores = parseEnkryptScores(value);
  } catch {
    throw new Error('Invalid Enkrypt scores response');
  }

  const result: SyncEnkryptResult = {
    fetchedCount: scores.length,
    matchedCount: 0,
    unmatchedCount: 0,
    ambiguousCount: 0,
    updatedCount: 0,
    unmatchedModelNames: [],
  };
  if (scores.length === 0) return result;

  const models = await db
    .select({
      id: modelStats.id,
      openrouterId: modelStats.openrouterId,
      isActive: modelStats.isActive,
      isStealth: modelStats.isStealth,
    })
    .from(modelStats)
    .where(publicModelConditions);
  const { matches, unmatchedModelNames, ambiguousCount } = matchEnkryptScores(scores, models);
  result.matchedCount = matches.length;
  result.unmatchedCount = unmatchedModelNames.length;
  result.ambiguousCount = ambiguousCount;
  result.unmatchedModelNames = unmatchedModelNames;
  if (matches.length === 0) return result;

  result.updatedCount = await db.transaction(async tx => {
    let updatedCount = 0;
    for (const { model, score } of matches) {
      const snapshot: EnkryptBenchmark = { ...score, lastUpdated };
      const updated = await tx
        .update(modelStats)
        .set({
          benchmarks: sql`
            COALESCE(${modelStats.benchmarks}, '{}'::jsonb) ||
            ${JSON.stringify({ enkrypt: snapshot })}::jsonb
          `,
        })
        .where(
          and(
            eq(modelStats.id, model.id),
            eq(modelStats.openrouterId, model.openrouterId),
            publicModelConditions,
            sql`(
              ${modelStats.benchmarks}->'enkrypt'->>'lastUpdated' IS NULL OR
              ${modelStats.benchmarks}->'enkrypt'->>'lastUpdated' < ${lastUpdated}
            )`
          )
        )
        .returning({ id: modelStats.id });
      updatedCount += updated.length;
    }
    return updatedCount;
  });

  return result;
}
