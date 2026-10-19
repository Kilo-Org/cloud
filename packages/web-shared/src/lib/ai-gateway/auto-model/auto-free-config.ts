import { readDb } from '@kilocode/web-shared/lib/drizzle';
import {
  createAiGatewayConfigSelector,
  readAiGatewayConfigSnapshot,
} from '@kilocode/web-shared/lib/ai-gateway/ai-gateway-config-snapshot';
import { isKiloAutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import type { AutoFreeModel } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getAiSdkProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { AutoFreeConfigSchema, type AutoFreeConfig } from '@kilocode/db/schema-types';

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

function parseConfiguredAutoFreeModels(autoFree: unknown): ReadonlyArray<AutoFreeModel> | null {
  if (!autoFree) return null;

  const parsed = AutoFreeConfigSchema.safeParse(autoFree);
  if (!parsed.success) {
    console.warn('[auto-free] ignoring invalid auto-free configuration', parsed.error.message);
    return null;
  }
  return parsed.data.models;
}

/** Returns the configured auto-free models, or null when none are stored or the stored value is invalid. */
export async function readConfiguredAutoFreeModels(): Promise<ReadonlyArray<AutoFreeModel> | null> {
  const snapshot = await readAiGatewayConfigSnapshot(readDb);
  return parseConfiguredAutoFreeModels(snapshot?.auto_free);
}

export const getConfiguredAutoFreeModels = createAiGatewayConfigSelector(
  snapshot => parseConfiguredAutoFreeModels(snapshot.auto_free),
  null
);
