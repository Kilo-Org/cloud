import type {
  NormalizedOpenRouterResponse,
  NormalizedProvider,
  OpenRouterModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import {
  getDirectByokProviderListings,
  listDirectByokCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';

/**
 * The direct BYOK providers with their own listing, as provider policy screen entries with the
 * catalog models their keys serve in catalog mode, so provider allow-lists can name them. Other
 * direct BYOK providers appear under their general provider list counterpart. The snapshot itself
 * stays without these entries because Kilo's own routes use it, and these providers only serve an
 * organization's own keys. A listing without catalog models has nothing to restrict, so the
 * screens leave it out like any provider without models.
 */
export async function getDirectByokPolicyProviders(
  snapshot: NormalizedOpenRouterResponse
): Promise<NormalizedProvider[]> {
  const snapshotProviderSlugs = new Set(snapshot.providers.map(provider => provider.slug));
  const snapshotModels = new Map<string, OpenRouterModel>();
  for (const provider of snapshot.providers) {
    for (const model of provider.models) {
      if (!snapshotModels.has(model.slug)) snapshotModels.set(model.slug, model);
    }
  }

  const providers: NormalizedProvider[] = [];
  for (const listing of getDirectByokProviderListings()) {
    if (snapshotProviderSlugs.has(listing.slug)) continue;
    const models: OpenRouterModel[] = [];
    for (const { catalogModelId } of await listDirectByokCatalogModels(listing.slug)) {
      const model = snapshotModels.get(catalogModelId);
      if (!model) continue;
      models.push({
        ...model,
        // The organization pays the provider directly, so Kilo bills nothing for these requests.
        endpoint: {
          provider_display_name: listing.displayName,
          variant: null,
          is_free: false,
          pricing: { prompt: '0', completion: '0' },
          data_policy: null,
        },
      });
    }
    providers.push({ ...listing, models });
  }
  return providers;
}

/** The snapshot with `getDirectByokPolicyProviders` appended, for the provider policy screens. */
export async function withDirectByokPolicyProviders(
  snapshot: NormalizedOpenRouterResponse
): Promise<NormalizedOpenRouterResponse> {
  const providers = [...snapshot.providers, ...(await getDirectByokPolicyProviders(snapshot))];
  return { ...snapshot, providers, total_providers: providers.length };
}
