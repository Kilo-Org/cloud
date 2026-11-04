import {
  mapResolvedModelIdToVercel,
  type VercelModelIdOverrides,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  normalizeInferenceProviderId,
  normalizeVercelInferenceProviderIdForRouting,
  openRouterToVercelInferenceProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type {
  OpenRouterModel,
  OpenRouterProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';
import type { Endpoint, StoredModel } from '@kilocode/db/schema-types';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  findVercelOnlyModels,
  getVendorNamesByModelPrefix,
  getVercelOnlyModelName,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-only-models';

type ProviderModelData = Array<{ provider: OpenRouterProvider; models: OpenRouterModel[] }>;

function getUniqueModels(providerModelData: ProviderModelData) {
  const models = new Map<string, OpenRouterModel>();
  for (const { models: providerModels } of providerModelData) {
    for (const model of providerModels) {
      models.set(model.slug, model);
    }
  }
  return models.values();
}

function getVercelEndpointProviderId(endpoint: Endpoint) {
  return normalizeVercelInferenceProviderIdForRouting(endpoint.provider_name ?? endpoint.tag);
}

function toVercelEndpointModel(
  model: OpenRouterModel,
  endpoint: Endpoint,
  providerDisplayName: string,
  dataPolicy?: { training: boolean; retainsPrompts: boolean },
  isFree = !endpoint.pricing?.prompt
): OpenRouterModel {
  const freeSuffixIndex = model.name.indexOf(' (free)');
  return {
    ...model,
    name: freeSuffixIndex >= 0 ? model.name.substring(0, freeSuffixIndex) : model.name,
    context_length: endpoint.context_length ?? model.context_length,
    endpoint: {
      provider_display_name: providerDisplayName,
      is_free: isFree,
      pricing: endpoint.pricing ?? { prompt: '0', completion: '0' },
      ...(dataPolicy && { data_policy: dataPolicy }),
    },
  };
}

export function injectExtraProviderModels(
  vercelModels: Record<string, StoredModel>,
  providerModelData: ProviderModelData,
  vercelModelIdOverrides: VercelModelIdOverrides
) {
  for (const model of getUniqueModels(providerModelData)) {
    const vercelModel =
      vercelModels[mapResolvedModelIdToVercel(model.slug, vercelModelIdOverrides)];
    if (!vercelModel) continue;

    for (const providerData of providerModelData) {
      const vercelProviderId = openRouterToVercelInferenceProviderId(providerData.provider.slug);
      const endpoint = vercelModel.endpoints.find(
        endpoint => getVercelEndpointProviderId(endpoint) === vercelProviderId
      );
      if (endpoint && !providerData.models.some(m => m.slug === model.slug)) {
        const m = toVercelEndpointModel(model, endpoint, providerData.provider.displayName);
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

function toDisplayName(providerId: string) {
  return providerId
    .split(/[-_]/)
    .filter(Boolean)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

type VercelOnlyProviderMetadata = {
  displayName: string;
  termsOfServiceURL: string;
  privacyPolicyURL: string;
};

/** Vercel's API has no provider metadata, so known providers are listed here. */
const vercelOnlyProviderMetadata = new Map<string, VercelOnlyProviderMetadata>(
  Object.entries({
    boundless: {
      displayName: 'Boundless',
      termsOfServiceURL: 'https://boundless.network/terms-of-service',
      privacyPolicyURL: 'https://boundless.network/privacy-policy',
    },
    particle: {
      displayName: 'Particle',
      termsOfServiceURL: 'https://particle.ai/legal/terms',
      privacyPolicyURL: 'https://particle.ai/legal/privacy',
    },
    runinfra: {
      displayName: 'RunInfra',
      termsOfServiceURL: 'https://runinfra.ai/terms-of-service',
      privacyPolicyURL: 'https://runinfra.ai/privacy-policy',
    },
    runware: {
      displayName: 'Runware',
      termsOfServiceURL: 'https://runware.ai/terms',
      privacyPolicyURL: 'https://runware.ai/privacy',
    },
  })
);

/** Providers listed only because Vercel serves models through them. */
const providersOnlyVercelLists = new WeakSet<OpenRouterProvider>();

function createVercelOnlyProvider(providerId: string): OpenRouterProvider {
  const metadata = vercelOnlyProviderMetadata.get(providerId);
  const displayName = metadata?.displayName ?? toDisplayName(providerId);
  const provider: OpenRouterProvider = {
    name: displayName,
    displayName,
    slug: providerId,
    dataPolicy: {
      training: false,
      retainsPrompts: false,
      canPublish: false,
      ...(metadata && {
        termsOfServiceURL: metadata.termsOfServiceURL,
        privacyPolicyURL: metadata.privacyPolicyURL,
      }),
    },
    icon: {
      url: `https://placehold.co/100?text=${providerId.slice(0, 2).toUpperCase()}&font=roboto`,
      className: 'rounded-sm',
    },
  };
  providersOnlyVercelLists.add(provider);
  return provider;
}

function survivesNormalization(providerId: string, caller: string) {
  if (providerId === normalizeInferenceProviderId(providerId)) return true;
  console.warn(
    '[%s] Skipping provider id that does not survive normalization: %s',
    caller,
    providerId
  );
  return false;
}

/**
 * Lists `model` under a provider for one Vercel endpoint. Vercel reports per-endpoint ZDR and
 * no-training guarantees; a missing guarantee is treated as training on and retaining prompts.
 * Providers that only Vercel lists take the worst policy of their endpoints. A model Kilo serves
 * for free is assumed to train on and retain prompts, like free OpenRouter endpoints.
 */
function addVercelEndpointModel(
  providerData: ProviderModelData[number],
  model: OpenRouterModel,
  endpoint: Endpoint,
  isFree?: boolean
) {
  const endpointTraining = endpoint.has_no_training !== true;
  const endpointRetainsPrompts = endpoint.has_zdr !== true;
  if (providersOnlyVercelLists.has(providerData.provider)) {
    const { dataPolicy } = providerData.provider;
    dataPolicy.training ||= endpointTraining;
    dataPolicy.retainsPrompts ||= endpointRetainsPrompts;
  }
  const training = isFree === true || endpointTraining;
  const retainsPrompts = isFree === true || endpointRetainsPrompts;

  const existing = providerData.models.find(m => m.slug === model.slug);
  if (existing?.endpoint) {
    existing.endpoint.data_policy = {
      training: existing.endpoint.data_policy?.training === true || training,
      retainsPrompts: existing.endpoint.data_policy?.retainsPrompts === true || retainsPrompts,
    };
    return;
  }

  providerData.models.push(
    toVercelEndpointModel(
      model,
      endpoint,
      providerData.provider.displayName,
      { training, retainsPrompts },
      isFree
    )
  );
}

/**
 * Adds providers that serve snapshot models only through Vercel AI Gateway, so
 * the provider list covers every provider a routed request may reach.
 */
export function injectVercelOnlyProviders(
  vercelModels: Record<string, StoredModel>,
  providerModelData: ProviderModelData,
  vercelModelIdOverrides: VercelModelIdOverrides
) {
  const knownVercelProviderIds = new Set(
    providerModelData.map(({ provider }) => openRouterToVercelInferenceProviderId(provider.slug))
  );
  const vercelOnlyProviders = new Map<string, ProviderModelData[number]>();

  for (const model of getUniqueModels(providerModelData)) {
    const vercelModel =
      vercelModels[mapResolvedModelIdToVercel(model.slug, vercelModelIdOverrides)];
    if (!vercelModel) continue;

    for (const endpoint of vercelModel.endpoints) {
      const providerId = getVercelEndpointProviderId(endpoint);
      if (!providerId || knownVercelProviderIds.has(providerId)) continue;
      if (!survivesNormalization(providerId, 'injectVercelOnlyProviders')) continue;

      let providerData = vercelOnlyProviders.get(providerId);
      if (!providerData) {
        providerData = { provider: createVercelOnlyProvider(providerId), models: [] };
        vercelOnlyProviders.set(providerId, providerData);
      }
      addVercelEndpointModel(providerData, model, endpoint);
    }
  }

  for (const providerData of vercelOnlyProviders.values()) {
    console.warn(
      '[injectVercelOnlyProviders] Adding Vercel-only provider %s with %d models',
      providerData.provider.slug,
      providerData.models.length
    );
    providerModelData.push(providerData);
  }
}

/**
 * Lists the chat models only Vercel AI Gateway serves under each provider of their Vercel
 * endpoints, adding providers that OpenRouter does not list. Their catalog entries come from
 * `getVercelOnlyCatalogModels`, which finds them the same way.
 */
export function injectVercelOnlyModels({
  vercelModels,
  openRouterCatalogModels,
  openRouterModelIds,
  providerModelData,
  vercelModelIdOverrides,
  updatedAt,
}: {
  vercelModels: Record<string, StoredModel>;
  openRouterCatalogModels: readonly { id: string; name: string }[];
  openRouterModelIds: Iterable<string>;
  providerModelData: ProviderModelData;
  vercelModelIdOverrides: VercelModelIdOverrides;
  updatedAt: string;
}) {
  const vendorNames = getVendorNamesByModelPrefix(openRouterCatalogModels);
  const vercelOnlyModels = findVercelOnlyModels({
    openRouterModelIds,
    vercelMetadata: vercelModels,
    overrides: vercelModelIdOverrides,
  });

  for (const vercelOnlyModel of vercelOnlyModels) {
    const { id, storedModel, catalog } = vercelOnlyModel;
    const isFree = isFreeModel(id);
    const model: OpenRouterModel = {
      slug: id,
      name: getVercelOnlyModelName(vercelOnlyModel, vendorNames),
      author: id.includes('/') ? id.slice(0, id.indexOf('/')) : 'Other',
      description: catalog.description,
      context_length: catalog.context_window,
      input_modalities: catalog.modalities.input,
      output_modalities: catalog.modalities.output,
      group: 'Other',
      updated_at: updatedAt,
      endpoint: null,
    };

    for (const endpoint of storedModel.endpoints) {
      const providerId = getVercelEndpointProviderId(endpoint);
      if (!providerId) continue;
      let providerData = providerModelData.find(
        ({ provider }) => openRouterToVercelInferenceProviderId(provider.slug) === providerId
      );
      if (!providerData) {
        if (!survivesNormalization(providerId, 'injectVercelOnlyModels')) continue;
        providerData = { provider: createVercelOnlyProvider(providerId), models: [] };
        providerModelData.push(providerData);
      }
      addVercelEndpointModel(
        providerData,
        model,
        {
          ...endpoint,
          pricing: endpoint.pricing ?? {
            prompt: catalog.pricing.input,
            completion: catalog.pricing.output,
          },
        },
        isFree
      );
    }
  }

  if (vercelOnlyModels.length > 0) {
    console.warn('[injectVercelOnlyModels] Adding %d Vercel-only models', vercelOnlyModels.length);
  }
}
