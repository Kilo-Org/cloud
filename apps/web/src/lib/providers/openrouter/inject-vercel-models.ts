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
import type { Endpoint } from '@kilocode/db/schema-types';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  findVercelOnlyModels,
  getVendorNamesByModelPrefix,
  getVercelOnlyModelName,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-only-models';
import { normalizePublicInferenceProvider } from '@/lib/public-inference-provider';

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
  dataPolicy?: EndpointDataPolicy,
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

type VercelOnlyProviderMetadata = {
  termsOfServiceURL: string;
  privacyPolicyURL: string;
};

/** Vercel's API has no provider metadata, so known providers are listed here. */
const vercelOnlyProviderMetadata = new Map<string, VercelOnlyProviderMetadata>(
  Object.entries({
    boundless: {
      termsOfServiceURL: 'https://boundless.network/terms-of-service',
      privacyPolicyURL: 'https://boundless.network/privacy-policy',
    },
    particle: {
      termsOfServiceURL: 'https://particle.ai/legal/terms',
      privacyPolicyURL: 'https://particle.ai/legal/privacy',
    },
    runinfra: {
      termsOfServiceURL: 'https://runinfra.ai/terms-of-service',
      privacyPolicyURL: 'https://runinfra.ai/privacy-policy',
    },
    runware: {
      termsOfServiceURL: 'https://runware.ai/terms',
      privacyPolicyURL: 'https://runware.ai/privacy',
    },
  })
);

function createVercelOnlyProvider(providerId: string): OpenRouterProvider {
  const metadata = vercelOnlyProviderMetadata.get(providerId);
  const displayName = normalizePublicInferenceProvider(providerId).name;
  return {
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
}

type ProviderData = ProviderModelData[number];

type VercelOffering = {
  model: OpenRouterModel;
  endpoints: readonly Endpoint[];
} & ({ isVercelOnly: false } | { isVercelOnly: true; isFree: boolean });

type EndpointDataPolicy = { training: boolean; retainsPrompts: boolean };

/** Vercel reports per-endpoint guarantees; a missing guarantee means training on and retaining prompts. */
function getVercelEndpointDataPolicy(endpoint: Endpoint): EndpointDataPolicy {
  return {
    training: endpoint.has_no_training !== true,
    retainsPrompts: endpoint.has_zdr !== true,
  };
}

/** Lists `model` under the provider, or merges in the worst data policy if it is listed there. */
function addVercelEndpointModel(
  providerData: ProviderData,
  offering: VercelOffering,
  endpoint: Endpoint,
  dataPolicy: EndpointDataPolicy
) {
  const existing = providerData.models.find(m => m.slug === offering.model.slug);
  if (existing) {
    if (existing.endpoint) {
      existing.endpoint.data_policy = {
        training: existing.endpoint.data_policy?.training === true || dataPolicy.training,
        retainsPrompts:
          existing.endpoint.data_policy?.retainsPrompts === true || dataPolicy.retainsPrompts,
      };
    }
    return;
  }

  providerData.models.push(
    toVercelEndpointModel(
      offering.model,
      endpoint,
      providerData.provider.displayName,
      dataPolicy,
      offering.isVercelOnly ? offering.isFree : undefined
    )
  );
}

/**
 * Lists `model` under a provider OpenRouter knows, unless OpenRouter already lists it there.
 * Snapshot models keep the provider's own data policy. A model only Vercel serves takes the worst
 * of the provider's policy and the Vercel endpoint's guarantees, so that every endpoint of the model
 * under the provider must offer a guarantee before it is reported. A model Kilo serves for free is
 * assumed to train on and retain prompts.
 */
function addToOpenRouterProvider(
  providerData: ProviderData,
  offering: VercelOffering,
  endpoint: Endpoint
) {
  if (!offering.isVercelOnly) {
    if (providerData.models.some(m => m.slug === offering.model.slug)) return;
    providerData.models.push(
      toVercelEndpointModel(offering.model, endpoint, providerData.provider.displayName)
    );
    return;
  }

  const providerPolicy = providerData.provider.dataPolicy;
  const endpointPolicy = getVercelEndpointDataPolicy(endpoint);
  addVercelEndpointModel(providerData, offering, endpoint, {
    training: offering.isFree || providerPolicy.training || endpointPolicy.training,
    retainsPrompts:
      offering.isFree || providerPolicy.retainsPrompts || endpointPolicy.retainsPrompts,
  });
}

/**
 * Lists `model` under a provider only Vercel lists, with the Vercel endpoint's guarantees. The
 * provider takes the worst policy of its endpoints, and a model Kilo serves for free is assumed to
 * train on and retain prompts.
 */
function addToVercelOnlyProvider(
  providerData: ProviderData,
  offering: VercelOffering,
  endpoint: Endpoint
) {
  const endpointPolicy = getVercelEndpointDataPolicy(endpoint);
  const { dataPolicy } = providerData.provider;
  dataPolicy.training ||= endpointPolicy.training;
  dataPolicy.retainsPrompts ||= endpointPolicy.retainsPrompts;
  const isFree = offering.isVercelOnly && offering.isFree;
  addVercelEndpointModel(providerData, offering, endpoint, {
    training: isFree || endpointPolicy.training,
    retainsPrompts: isFree || endpointPolicy.retainsPrompts,
  });
}

/** Snapshot models that Vercel also serves, with the Vercel endpoints that serve them. */
function getSnapshotOfferings(
  providerModelData: ProviderModelData,
  vercelModels: GatewayModelMap,
  vercelModelIdOverrides: VercelModelIdOverrides
): VercelOffering[] {
  return [...getUniqueModels(providerModelData)].flatMap((model): VercelOffering[] => {
    const vercelModel =
      vercelModels[mapResolvedModelIdToVercel(model.slug, vercelModelIdOverrides)];
    return vercelModel ? [{ model, endpoints: vercelModel.endpoints, isVercelOnly: false }] : [];
  });
}

/**
 * Chat models only Vercel serves, under the OpenRouter-style ids that route to them. Their catalog
 * entries come from `getVercelOnlyCatalogModels`, which finds them the same way.
 */
function getVercelOnlyOfferings(
  vercelModels: GatewayModelMap,
  openRouterCatalogModels: readonly { id: string; name: string }[],
  openRouterModelIds: Iterable<string>,
  vercelModelIdOverrides: VercelModelIdOverrides,
  updatedAt: string
): VercelOffering[] {
  const vendorNames = getVendorNamesByModelPrefix(openRouterCatalogModels);
  return findVercelOnlyModels({
    openRouterModelIds,
    vercelMetadata: vercelModels,
    overrides: vercelModelIdOverrides,
  }).map(vercelOnlyModel => {
    const { id, storedModel, contextWindow, modalities, pricing } = vercelOnlyModel;
    return {
      model: {
        slug: id,
        name: getVercelOnlyModelName(vercelOnlyModel, vendorNames),
        author: id.includes('/') ? id.slice(0, id.indexOf('/')) : 'Other',
        description: storedModel.description ?? '',
        context_length: contextWindow,
        input_modalities: modalities.input,
        output_modalities: modalities.output,
        group: 'Other',
        updated_at: updatedAt,
        endpoint: null,
      },
      endpoints: storedModel.endpoints.map(endpoint => ({
        ...endpoint,
        pricing: endpoint.pricing ?? {
          prompt: pricing.input,
          completion: pricing.output,
        },
      })),
      isVercelOnly: true,
      isFree: isFreeModel(id),
    };
  });
}

/**
 * Adds what Vercel AI Gateway serves to the OpenRouter snapshot, so the provider list covers every
 * route Kilo may take. Each Vercel endpoint of a snapshot model, and of a chat model only Vercel
 * serves, is listed under the OpenRouter provider it maps to. Endpoints of providers OpenRouter
 * does not list get a provider built from Vercel's data, added after the OpenRouter providers.
 */
export function injectVercelModels({
  vercelModels,
  openRouterCatalogModels,
  openRouterModelIds,
  providerModelData,
  vercelModelIdOverrides,
  updatedAt,
}: {
  vercelModels: GatewayModelMap;
  openRouterCatalogModels: readonly { id: string; name: string }[];
  openRouterModelIds: Iterable<string>;
  providerModelData: ProviderModelData;
  vercelModelIdOverrides: VercelModelIdOverrides;
  updatedAt: string;
}) {
  const openRouterProvidersByVercelId = new Map<string, ProviderData[]>();
  for (const providerData of providerModelData) {
    const vercelProviderId = openRouterToVercelInferenceProviderId(providerData.provider.slug);
    openRouterProvidersByVercelId.set(vercelProviderId, [
      ...(openRouterProvidersByVercelId.get(vercelProviderId) ?? []),
      providerData,
    ]);
  }
  const vercelOnlyOfferings = getVercelOnlyOfferings(
    vercelModels,
    openRouterCatalogModels,
    openRouterModelIds,
    vercelModelIdOverrides,
    updatedAt
  );
  const offerings = [
    ...getSnapshotOfferings(providerModelData, vercelModels, vercelModelIdOverrides),
    ...vercelOnlyOfferings,
  ];

  const vercelOnlyProviders = new Map<string, ProviderData>();
  for (const offering of offerings) {
    for (const endpoint of offering.endpoints) {
      const providerId = getVercelEndpointProviderId(endpoint);
      if (!providerId) continue;

      const openRouterProviders = openRouterProvidersByVercelId.get(providerId);
      if (openRouterProviders) {
        for (const providerData of openRouterProviders) {
          addToOpenRouterProvider(providerData, offering, endpoint);
        }
        continue;
      }

      let providerData = vercelOnlyProviders.get(providerId);
      if (!providerData) {
        if (providerId !== normalizeInferenceProviderId(providerId)) {
          console.warn(
            '[injectVercelModels] Skipping provider id that does not survive normalization: %s',
            providerId
          );
          continue;
        }
        providerData = { provider: createVercelOnlyProvider(providerId), models: [] };
        vercelOnlyProviders.set(providerId, providerData);
      }
      addToVercelOnlyProvider(providerData, offering, endpoint);
    }
  }

  providerModelData.push(...vercelOnlyProviders.values());
  if (vercelOnlyOfferings.length > 0 || vercelOnlyProviders.size > 0) {
    console.warn(
      '[injectVercelModels] Added %d Vercel-only models and %d Vercel-only providers: %s',
      vercelOnlyOfferings.length,
      vercelOnlyProviders.size,
      [...vercelOnlyProviders.keys()].join(', ')
    );
  }
}
