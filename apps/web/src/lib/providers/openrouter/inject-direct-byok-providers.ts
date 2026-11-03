import { captureException } from '@sentry/nextjs';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  getDirectByokProviderListings,
  listDirectByokCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type {
  NormalizedProvider,
  OpenRouterModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

function findSnapshotModel(
  providers: readonly NormalizedProvider[],
  catalogModelId: string
): OpenRouterModel | undefined {
  let normalizedMatch: OpenRouterModel | undefined;
  const normalizedId = normalizeModelId(catalogModelId);
  for (const provider of providers) {
    for (const model of provider.models) {
      if (model.slug === catalogModelId) return model;
      normalizedMatch ??= normalizeModelId(model.slug) === normalizedId ? model : undefined;
    }
  }
  return normalizedMatch;
}

/**
 * Appends the direct BYOK providers with their own listing as BYOK-only providers, with the catalog
 * models their keys serve in catalog mode, so provider allow-lists can name them. Other direct BYOK
 * providers serve under a provider the snapshot already lists. A listing whose slug the snapshot
 * already has, or that serves no snapshot model, is left out.
 */
export async function injectDirectByokProviders(
  providers: readonly NormalizedProvider[]
): Promise<NormalizedProvider[]> {
  const snapshotSlugs = new Set(providers.map(provider => provider.slug));
  const injected: NormalizedProvider[] = [];
  for (const listing of getDirectByokProviderListings()) {
    if (snapshotSlugs.has(listing.slug)) continue;
    let catalogModels;
    try {
      catalogModels = await listDirectByokCatalogModels(listing.slug);
    } catch (error) {
      // One provider's model list must not fail the whole sync; it reappears on the next one.
      captureException(error, {
        tags: { component: 'sync-providers-direct-byok' },
        extra: { provider: listing.slug },
      });
      continue;
    }
    const models: OpenRouterModel[] = [];
    for (const { catalogModelId } of catalogModels) {
      const model = findSnapshotModel(providers, catalogModelId);
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
    if (models.length === 0) continue;
    models.sort((a, b) => a.name.localeCompare(b.name));
    injected.push({ ...listing, byokOnly: true, models });
  }
  return [...providers, ...injected];
}
