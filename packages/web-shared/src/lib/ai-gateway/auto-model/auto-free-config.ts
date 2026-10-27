import { createCachedFetch } from '@kilocode/web-shared/lib/cached-fetch';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { isKiloAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isFreeModelExcludingCustomLlms } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  isPublicCustomLlm,
  requireCustomLlmsById,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { getCustomLlmApiKinds } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/api-kinds';
import type { AutoFreeModel } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getAiSdkProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
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
 * that same provider. It serves anonymous callers, so a custom LLM is a
 * candidate only when it is public, and it must serve Chat Completions.
 */
export function isAutoFreeEligibleModelId(
  model: string,
  customLlm: CustomLlm | undefined
): boolean {
  if (isKiloAutoModel(model)) {
    return false;
  }
  if (customLlm) {
    return (
      isPublicCustomLlm(customLlm.definition) &&
      getCustomLlmApiKinds(customLlm.definition).includes('chat_completions')
    );
  }
  return isFreeModelExcludingCustomLlms(model) && getAiSdkProvider(model, null) === undefined;
}

export async function getIneligibleAutoFreeModelIds(config: AutoFreeConfig): Promise<string[]> {
  const customLlmsById = await requireCustomLlmsById();
  return config.models
    .map(({ model }) => model)
    .filter(model => !isAutoFreeEligibleModelId(model, customLlmsById.get(model.toLowerCase())));
}

/** Returns the configured auto-free models, or null when none are stored or the stored value is invalid. */
export async function readConfiguredAutoFreeModels(): Promise<ReadonlyArray<AutoFreeModel> | null> {
  const [row] = await readDb
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
