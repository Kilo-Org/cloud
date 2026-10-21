import { isPdfSupportingModel } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  getLocalFakeTranscriptionModelsUrl,
  LOCAL_FAKE_LLM_API_KEY,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { convertFromKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { getGatewayOpenCodeSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { AUTO_MODELS, type AutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getDataCollectionRequiredModelIds,
  getProviderSlugsForModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { getPreferredProviderOrder } from '@kilocode/web-shared/lib/ai-gateway/providers/apply-provider-specific-logic';
import { normalizeInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import {
  getTerminalBenchSummaries,
  terminalBenchFor,
} from '@kilocode/web-shared/lib/model-stats/terminal-bench';
import {
  getEnkryptBenchmarks,
  publishEnkryptModels,
} from '@kilocode/web-shared/lib/model-stats/enkrypt';
import {
  isFreeNemotronModel,
  NVIDIA_TRIAL_TOS,
} from '@kilocode/web-shared/lib/ai-gateway/providers/nvidia';
import { applyCustomPricingToModel } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import {
  getCustomLlmsById,
  isPublicCustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { convertCustomLlmToCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { addMonths } from 'date-fns';
import { getModelDisplayPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';

// Re-export from shared module for backwards compatibility
export { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
export {
  getModelDisplayPricing,
  undoPricingDiscount,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
export type { EndpointPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';

export function buildAutoModelCatalogEntry(m: AutoModel): OpenRouterModel {
  const input_modalities = ['text'];
  if (m.supports_images) {
    input_modalities.push('image');
  }
  if (m.supports_pdf) {
    input_modalities.push('pdf');
  }
  return {
    id: m.id,
    name: m.name,
    created: 0,
    description: m.description,
    architecture: {
      input_modalities: input_modalities,
      output_modalities: ['text'],
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: m.context_length,
      max_completion_tokens: m.max_completion_tokens,
    },
    pricing: {
      prompt: m.pricing.prompt,
      completion: m.pricing.completion,
      input_cache_read: m.pricing.input_cache_read,
      input_cache_write: m.pricing.input_cache_write,
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
    },
    context_length: m.context_length,
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
    opencode: m.opencode_settings && withLegacyVariants(m.opencode_settings),
  };
}

function buildAutoModels(): OpenRouterModel[] {
  return AUTO_MODELS.map(buildAutoModelCatalogEntry);
}

export function formatName(model: OpenRouterModel, preferredIndex: number) {
  const name =
    model.id.startsWith('openrouter/') && !model.name.includes('OpenRouter')
      ? 'OpenRouter ' + model.name
      : model.name;
  const promptPrice = Number.parseFloat(model.pricing.prompt);
  const isExpensive = Number.isFinite(promptPrice) && promptPrice >= 0.00001; // Opus 4.8 Fast price
  if (isExpensive) return name + ' ($$$$)';
  if (name.endsWith(')')) return name;
  const ageDays = (Date.now() / 1_000 - model.created) / (24 * 3600);
  const isNew = preferredIndex >= 0 && ageDays >= 0 && ageDays < 7;
  if (isNew) return name + ' (new)';
  if (model.expiration_date) {
    const expirationDate = new Date(model.expiration_date);
    if (expirationDate <= addMonths(new Date(), 1)) {
      const suffix = expirationDate.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: 'UTC',
      });
      return name + ' (retires ' + suffix + ')';
    }
  }
  return name;
}

async function enhancedModelList(models: OpenRouterModel[]) {
  const autoModels = buildAutoModels();
  const [
    endpointsMetadata,
    dataCollectionRequiredModelIds,
    preferredModels,
    unavailableModelIds,
    customLlmsById,
  ] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getDataCollectionRequiredModelIds(),
    getPreferredModels(),
    getUnavailableModelIds(),
    getCustomLlmsById(),
  ]);
  // A custom LLM takes precedence over any built-in model with the same id.
  const isShadowedByCustomLlm = (modelId: string) => customLlmsById.has(modelId.toLowerCase());
  const publicCustomLlms = [...customLlmsById.values()].flatMap(customLlm =>
    isPublicCustomLlm(customLlm.definition)
      ? [{ ...customLlm, definition: customLlm.definition }]
      : []
  );
  const publicCustomLlmProviders = new Map(
    publicCustomLlms.map(({ public_id, definition }) => [
      public_id,
      definition.public.inference_providers,
    ])
  );
  const publicCustomLlmModels = publicCustomLlms.map(({ public_id, definition }) =>
    convertCustomLlmToCatalogModel(public_id, definition)
  );
  const hasEndpointsMetadata = Object.keys(endpointsMetadata).length > 0;
  const summaries = await getTerminalBenchSummaries();
  const catalogModels = models
    .filter(
      model =>
        (!hasEndpointsMetadata || endpointsMetadata[model.id] !== undefined) &&
        !isShadowedByCustomLlm(model.id) &&
        !kiloExclusiveModels.some(m => m.public_id === model.id) &&
        !unavailableModelIds.has(model.id) &&
        !model.id.endsWith(':batch')
    )
    .map((model): OpenRouterModel => {
      const preferredProvider = getPreferredProviderOrder(model.id).at(0);
      const endpoints = endpointsMetadata[model.id]?.endpoints ?? [];
      const rawPricing = !preferredProvider
        ? endpoints[0]?.pricing
        : (endpoints.find(e => e.tag === preferredProvider)?.pricing ??
          endpoints.find(
            e =>
              normalizeInferenceProviderId(e.tag) ===
              normalizeInferenceProviderId(preferredProvider)
          )?.pricing);
      const pricing = getModelDisplayPricing(rawPricing);
      const terminalBench = terminalBenchFor(summaries, model.id);
      const aliasTarget = model.id.startsWith('~')
        ? endpointsMetadata[model.id]?.alias_target?.slug
        : undefined;
      return {
        ...model,
        ...(pricing && { pricing }),
        ...(terminalBench && { terminalBench }),
        alias_target: aliasTarget,
      };
    })
    .concat(
      kiloExclusiveModels
        .filter(m => !unavailableModelIds.has(m.public_id) && !isShadowedByCustomLlm(m.public_id))
        .map(model => convertFromKiloExclusiveModel(model))
    )
    .concat(autoModels)
    .map(applyCustomPricingToModel)
    // Public custom LLMs are complete as defined; id-based pricing, PDF, and
    // protocol guesses below would describe a model routing does not serve.
    .concat(publicCustomLlmModels);
  const exclusiveById = new Map(
    kiloExclusiveModels
      .filter(entry => !isShadowedByCustomLlm(entry.public_id))
      .map(entry => [entry.public_id, entry])
  );
  const providerLookupId = (model: OpenRouterModel) =>
    exclusiveById.get(model.id)?.internal_id ?? model.alias_target ?? model.id;
  const indexedProviders = await getProviderSlugsForModels(catalogModels.map(providerLookupId));
  const enhancedModels = await Promise.all(
    catalogModels.map(async (model: OpenRouterModel) => {
      const preferredIndex = preferredModels.indexOf(model.id);
      const exclusive = exclusiveById.get(model.id);
      const providerIds =
        publicCustomLlmProviders.get(model.id) ??
        (exclusive && exclusive.inference_providers.length > 0
          ? exclusive.inference_providers
          : (indexedProviders.get(providerLookupId(model)) ?? []));
      const inferenceProviderIds = [
        ...new Set([...providerIds].map(id => normalizeInferenceProviderId(id))),
      ];
      const isPublicCustomLlmModel = publicCustomLlmProviders.has(model.id);
      const addPdf =
        !isPublicCustomLlmModel &&
        isPdfSupportingModel(model.id) &&
        !model.architecture.input_modalities.includes('pdf');
      const description =
        !isPublicCustomLlmModel && isFreeNemotronModel(model.id)
          ? model.description + '\n\n**Terms of service** ' + NVIDIA_TRIAL_TOS
          : model.description;
      const isFree = await isFreeModel(model.id);
      return {
        ...model,
        inference_provider_ids: inferenceProviderIds,
        name: formatName(model, preferredIndex),
        description,
        preferredIndex: preferredIndex >= 0 ? preferredIndex : undefined,
        isFree: model.isFree ?? isFree,
        mayTrainOnYourPrompts:
          model.mayTrainOnYourPrompts ?? (isFree || dataCollectionRequiredModelIds.has(model.id)),
        // A custom LLM's protocol comes only from its definition, as in routing.
        opencode: isPublicCustomLlmModel
          ? model.opencode
          : (model.opencode ??
            (await getGatewayOpenCodeSettings(
              model.id,
              model.supported_parameters?.includes('reasoning') ?? false
            ))),
        architecture: addPdf
          ? {
              ...model.architecture,
              input_modalities: model.architecture.input_modalities.concat(['pdf']),
            }
          : model.architecture,
      };
    })
  );
  const sortedModels = enhancedModels.sort((a, b) => {
    // Sort by preferredIndex (undefined values last)
    if (a.preferredIndex !== undefined && b.preferredIndex === undefined) return -1;
    if (a.preferredIndex === undefined && b.preferredIndex !== undefined) return 1;

    // If both have preferredIndex, sort by the index value
    if (a.preferredIndex !== undefined && b.preferredIndex !== undefined) {
      return a.preferredIndex - b.preferredIndex;
    }

    // If neither has preferredIndex, maintain original order
    return 0;
  });
  return sortedModels;
}

function removeUpstreamEnkrypt(response: unknown): unknown {
  if (
    !response ||
    typeof response !== 'object' ||
    !('data' in response) ||
    !Array.isArray(response.data)
  ) {
    return response;
  }
  return {
    ...response,
    data: response.data.map((model: unknown) => {
      if (!model || typeof model !== 'object' || !('enkrypt' in model)) return model;
      const sanitized: Record<string, unknown> = { ...model };
      delete sanitized.enkrypt;
      return sanitized;
    }),
  };
}

/**
 * Fetch raw, unfiltered models from OpenRouter API
 * Use this for syncing model stats where you need complete data including :free variants
 */
export async function getRawOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  const response = await fetch(`${OPENROUTER.apiUrl}/models`, {
    cache: 'force-cache',
    method: 'GET',
    headers: {
      Authorization: `Bearer ${OPENROUTER.apiKey}`,
      ...ATTRIBUTION_HEADERS,
    },
    next: { revalidate: 60 },
  });

  if (!response.ok) {
    const errorMessage = `Failed to fetch OpenRouter models: ${response.status} ${response.statusText}`;
    captureException(new Error(errorMessage), {
      tags: { endpoint: 'openrouter/models', source: 'openrouter_api' },
      extra: {
        status: response.status,
        statusText: response.statusText,
      },
    });
    throw new Error('Failed to fetch models from OpenRouter API');
  }

  const data = removeUpstreamEnkrypt(await response.json());

  const parseResult = OpenRouterModelsResponseSchema.safeParse(data);

  if (!parseResult.success) {
    errorExceptInTest('OpenRouter models response not in expected format:', parseResult.error);

    captureMessage('openrouter models not in expected format!', {
      level: 'error',
      extra: {
        data,
        zodError: parseResult.error.issues,
      },
    });
    // Return data as-is if parsing fails, maintaining existing behavior
    return data as OpenRouterModelsResponse;
  }

  return parseResult.data;
}

/**
 * Fetch enhanced models from OpenRouter API with filtering and UI enhancements
 * Use this for user-facing model selection where you want filtered, sorted models
 */
export async function getEnhancedOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  const rawResponse = await getRawOpenRouterModels();

  // If data is not in expected format (e.g., validation failed), return as-is
  if (!rawResponse.data || !Array.isArray(rawResponse.data)) {
    return rawResponse;
  }

  const models = await enhancedModelList(rawResponse.data);
  const snapshot = await getEnkryptBenchmarks();
  return { data: publishEnkryptModels(models, snapshot) };
}
/**
 * Fetch speech-to-text models from the OpenRouter API.
 */
export async function getOpenRouterTranscriptionModels(): Promise<OpenRouterModelsResponse> {
  const localFakeModelsUrl = getLocalFakeTranscriptionModelsUrl();
  const response = await fetch(
    localFakeModelsUrl ?? `${OPENROUTER.apiUrl}/models?output_modalities=transcription`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${localFakeModelsUrl ? LOCAL_FAKE_LLM_API_KEY : OPENROUTER.apiKey}`,
        ...ATTRIBUTION_HEADERS,
      },
      // Never serve a cached catalogue: a cached answer would mask an
      // unreachable gateway and the mobile picker would list stale models
      // instead of showing its load-failed retry state.
      cache: 'no-store',
    }
  );

  if (!response.ok) {
    const errorMessage = `Failed to fetch OpenRouter transcription models: ${response.status} ${response.statusText}`;
    captureException(new Error(errorMessage), {
      tags: { endpoint: 'openrouter/transcription-models', source: 'openrouter_api' },
      extra: {
        status: response.status,
        statusText: response.statusText,
      },
    });
    throw new Error('Failed to fetch transcription models from OpenRouter API');
  }

  const data = removeUpstreamEnkrypt(await response.json());

  const parseResult = OpenRouterModelsResponseSchema.safeParse(data);

  if (!parseResult.success) {
    errorExceptInTest(
      'OpenRouter transcription models response not in expected format:',
      parseResult.error
    );

    captureMessage('openrouter transcription models not in expected format!', {
      level: 'error',
      extra: {
        data,
        zodError: parseResult.error.issues,
      },
    });
    return data as OpenRouterModelsResponse;
  }

  return parseResult.data;
}
