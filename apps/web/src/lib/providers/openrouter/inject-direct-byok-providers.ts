import { captureException } from '@sentry/nextjs';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import {
  getDirectByokProviderListings,
  listDirectByokCatalogModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  getOpenRouterAliasTarget,
  type GatewayModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
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
 * The snapshot's latest aliases (`~vendor/family-latest`) whose target is among `models`, listed
 * like their target, as catalog-mode keys serve an alias by its target.
 */
function latestAliasModels(
  providers: readonly NormalizedProvider[],
  storedModels: GatewayModelMap,
  models: readonly OpenRouterModel[]
): OpenRouterModel[] {
  const aliasModels: OpenRouterModel[] = [];
  for (const aliasId of Object.keys(storedModels)) {
    const targetId = getOpenRouterAliasTarget(storedModels, aliasId);
    if (!targetId) continue;
    const normalizedTargetId = normalizeModelId(targetId);
    const target = models.find(model => normalizeModelId(model.slug) === normalizedTargetId);
    const alias = target && findSnapshotModel(providers, aliasId);
    if (!target || !alias || models.some(model => model.slug === alias.slug)) continue;
    aliasModels.push({
      ...target,
      slug: alias.slug,
      name: alias.name,
      description: alias.description,
    });
  }
  return aliasModels;
}

/**
 * Appends the direct BYOK providers with their own listing as BYOK-only providers, with the catalog
 * models their keys serve in catalog mode and the latest aliases of those models, so provider
 * allow-lists can name them. Other direct BYOK providers serve under a provider the snapshot already
 * lists. A listing whose slug the snapshot already has, or that serves no snapshot model, is left
 * out.
 */
export async function injectDirectByokProviders(
  providers: readonly NormalizedProvider[],
  storedModels: GatewayModelMap
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
    models.push(...latestAliasModels(providers, storedModels, models));
    models.sort((a, b) => a.name.localeCompare(b.name));
    injected.push({ ...listing, byokOnly: true, models });
  }
  return [...providers, ...injected];
}
