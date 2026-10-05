import { createCachedFetch } from '@/lib/cached-fetch';
import { db } from '@/lib/drizzle';
import { isKiloAutoModel } from '@/lib/ai-gateway/auto-model';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import type { AutoFreeModel } from '@/lib/ai-gateway/models';
import { getAiSdkProvider } from '@/lib/ai-gateway/providers/model-settings';
import { ai_gateway_config } from '@kilocode/db/schema';
import { AutoFreeConfigSchema, type AutoFreeConfig } from '@kilocode/db/schema-types';
import { eq } from 'drizzle-orm';

export const AUTO_FREE_FALLBACK_MODEL: AutoFreeModel = {
  model: 'openrouter/free',
  weight: 1,
  reasoning: { enabled: true },
};

export const AUTO_FREE_FALLBACK_CONFIG: AutoFreeConfig = { models: [AUTO_FREE_FALLBACK_MODEL] };

/**
 * `kilo-auto/free` has no OpenCode settings, so clients talk to it with the
 * default AI SDK provider. Candidates must be free, concrete models that use
 * that same provider.
 */
export function isAutoFreeEligibleModelId(model: string): boolean {
  return (
    isFreeModel(model) && !isKiloAutoModel(model) && getAiSdkProvider(model, null) === undefined
  );
}

export function getIneligibleAutoFreeModelIds(config: AutoFreeConfig): string[] {
  return config.models.map(({ model }) => model).filter(model => !isAutoFreeEligibleModelId(model));
}

/** Returns the configured auto-free models, or null when none are stored or the stored value is invalid. */
export async function readConfiguredAutoFreeModels(): Promise<ReadonlyArray<AutoFreeModel> | null> {
  const [row] = await db
    .select({ auto_free: ai_gateway_config.auto_free })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1))
    .limit(1);
  if (!row?.auto_free) return null;

  const parsed = AutoFreeConfigSchema.safeParse(row.auto_free);
  if (!parsed.success) {
    console.warn('[auto-free] ignoring invalid auto-free configuration', parsed.error.message);
    return null;
  }
  return parsed.data.models;
}

export const getConfiguredAutoFreeModels = createCachedFetch(
  readConfiguredAutoFreeModels,
  60_000,
  null
);
