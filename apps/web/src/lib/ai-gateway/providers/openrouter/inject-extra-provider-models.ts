import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
  VercelInferenceProviderIdSchema,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { StoredModel } from '@kilocode/db/schema-types';

export function injectExtraProviderModels(
  vercelModels: Record<string, StoredModel>,
  providerModelData: Array<{ provider: OpenRouterProvider; models: OpenRouterModel[] }>
) {
  const openRouterModels = new Map<string, OpenRouterModel>();
  for (const { models } of providerModelData) {
    for (const model of models) {
      openRouterModels.set(model.slug, model);
    }
  }
  for (const model of openRouterModels.values()) {
    const vercelModel = vercelModels[mapModelIdToVercel(model.slug)];
    if (!vercelModel) continue;

    const vercelInferenceProviders = new Set(
      vercelModel.endpoints
        .map(
          endpoint =>
            VercelInferenceProviderIdSchema.safeParse(
              normalizeVercelInferenceProviderIdForRouting(endpoint.provider_name ?? endpoint.tag)
            ).data
        )
        .filter(p => p !== undefined)
    );

    for (const providerData of providerModelData) {
      const vercelProviderId = VercelInferenceProviderIdSchema.safeParse(
        openRouterToVercelInferenceProviderId(providerData.provider.slug)
      ).data;
      const endpoint = vercelModel.endpoints.find(
        endpoint =>
          normalizeVercelInferenceProviderIdForRouting(endpoint.provider_name ?? endpoint.tag) ===
          vercelProviderId
      );
      if (
        vercelProviderId &&
        endpoint &&
        vercelInferenceProviders.has(vercelProviderId) &&
        !providerData.models.some(m => m.slug === model.slug)
      ) {
        const freeSuffixIndex = model.name.indexOf(' (free)');
        const m = {
          ...model,
          name: freeSuffixIndex >= 0 ? model.name.substring(0, freeSuffixIndex) : model.name,
          context_length: endpoint.context_length ?? model.context_length,
          endpoint: {
            provider_display_name: providerData.provider.displayName,
            is_free: !endpoint.pricing?.prompt,
            pricing: endpoint.pricing ?? { prompt: '0', completion: '0' },
          },
        };
        console.warn(
          '[injectExtraProviderModels] Adding missing model to provider %s: %s',
          providerData.provider.name,
          m.name
        );
        providerData.models.push(m);
      }
    }
  }
}
