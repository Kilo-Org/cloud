import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { isPdfSupportingModel } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
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
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { getGatewayOpenCodeSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { AUTO_MODELS, type AutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import {
  getOpenRouterModelsMetadataFromDatabase,
  type StoredModelMap,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getDataCollectionRequiredModelIds,
  getProviderSlugsForModels,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/models-by-provider-index.server';
import { resolvePreferredProviderOrder } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';
import { getPreferredProviderOrderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config';
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
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import {
  getCustomLlmsById,
  isPublicCustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { convertCustomLlmToCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { isCustomLlmDeniedInCountry } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import { addMonths } from 'date-fns';
import { getModelDisplayPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
import {
  assertMinimumCount,
  createCachedMetadataReader,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { readDb } from '@kilocode/web-shared/lib/drizzle';

const OPENROUTER_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_MODELS_FETCH_TIMEOUT_MS = 15_000;

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

/**
 * The price the model picker shows for a catalog entry: the preferred
 * provider's route price when the snapshot knows one, otherwise the entry's
 * own catalog price.
 */
export function pickerModelPricing(
  model: OpenRouterModel,
  endpointsMetadata: StoredModelMap,
  preferredProviderOrderConfig: PreferredProviderOrderConfig
): OpenRouterModel['pricing'] {
  const preferredProvider = resolvePreferredProviderOrder(
    preferredProviderOrderConfig,
    model.id
  ).at(0);
  const endpoints = endpointsMetadata[model.id]?.endpoints ?? [];
  const rawPricing = !preferredProvider
    ? endpoints[0]?.pricing
    : (endpoints.find(e => e.tag === preferredProvider)?.pricing ??
      endpoints.find(
        e => normalizeInferenceProviderId(e.tag) === normalizeInferenceProviderId(preferredProvider)
      )?.pricing);
  return getModelDisplayPricing(rawPricing) ?? model.pricing;
}

/**
 * The catalog entry the picker adds for an id that the OpenRouter response
 * does not carry: one of Kilo's own Auto models.
 */
export function pickerExtraModel(modelId: string): OpenRouterModel | undefined {
  return buildAutoModels().find(model => model.id === modelId);
}

async function enhancedModelList(models: OpenRouterModel[], countryCode: string | null) {
  const autoModels = buildAutoModels();
  const [
    endpointsMetadata,
    dataCollectionRequiredModelIds,
    preferredModels,
    unavailableModelIds,
    preferredProviderOrderConfig,
    customLlmsById,
    customPricingConfig,
  ] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getDataCollectionRequiredModelIds(),
    getPreferredModels(),
    getUnavailableModelIds(),
    getPreferredProviderOrderConfig(),
    getCustomLlmsById(),
    getCustomPricingConfig(),
  ]);
  const publicCustomLlms = [...customLlmsById.values()].flatMap(customLlm =>
    isPublicCustomLlm(customLlm.definition) &&
    !unavailableModelIds.has(customLlm.public_id.toLowerCase()) &&
    !isCustomLlmDeniedInCountry(customLlm.definition, countryCode)
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
        // OpenRouter may add a model after a custom LLM claimed its id, and
        // routing serves the custom LLM.
        !customLlmsById.has(model.id.toLowerCase()) &&
        !unavailableModelIds.has(model.id) &&
        !model.id.endsWith(':batch')
    )
    .map((model): OpenRouterModel => {
      const pricing = pickerModelPricing(model, endpointsMetadata, preferredProviderOrderConfig);
      const terminalBench = terminalBenchFor(summaries, model.id);
      const aliasTarget = model.id.startsWith('~')
        ? endpointsMetadata[model.id]?.alias_target?.slug
        : undefined;
      return {
        ...model,
        pricing,
        ...(terminalBench && { terminalBench }),
        alias_target: aliasTarget,
      };
    })
    .concat(autoModels)
    .map(model => applyCustomPricingToModel(customPricingConfig, model))
    // Public custom LLMs are complete as defined; id-based pricing, PDF, and
    // protocol guesses below would describe a model routing does not serve.
    .concat(publicCustomLlmModels);
  const providerLookupId = (model: OpenRouterModel) => model.alias_target ?? model.id;
  const indexedProviders = await getProviderSlugsForModels(catalogModels.map(providerLookupId));
  const enhancedModels = await Promise.all(
    catalogModels.map(async (model: OpenRouterModel) => {
      const preferredIndex = preferredModels.indexOf(model.id);
      const providerIds =
        publicCustomLlmProviders.get(model.id) ??
        indexedProviders.get(providerLookupId(model)) ??
        [];
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
      const isFree = isFreeModel(model.id);
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
 * Reads one OpenRouter catalogue: fetch, sanitize, validate and report.
 * Callers own the URL, the headers and the cache policy; the metadata cache readers use this
 * as their live fallback, and the local fake LLM transcription catalogue always fetches live.
 */
async function fetchOpenRouterModels(
  url: string,
  init: Parameters<typeof fetch>[1],
  { subject, endpoint }: { subject: 'models' | 'transcription models'; endpoint: string }
): Promise<OpenRouterModelsResponse> {
  const response = await fetch(url, init);

  if (!response.ok) {
    const errorMessage = `Failed to fetch OpenRouter ${subject}: ${response.status} ${response.statusText}`;
    captureException(new Error(errorMessage), {
      tags: { endpoint, source: 'openrouter_api' },
      extra: {
        status: response.status,
        statusText: response.statusText,
      },
    });
    throw new Error(`Failed to fetch ${subject} from OpenRouter API`);
  }

  const data = removeUpstreamEnkrypt(await response.json());

  const parseResult = OpenRouterModelsResponseSchema.safeParse(data);

  if (!parseResult.success) {
    errorExceptInTest(`OpenRouter ${subject} response not in expected format:`, parseResult.error);

    captureMessage(`openrouter ${subject} not in expected format!`, {
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

function openRouterModelsHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER.apiKey}`,
    ...ATTRIBUTION_HEADERS,
  };
}

function openRouterModelsSource(
  url: string,
  minimumCount: number
): MetadataSource<OpenRouterModelsResponse> {
  return {
    url,
    headers: openRouterModelsHeaders,
    parse: raw => {
      const parsed = OpenRouterModelsResponseSchema.parse(removeUpstreamEnkrypt(raw));
      assertMinimumCount(url, parsed.data.length, minimumCount);
      return parsed;
    },
  };
}

function createOpenRouterModelsReader(
  source: MetadataSource<OpenRouterModelsResponse>,
  { subject, endpoint }: { subject: 'models' | 'transcription models'; endpoint: string }
) {
  return createCachedMetadataReader(source, {
    fromDb: readDb,
    ttlMs: OPENROUTER_MODELS_CACHE_TTL_MS,
    fetchFallback: () =>
      fetchOpenRouterModels(
        source.url,
        {
          method: 'GET',
          headers: openRouterModelsHeaders(),
          cache: 'no-store',
          signal: AbortSignal.timeout(OPENROUTER_MODELS_FETCH_TIMEOUT_MS),
        },
        { subject, endpoint }
      ),
  });
}

export const openRouterModelsMetadataSource = openRouterModelsSource(
  `${OPENROUTER.apiUrl}/models`,
  100
);

export const openRouterTranscriptionModelsMetadataSource = openRouterModelsSource(
  `${OPENROUTER.apiUrl}/models?output_modalities=transcription`,
  1
);

const openRouterModelsReader = createOpenRouterModelsReader(openRouterModelsMetadataSource, {
  subject: 'models',
  endpoint: 'openrouter/models',
});

const openRouterTranscriptionModelsReader = createOpenRouterModelsReader(
  openRouterTranscriptionModelsMetadataSource,
  { subject: 'transcription models', endpoint: 'openrouter/transcription-models' }
);

export function resetOpenRouterModelsCaches() {
  openRouterModelsReader.reset();
  openRouterTranscriptionModelsReader.reset();
}

/**
 * Raw, unfiltered OpenRouter models, read from the metadata cache table (live fetch only when
 * the row is missing or unusable) and kept in memory for 5 minutes.
 * Use this for syncing model stats where you need complete data including :free variants
 */
export async function getRawOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  return openRouterModelsReader.get();
}

/**
 * Fetch enhanced models from OpenRouter API with filtering and UI enhancements
 * Use this for user-facing model selection where you want filtered, sorted models
 */
export async function getEnhancedOpenRouterModels({
  countryCode,
}: {
  /** The requester's Vercel IP country; custom LLMs denied there are left out.
   * Null lists every custom LLM, for callers that do not serve a request. */
  countryCode: string | null;
}): Promise<OpenRouterModelsResponse> {
  const rawResponse = await getRawOpenRouterModels();

  // If data is not in expected format (e.g., validation failed), return as-is
  if (!rawResponse.data || !Array.isArray(rawResponse.data)) {
    return rawResponse;
  }

  const models = await enhancedModelList(rawResponse.data, countryCode);
  const snapshot = await getEnkryptBenchmarks();
  return { data: publishEnkryptModels(models, snapshot) };
}
/**
 * OpenRouter speech-to-text models, read like `getRawOpenRouterModels`. The local fake LLM
 * catalogue is always fetched live.
 */
export async function getOpenRouterTranscriptionModels(): Promise<OpenRouterModelsResponse> {
  const localFakeModelsUrl = getLocalFakeTranscriptionModelsUrl();
  if (!localFakeModelsUrl) {
    return openRouterTranscriptionModelsReader.get();
  }
  return fetchOpenRouterModels(
    localFakeModelsUrl,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${LOCAL_FAKE_LLM_API_KEY}`, ...ATTRIBUTION_HEADERS },
      cache: 'no-store',
      signal: AbortSignal.timeout(OPENROUTER_MODELS_FETCH_TIMEOUT_MS),
    },
    { subject: 'transcription models', endpoint: 'openrouter/transcription-models' }
  );
}
