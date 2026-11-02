import {
  ReasoningEffortSchema,
  type ReasoningOption,
  type StoredModel,
  type VercelCatalog,
} from '@kilocode/db/schema-types';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { getIgnoredProviders } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import {
  extractVercelInferenceProviderIdsFromModel,
  getVercelModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import { getOpenCodeSettingsForReasoningOptions } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import {
  effortOptions,
  REASONING_TOGGLE,
} from '@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
  mapVercelModelIdToOpenRouter,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getVercelInferenceProvidersExcludingIgnored } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import { getRuntimeGatewayRoutingConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/routing-config';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';

export type VercelOnlyModel = {
  /** The OpenRouter-style ID that routes to the Vercel model. */
  id: string;
  storedModel: StoredModel;
  catalog: VercelCatalog;
};

/**
 * The Vercel chat models that no OpenRouter or Kilo-exclusive model routes to, under the
 * OpenRouter-style IDs that route back to them. Only models in the stored Vercel metadata count,
 * because routing checks that list.
 */
export function findVercelOnlyModels({
  openRouterModelIds,
  vercelMetadata,
  overrides,
}: {
  openRouterModelIds: Iterable<string>;
  vercelMetadata: StoredModelMap;
  overrides: VercelModelIdOverrides;
}): VercelOnlyModel[] {
  const coveredVercelModelIds = new Set(
    [...openRouterModelIds, ...kiloExclusiveModels.map(model => model.public_id)].map(id =>
      mapResolvedModelIdToVercel(id, overrides)
    )
  );
  return Object.values(vercelMetadata).flatMap(storedModel => {
    const { catalog } = storedModel;
    if (
      !catalog ||
      storedModel.type !== 'language' ||
      !catalog.modalities.output.includes('text') ||
      coveredVercelModelIds.has(storedModel.id)
    ) {
      return [];
    }
    const id = mapVercelModelIdToOpenRouter(storedModel.id, overrides);
    // The proxy lowercases requested model IDs before routing.
    return id && id === id.toLowerCase() ? [{ id, storedModel, catalog }] : [];
  });
}

function getModelPrefix(modelId: string): string | undefined {
  const slashIndex = modelId.indexOf('/');
  return slashIndex > 0 ? modelId.slice(0, slashIndex) : undefined;
}

/** OpenRouter names start with the vendor, as in `Qwen: Qwen3 Max`. */
export function getVendorNamesByModelPrefix(
  openRouterModels: Iterable<{ id: string; name: string }>
): ReadonlyMap<string | undefined, string> {
  const vendorNames = new Map<string | undefined, string>();
  for (const { id, name } of openRouterModels) {
    const prefix = getModelPrefix(id);
    const separatorIndex = name.indexOf(': ');
    if (prefix && separatorIndex > 0 && !vendorNames.has(prefix)) {
      vendorNames.set(prefix, name.slice(0, separatorIndex));
    }
  }
  return vendorNames;
}

export function getVercelOnlyModelName(
  { id, storedModel }: VercelOnlyModel,
  vendorNames: ReadonlyMap<string | undefined, string>
): string {
  const vendorName = vendorNames.get(getModelPrefix(id));
  return vendorName ? `${vendorName}: ${storedModel.name}` : storedModel.name;
}

/**
 * Vercel's reasoning options in models.dev format. A token budget can only switch reasoning on or
 * off there. Undefined when none translate, because an empty list means reasoning is always on.
 */
function toReasoningOptions(
  vercelOptions: VercelCatalog['reasoning_options'] = []
): ReasoningOption[] | undefined {
  const hasToggle = vercelOptions.some(
    option => option.type === 'toggle' || option.type === 'budget_tokens'
  );
  const efforts = vercelOptions.flatMap(option => {
    const values = (option.type === 'effort' ? (option.values ?? []) : []).flatMap(
      value => ReasoningEffortSchema.safeParse(value).data ?? []
    );
    return values.length > 0 ? effortOptions(...values) : [];
  });
  const options = [...(hasToggle ? REASONING_TOGGLE : []), ...efforts];
  return options.length > 0 ? options : undefined;
}

function toVercelOnlyCatalogModel(model: VercelOnlyModel, name: string): OpenRouterModel {
  const { id, catalog } = model;
  const { pricing } = catalog;
  const reasoningOptions = toReasoningOptions(catalog.reasoning_options);
  return {
    id,
    name,
    // Vercel's `created` is when Vercel added the model, often a shared backfill date.
    created: catalog.released ?? catalog.created,
    description: catalog.description,
    architecture: {
      input_modalities: catalog.modalities.input,
      output_modalities: catalog.modalities.output,
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: catalog.context_window,
      max_completion_tokens: catalog.max_tokens,
    },
    pricing: {
      prompt: pricing.input,
      completion: pricing.output,
      ...(pricing.input_cache_read && { input_cache_read: pricing.input_cache_read }),
      ...(pricing.input_cache_write && { input_cache_write: pricing.input_cache_write }),
    },
    context_length: catalog.context_window,
    supported_parameters: catalog.supported_parameters,
    expiration_date: catalog.deprecated_at
      ? new Date(catalog.deprecated_at).toISOString().slice(0, 10)
      : undefined,
    opencode: reasoningOptions && getOpenCodeSettingsForReasoningOptions(id, reasoningOptions),
  };
}

/**
 * Whether a Vercel provider remains after the providers Kilo always excludes outside non-trial
 * enterprise organizations.
 */
function hasRoutableProvider({ id, storedModel }: VercelOnlyModel) {
  return (
    getVercelInferenceProvidersExcludingIgnored(
      getIgnoredProviders(id, false),
      undefined,
      extractVercelInferenceProviderIdsFromModel(storedModel)
    ).length > 0
  );
}

/**
 * Catalog entries for the chat models only Vercel AI Gateway serves, newest first. Empty when Kilo
 * does not route to Vercel.
 */
export async function getVercelOnlyCatalogModels({
  openRouterModels,
  openRouterMetadata,
}: {
  openRouterModels: readonly OpenRouterModel[];
  openRouterMetadata: StoredModelMap;
}): Promise<OpenRouterModel[]> {
  const [routingConfig, vercelMetadata, overrides] = await Promise.all([
    getRuntimeGatewayRoutingConfig(),
    getVercelModelsMetadataFromDatabase(),
    getVercelModelIdOverrides(),
  ]);
  if (!routingConfig.vercelEnabled) return [];

  const vendorNames = getVendorNamesByModelPrefix(openRouterModels);
  return findVercelOnlyModels({
    openRouterModelIds: [
      ...openRouterModels.map(model => model.id),
      ...Object.keys(openRouterMetadata),
    ],
    vercelMetadata,
    overrides,
  })
    .filter(model => !routingConfig.vercelOptOutModels.has(model.id) && hasRoutableProvider(model))
    .map(model => toVercelOnlyCatalogModel(model, getVercelOnlyModelName(model, vendorNames)))
    .sort((a, b) => b.created - a.created);
}
