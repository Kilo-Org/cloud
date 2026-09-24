import { createHash } from 'node:crypto';
import { ai_gateway_external_models_cache } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { db, readDb } from '@/lib/drizzle';
import { createCachedFetch } from '@/lib/cached-fetch';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { OPENAI_CHATGPT_API_URL } from '@/lib/ai-gateway/openai-chatgpt/upstream';
import {
  ServedModelsSchema,
  removeUpstreamEnkrypt,
} from '@/lib/ai-gateway/providers/external-model-validation';

const OPENROUTER_SOURCE = `openrouter:${OPENROUTER.apiUrl}`;
const OPENROUTER_MAX_AGE_MS = 15 * 60_000;
const OPENROUTER_READ_TTL_MS = 60_000;
const OPENAI_MAX_AGE_MS = 60 * 60_000;
const CachedOpenRouterResponseSchema = z.preprocess(
  removeUpstreamEnkrypt,
  OpenRouterModelsResponseSchema
);

function openAiSource(apiKey: string): string {
  const identity = createHash('sha256')
    .update(JSON.stringify([OPENAI_CHATGPT_API_URL, apiKey]))
    .digest('hex');
  return `openai-chatgpt:${identity}`;
}

async function readCachedModels<T>(
  source: string,
  schema: z.ZodType<T>,
  maxAgeMs: number
): Promise<T | null> {
  try {
    const [row] = await readDb
      .select({
        data: ai_gateway_external_models_cache.data,
        synced_at: ai_gateway_external_models_cache.synced_at,
      })
      .from(ai_gateway_external_models_cache)
      .where(eq(ai_gateway_external_models_cache.source, source))
      .limit(1);
    if (!row) return null;
    const ageMs = Date.now() - new Date(row.synced_at).getTime();
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= maxAgeMs) return null;
    const parsed = schema.safeParse(row.data);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function saveCachedModels(source: string, data: unknown): Promise<void> {
  const synced_at = new Date().toISOString();
  await db
    .insert(ai_gateway_external_models_cache)
    .values({ source, data, synced_at })
    .onConflictDoUpdate({
      target: ai_gateway_external_models_cache.source,
      set: { data, synced_at },
    });
}

export const getCachedOpenRouterModels = createCachedFetch<OpenRouterModelsResponse | null>(
  async () => {
    const cached = await readCachedModels(
      OPENROUTER_SOURCE,
      CachedOpenRouterResponseSchema,
      OPENROUTER_MAX_AGE_MS
    );
    return cached && cached.data.length >= 100 ? cached : null;
  },
  OPENROUTER_READ_TTL_MS,
  null
);

export async function saveOpenRouterModels(response: unknown): Promise<boolean> {
  const parsed = CachedOpenRouterResponseSchema.safeParse(response);
  if (!parsed.success || parsed.data.data.length < 100) return false;
  await saveCachedModels(OPENROUTER_SOURCE, response);
  return true;
}

export async function getCachedOpenAiServedModels(apiKey: string): Promise<Set<string> | null> {
  const cached = await readCachedModels(
    openAiSource(apiKey),
    ServedModelsSchema,
    OPENAI_MAX_AGE_MS
  );
  return cached ? new Set(cached.data.map(model => model.id)) : null;
}

export async function saveOpenAiServedModels(apiKey: string, response: unknown): Promise<boolean> {
  const parsed = ServedModelsSchema.safeParse(response);
  if (!parsed.success) return false;
  await saveCachedModels(openAiSource(apiKey), response);
  return true;
}
