import { createHash } from 'node:crypto';
import { ai_gateway_external_model_cache } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import * as z from 'zod';
import { db, readDb } from '@/lib/drizzle';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { OPENAI_CHATGPT_API_URL } from '@/lib/ai-gateway/openai-chatgpt/upstream';

const OPENROUTER_SOURCE = `openrouter:${OPENROUTER.apiUrl}`;
const OPENROUTER_MAX_AGE_MS = 15 * 60_000;
const OPENAI_MAX_AGE_MS = 60 * 60_000;

const ServedModelsSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1) })).min(1),
});

export function sanitizeOpenRouterModels(response: unknown): unknown {
  if (
    !response ||
    typeof response !== 'object' ||
    !('data' in response) ||
    !Array.isArray(response.data)
  ) {
    return response;
  }
  return {
    ...response,
    data: response.data.map((model: unknown) => {
      if (!model || typeof model !== 'object' || !('enkrypt' in model)) return model;
      const sanitized: Record<string, unknown> = { ...model };
      delete sanitized.enkrypt;
      return sanitized;
    }),
  };
}

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
        data: ai_gateway_external_model_cache.data,
        synced_at: ai_gateway_external_model_cache.synced_at,
      })
      .from(ai_gateway_external_model_cache)
      .where(eq(ai_gateway_external_model_cache.source, source))
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
    .insert(ai_gateway_external_model_cache)
    .values({ source, data, synced_at })
    .onConflictDoUpdate({
      target: ai_gateway_external_model_cache.source,
      set: { data, synced_at },
    });
}

export async function getCachedOpenRouterModels(): Promise<OpenRouterModelsResponse | null> {
  const cached = await readCachedModels(
    OPENROUTER_SOURCE,
    OpenRouterModelsResponseSchema,
    OPENROUTER_MAX_AGE_MS
  );
  return cached && cached.data.length >= 100 ? cached : null;
}

export async function saveOpenRouterModels(response: unknown): Promise<boolean> {
  const parsed = OpenRouterModelsResponseSchema.safeParse(sanitizeOpenRouterModels(response));
  if (!parsed.success || parsed.data.data.length < 100) return false;
  await saveCachedModels(OPENROUTER_SOURCE, parsed.data);
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
  await saveCachedModels(openAiSource(apiKey), parsed.data);
  return true;
}
