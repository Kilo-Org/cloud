import { getSnapshotModelVariantId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

type ProviderModels = Array<{
  provider: { slug: string };
  models: OpenRouterModel[];
}>;

/**
 * Removes the models the gateway does not serve from every provider, in place. A snapshot entry is
 * judged by the exact gateway id it is served as (`<slug>:<variant>` for a non-standard variant),
 * the same exact match `/api/v1/models` and request routing use, so an unavailable `x/y:free` hides
 * only the free variant and an unavailable `x/y` hides only the standard one.
 *
 * Providers left without models stay in the list; the caller drops them.
 */
export function omitUnavailableModels(
  providerModelData: ProviderModels,
  unavailableModelIds: ReadonlySet<string>
): void {
  if (unavailableModelIds.size === 0) return;
  for (const data of providerModelData) {
    data.models = data.models.filter(
      model => !unavailableModelIds.has(getSnapshotModelVariantId(model))
    );
  }
}
