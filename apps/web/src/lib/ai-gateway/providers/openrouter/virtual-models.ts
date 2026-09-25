import { normalizeModelId } from '@/lib/ai-gateway/model-utils';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@/lib/ai-gateway/providers/openrouter/openrouter-types';
import { isUnavailableModel } from '@/lib/ai-gateway/unavailable-models';
import type { OpenRouterModel as CatalogModel } from '@/lib/organizations/organization-types';
import type { StoredModel } from '@kilocode/db/schema-types';

/**
 * Snapshot home for gateway models that no inference provider lists, such as
 * `openrouter/auto` or `typesafe/jev-router`. Routers pick the concrete model
 * and provider per request, so they have no provider of their own.
 */
export const VIRTUAL_PROVIDER = {
  name: 'Virtual',
  displayName: 'Virtual',
  slug: 'virtual',
  dataPolicy: { training: false, retainsPrompts: false, canPublish: false },
  icon: {
    url: 'https://placehold.co/100?text=VI&font=roboto',
    className: 'rounded-sm',
  },
} satisfies OpenRouterProvider;

type ProviderModels = Array<{
  provider: OpenRouterProvider;
  models: OpenRouterModel[];
}>;

function isStandardVariant(model: OpenRouterModel): boolean {
  const variant = model.endpoint?.variant;
  return !variant || variant === 'standard';
}

function toVirtualSnapshotModel(model: CatalogModel): OpenRouterModel {
  const { prompt, completion } = model.pricing;
  const isFree = Number(prompt) === 0 && Number(completion) === 0;
  const slug = normalizeModelId(model.id);
  const variant = model.id.slice(slug.length + 1);
  return {
    slug,
    name: model.name,
    author: slug.split('/')[0] ?? '',
    description: model.description,
    context_length: model.context_length,
    input_modalities: model.architecture.input_modalities,
    output_modalities: model.architecture.output_modalities,
    group: model.architecture.tokenizer,
    updated_at: new Date(model.created * 1000).toISOString(),
    endpoint: {
      provider_display_name: VIRTUAL_PROVIDER.displayName,
      ...(variant && { variant }),
      is_free: isFree,
      pricing: { prompt, completion },
      ...(isFree && { data_policy: { training: true, retainsPrompts: true } }),
    },
  };
}

/**
 * Adds gateway catalog models that are missing from every provider's model
 * list. A latest alias (`~vendor/family-latest`) is listed under each provider
 * that serves its alias target, so provider allow lists and routing treat it
 * like the target. Anything else goes to `VIRTUAL_PROVIDER`.
 */
export function injectVirtualModels(params: {
  providerModelData: ProviderModels;
  catalogModels: CatalogModel[];
  storedModels: Record<string, StoredModel>;
}): void {
  const { providerModelData, catalogModels, storedModels } = params;
  const snapshotModelIds = new Set(
    providerModelData.flatMap(({ models }) => models.map(model => normalizeModelId(model.slug)))
  );
  const virtualModels: OpenRouterModel[] = [];

  for (const catalogModel of catalogModels) {
    const modelId = normalizeModelId(catalogModel.id);
    if (
      snapshotModelIds.has(modelId) ||
      catalogModel.id.endsWith(':batch') ||
      isUnavailableModel(catalogModel.id)
    ) {
      continue;
    }
    snapshotModelIds.add(modelId);

    const aliasTargetSlug = storedModels[catalogModel.id]?.alias_target?.slug;
    let isListedUnderAliasTarget = false;
    if (aliasTargetSlug) {
      const aliasTargetId = normalizeModelId(aliasTargetSlug);
      for (const { models } of providerModelData) {
        const target = models.find(
          model => normalizeModelId(model.slug) === aliasTargetId && isStandardVariant(model)
        );
        if (!target) continue;
        models.push({
          ...target,
          slug: modelId,
          name: catalogModel.name,
          description: catalogModel.description,
        });
        isListedUnderAliasTarget = true;
      }
    }

    if (!isListedUnderAliasTarget) {
      virtualModels.push(toVirtualSnapshotModel(catalogModel));
    }
  }

  if (virtualModels.length > 0) {
    providerModelData.push({ provider: VIRTUAL_PROVIDER, models: virtualModels });
  }
}
