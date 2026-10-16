import { mapResolvedModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
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
  dataPolicy?: { training: boolean; retainsPrompts: boolean }
): OpenRouterModel {
  const freeSuffixIndex = model.name.indexOf(' (free)');
  return {
    ...model,
    name: freeSuffixIndex >= 0 ? model.name.substring(0, freeSuffixIndex) : model.name,
    context_length: endpoint.context_length ?? model.context_length,
    endpoint: {
      provider_display_name: providerDisplayName,
      is_free: !endpoint.pricing?.prompt,
      pricing: endpoint.pricing ?? { prompt: '0', completion: '0' },
      ...(dataPolicy && { data_policy: dataPolicy }),
    },
  };
}

export function injectExtraProviderModels(
  vercelModels: Record<string, StoredModel>,
  providerModelData: ProviderModelData
) {
  for (const model of getUniqueModels(providerModelData)) {
    const vercelModel = vercelModels[mapResolvedModelIdToVercel(model.slug)];
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

function createVercelOnlyProvider(providerId: string): OpenRouterProvider {
  const metadata = vercelOnlyProviderMetadata.get(providerId);
  const displayName = metadata?.displayName ?? toDisplayName(providerId);
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

/**
 * Adds providers that serve snapshot models only through Vercel AI Gateway, so
 * the provider list covers every provider a routed request may reach. Vercel
 * reports per-endpoint ZDR and no-training guarantees; a missing guarantee is
 * treated as training on and retaining prompts.
 */
export function injectVercelOnlyProviders(
  vercelModels: Record<string, StoredModel>,
  providerModelData: ProviderModelData
) {
  const knownVercelProviderIds = new Set(
    providerModelData.map(({ provider }) => openRouterToVercelInferenceProviderId(provider.slug))
  );
  const vercelOnlyProviders = new Map<string, ProviderModelData[number]>();

  for (const model of getUniqueModels(providerModelData)) {
    const vercelModel = vercelModels[mapResolvedModelIdToVercel(model.slug)];
    if (!vercelModel) continue;

    for (const endpoint of vercelModel.endpoints) {
      const providerId = getVercelEndpointProviderId(endpoint);
      if (!providerId || knownVercelProviderIds.has(providerId)) continue;
      if (providerId !== normalizeInferenceProviderId(providerId)) {
        console.warn(
          '[injectVercelOnlyProviders] Skipping provider id that does not survive normalization: %s',
          providerId
        );
        continue;
      }

      let providerData = vercelOnlyProviders.get(providerId);
      if (!providerData) {
        providerData = { provider: createVercelOnlyProvider(providerId), models: [] };
        vercelOnlyProviders.set(providerId, providerData);
      }

      const training = endpoint.has_no_training !== true;
      const retainsPrompts = endpoint.has_zdr !== true;
      const { dataPolicy } = providerData.provider;
      dataPolicy.training ||= training;
      dataPolicy.retainsPrompts ||= retainsPrompts;

      const existing = providerData.models.find(m => m.slug === model.slug);
      if (existing?.endpoint) {
        existing.endpoint.data_policy = {
          training: existing.endpoint.data_policy?.training === true || training,
          retainsPrompts: existing.endpoint.data_policy?.retainsPrompts === true || retainsPrompts,
        };
        continue;
      }

      providerData.models.push(
        toVercelEndpointModel(model, endpoint, providerData.provider.displayName, {
          training,
          retainsPrompts,
        })
      );
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
