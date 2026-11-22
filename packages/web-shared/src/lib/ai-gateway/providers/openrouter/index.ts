import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { isPdfSupportingModel } from '@kilocode/web-shared/lib/ai-gateway/models';
import { getPreferredModels } from '@kilocode/web-shared/lib/ai-gateway/preferred-models';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import {
  getLocalFakeTranscriptionModelsUrl,
  LOCAL_FAKE_LLM_API_KEY,
} from '@kilocode/web-shared/lib/ai-gateway/local-fake-llm';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import type { OpenRouterCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/catalog-schemas';
import { errorExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { getUnavailableModelIds } from '@kilocode/web-shared/lib/ai-gateway/unavailable-models';
import { getGatewayOpenCodeSettings } from '@kilocode/web-shared/lib/ai-gateway/providers/model-settings';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';
import { AUTO_MODELS, type AutoModel } from '@kilocode/web-shared/lib/ai-gateway/auto-model';
import { ATTRIBUTION_HEADERS } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/attribution-headers';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { GatewayModelMap } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-model-metadata';
import {
  describeLatestAliasTarget,
  getLatestAliasTargets,
} from '@kilocode/web-shared/lib/ai-gateway/providers/latest-alias-targets';
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
import type { ModelStatsLoadClient } from '@kilocode/web-shared/lib/model-stats/model-stats-cache';
import {
  isFreeNemotronModel,
  NVIDIA_TRIAL_TOS,
} from '@kilocode/web-shared/lib/ai-gateway/providers/nvidia';
import {
  applyCustomPricingToModel,
  applyCustomPricingToPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing';
import { getCustomPricingConfig } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing-config';
import {
  getCustomLlmsById,
  isPublicCustomLlm,
  type CustomLlm,
  type PublicCustomLlmDefinition,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { convertCustomLlmToCatalogModel } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/listAvailableCustomLlms';
import { isCustomLlmDeniedInCountry } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/country-deny-list';
import {
  nameMarkerFor,
  retirementDate,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/retirement';
import {
  getProviderDisplayPricing,
  getVercelModelForPricing,
  isVercelEndpointOfProvider,
  getVercelPricingMetadata,
  type VercelPricingMetadata,
} from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-endpoint-pricing';
import {
  assertMinimumCount,
  createCachedMetadataReader,
  type MetadataSource,
} from '@kilocode/web-shared/lib/ai-gateway/metadata-cache';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getVercelOnlyCatalogModels } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/vercel-only-models';
import {
  getEndpointPricing,
  type PricingMode,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';

const OPENROUTER_MODELS_CACHE_TTL_MS = 5 * 60 * 1000;
const OPENROUTER_MODELS_FETCH_TIMEOUT_MS = 15_000;

type OpenRouterCatalogueSubject = 'models' | 'transcription models';

/**
 * The fewest entries each catalogue can hold and still be the whole OpenRouter catalogue.
 * A shorter response is a truncated or substituted payload, not a smaller catalogue.
 */
export const OPENROUTER_CATALOGUE_MINIMUM_COUNTS: Record<OpenRouterCatalogueSubject, number> = {
  models: 100,
  'transcription models': 1,
};

// Re-export from shared module for backwards compatibility
export { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
export {
  getModelDisplayPricing,
  undoPricingDiscount,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';
export type { EndpointPricing } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/display-pricing';

export function buildAutoModelCatalogEntry(m: AutoModel): OpenRouterCatalogModel {
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

function buildAutoModels(): OpenRouterCatalogModel[] {
  return AUTO_MODELS.map(buildAutoModelCatalogEntry);
}

/**
 * The name every consumer renders, without any locale-specific copy: the retirement note travels
 * as `retires_on` so each client words it in its own language. The English note the web and the
 * extension show is `modelNameWithRetirement` in `./retirement`.
 */
export function formatName(model: OpenRouterCatalogModel, preferredIndex: number) {
  const name =
    model.id.startsWith('openrouter/') && !model.name.includes('OpenRouter')
      ? 'OpenRouter ' + model.name
      : model.name;
  const marker = nameMarkerFor(model, preferredIndex);
  return marker === 'new' ? name + ' (new)' : name;
}

/**
 * The price the model picker shows for a catalog entry: the preferred provider's undiscounted
 * short-context peak route price when the gateway metadata knows one, otherwise the entry's own
 * undiscounted catalog price. In `worstCase` mode, long-context surcharges count too.
 */
export function pickerModelPricing(
  model: OpenRouterCatalogModel,
  endpointsMetadata: GatewayModelMap,
  preferredProviderOrderConfig: PreferredProviderOrderConfig,
  vercel: VercelPricingMetadata,
  mode: PricingMode
): OpenRouterCatalogModel['pricing'] {
  const preferredProvider = resolvePreferredProviderOrder(
    preferredProviderOrderConfig,
    model.id
  ).at(0);
  const vercelModel = getVercelModelForPricing(vercel, model.id);
  const openRouterModel = endpointsMetadata[model.id];
  if (!openRouterModel && vercelModel) {
    // A model only Vercel serves is priced like its preferred provider's Vercel endpoint.
    const vercelEndpoint =
      (preferredProvider &&
        vercelModel.endpoints.find(e => isVercelEndpointOfProvider(e, preferredProvider))) ||
      vercelModel.endpoints[0];
    const vercelPricing = getEndpointPricing(vercelEndpoint?.pricing, mode);
    if (vercelPricing) return vercelPricing;
  }
  const endpoints = openRouterModel?.endpoints ?? [];
  const endpoint = !preferredProvider
    ? endpoints[0]
    : (endpoints.find(e => e.tag === preferredProvider) ??
      endpoints.find(
        e => normalizeInferenceProviderId(e.tag) === normalizeInferenceProviderId(preferredProvider)
      ));
  return (
    getProviderDisplayPricing(endpoint?.tag, endpoint?.pricing, vercelModel, mode) ??
    getEndpointPricing(model.pricing, mode) ??
    model.pricing
  );
}

/**
 * The catalog entry the picker adds for an id that the OpenRouter response
 * does not carry: one of Kilo's own Auto models.
 */
export function pickerExtraModel(modelId: string): OpenRouterCatalogModel | undefined {
  return buildAutoModels().find(model => model.id === modelId);
}

async function loadModelListInputs() {
  const [
    endpointsMetadata,
    dataCollectionRequiredModelIds,
    preferredModels,
    unavailableModelIds,
    preferredProviderOrderConfig,
    customLlmsById,
    customPricingConfig,
    vercelPricingMetadata,
    latestAliasTargets,
  ] = await Promise.all([
    getOpenRouterModelsMetadataFromDatabase(),
    getDataCollectionRequiredModelIds(),
    getPreferredModels(),
    getUnavailableModelIds(),
    getPreferredProviderOrderConfig(),
    getCustomLlmsById(),
    getCustomPricingConfig(),
    getVercelPricingMetadata(),
    getLatestAliasTargets(),
  ]);
  return {
    endpointsMetadata,
    dataCollectionRequiredModelIds,
    preferredModels,
    unavailableModelIds,
    preferredProviderOrderConfig,
    customLlmsById,
    customPricingConfig,
    vercelPricingMetadata,
    latestAliasTargets,
  };
}

type ModelListInputs = Awaited<ReturnType<typeof loadModelListInputs>>;

async function listCatalogModels(
  models: OpenRouterCatalogModel[],
  inputs: ModelListInputs,
  countryCode: string | null
) {
  const {
    endpointsMetadata,
    unavailableModelIds,
    preferredProviderOrderConfig,
    customLlmsById,
    customPricingConfig,
    vercelPricingMetadata,
    latestAliasTargets,
  } = inputs;
  const autoModels = buildAutoModels();
  const modelNamesById = new Map(models.map(model => [model.id, model.name]));
  const publicCustomLlms = [...customLlmsById.values()].filter(
    (customLlm): customLlm is CustomLlm & { definition: PublicCustomLlmDefinition } =>
      isPublicCustomLlm(customLlm.definition) &&
      !unavailableModelIds.has(customLlm.public_id.toLowerCase()) &&
      !isCustomLlmDeniedInCountry(customLlm.definition, countryCode)
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
  const isListableGatewayModelId = (modelId: string) =>
    // OpenRouter may add a model after a custom LLM claimed its id, and
    // routing serves the custom LLM.
    !customLlmsById.has(modelId.toLowerCase()) && !unavailableModelIds.has(modelId);
  const hasEndpointsMetadata = Object.keys(endpointsMetadata).length > 0;
  const listedModels = models.filter(
    model =>
      (!hasEndpointsMetadata || endpointsMetadata[model.id] !== undefined) &&
      isListableGatewayModelId(model.id) &&
      !model.id.endsWith(':batch')
  );
  const [vercelOnlyCatalogModels, summaries] = await Promise.all([
    getVercelOnlyCatalogModels({
      openRouterModels: models,
      listedOpenRouterModels: listedModels,
      openRouterMetadata: endpointsMetadata,
    }),
    getTerminalBenchSummaries(),
  ]);
  const gatewayModels = listedModels
    .map((model): OpenRouterCatalogModel => {
      const pricing = pickerModelPricing(
        model,
        endpointsMetadata,
        preferredProviderOrderConfig,
        vercelPricingMetadata,
        'shortContext'
      );
      const terminalBench = terminalBenchFor(summaries, model.id);
      const aliasTarget = model.id.startsWith('~')
        ? endpointsMetadata[model.id]?.alias_target?.slug
        : undefined;
      return {
        ...model,
        ...(aliasTarget && {
          description: `${model.description}\n\n${describeLatestAliasTarget({
            target: aliasTarget,
            stored: latestAliasTargets.get(model.id),
            namesById: modelNamesById,
            nowMs: Date.now(),
          })}`,
        }),
        pricing,
        ...(terminalBench && { terminalBench }),
        alias_target: aliasTarget,
      };
    })
    .concat(
      vercelOnlyCatalogModels
        .filter(model => isListableGatewayModelId(model.id))
        .map(model => ({
          ...model,
          pricing: pickerModelPricing(
            model,
            endpointsMetadata,
            preferredProviderOrderConfig,
            vercelPricingMetadata,
            'shortContext'
          ),
        }))
    )
    .concat(autoModels);
  // Kept beside its own entry because ids may repeat; only the alias lookup below goes by id.
  const gatewayModelsWithPricing = gatewayModels.map(model => ({
    model,
    priced: applyCustomPricingToModel(customPricingConfig, model),
  }));
  const displayPricingById = new Map(
    gatewayModelsWithPricing.map(({ priced }) => [priced.id, priced.pricing])
  );
  // An alias keeps its own name and shows the price its listed target shows. An alias whose
  // target is not listed shows its own price, replaced by its target's custom pricing as
  // billing replaces it.
  const catalogModels = gatewayModelsWithPricing
    .map(({ model, priced }): OpenRouterCatalogModel =>
      model.alias_target
        ? {
            ...model,
            pricing:
              displayPricingById.get(model.alias_target) ??
              applyCustomPricingToPricing(customPricingConfig, model.id, model.pricing),
          }
        : priced
    )
    // Public custom LLMs are complete as defined; id-based pricing, PDF, and
    // protocol guesses below would describe a model routing does not serve.
    .concat(publicCustomLlmModels);
  return { catalogModels, publicCustomLlmProviders };
}

type CatalogListing = Awaited<ReturnType<typeof listCatalogModels>>;

async function enrichCatalogModels(
  catalogModels: OpenRouterCatalogModel[],
  inputs: ModelListInputs,
  publicCustomLlmProviders: CatalogListing['publicCustomLlmProviders']
) {
  const { dataCollectionRequiredModelIds, preferredModels } = inputs;
  const providerLookupId = (model: OpenRouterCatalogModel) => model.alias_target ?? model.id;
  const indexedProviders = await getProviderSlugsForModels(catalogModels.map(providerLookupId));
  return Promise.all(
    catalogModels.map(async (model: OpenRouterCatalogModel) => {
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
        retires_on: retirementDate(model, preferredIndex),
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
}

function sortByPreferredOrder(models: OpenRouterCatalogModel[]) {
  return models.sort((a, b) => {
    // Sort by preferredIndex (undefined values last)
    if (a.preferredIndex !== undefined && b.preferredIndex === undefined) return -1;
    if (a.preferredIndex === undefined && b.preferredIndex !== undefined) return 1;

    if (a.preferredIndex !== undefined && b.preferredIndex !== undefined) {
      return a.preferredIndex - b.preferredIndex;
    }

    // If neither has preferredIndex, maintain original order
    return 0;
  });
}

async function enhancedModelList(models: OpenRouterCatalogModel[], countryCode: string | null) {
  const inputs = await loadModelListInputs();
  const { catalogModels, publicCustomLlmProviders } = await listCatalogModels(
    models,
    inputs,
    countryCode
  );
  const enhancedModels = await enrichCatalogModels(catalogModels, inputs, publicCustomLlmProviders);
  return sortByPreferredOrder(enhancedModels);
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
  { subject, endpoint }: { subject: OpenRouterCatalogueSubject; endpoint: string }
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

  const raw: unknown = await response.json();

  try {
    return parseOpenRouterCatalogue(raw, url, subject);
  } catch (error) {
    errorExceptInTest(`OpenRouter ${subject} response not in expected format:`, error);

    captureMessage(`openrouter ${subject} not in expected format!`, {
      level: 'error',
      extra: { data: removeUpstreamEnkrypt(raw), error },
    });
    throw error;
  }
}

function openRouterCatalogueHeaders(authorization: string) {
  return { Authorization: authorization, ...ATTRIBUTION_HEADERS };
}

/**
 * The transport policy of one live OpenRouter catalogue request: a GET, no cache, and the
 * catalogue timeout. Only the credential differs between the readers.
 */
function openRouterCatalogueFetchInit(authorization: string): RequestInit {
  return {
    method: 'GET',
    headers: openRouterCatalogueHeaders(authorization),
    cache: 'no-store',
    signal: AbortSignal.timeout(OPENROUTER_MODELS_FETCH_TIMEOUT_MS),
  };
}

function openRouterModelsHeaders() {
  return openRouterCatalogueHeaders(`Bearer ${OPENROUTER.apiKey}`);
}

function parseOpenRouterModels(
  sanitized: unknown,
  url: string,
  minimumCount: number
): OpenRouterModelsResponse {
  const parsed = OpenRouterModelsResponseSchema.parse(sanitized);
  assertMinimumCount(url, parsed.data.length, minimumCount);
  return parsed;
}

/**
 * The one rule that accepts an OpenRouter catalogue payload: strip the upstream-only
 * `enkrypt` field, then apply the schema and the per-subject minimum count. Both the live
 * fetch and the stored-row parser go through it.
 */
function parseOpenRouterCatalogue(
  raw: unknown,
  url: string,
  subject: OpenRouterCatalogueSubject
): OpenRouterModelsResponse {
  return parseOpenRouterModels(
    removeUpstreamEnkrypt(raw),
    url,
    OPENROUTER_CATALOGUE_MINIMUM_COUNTS[subject]
  );
}

function openRouterModelsSource(
  url: string,
  subject: OpenRouterCatalogueSubject
): MetadataSource<OpenRouterModelsResponse> {
  return {
    url,
    headers: openRouterModelsHeaders,
    parse: raw => parseOpenRouterCatalogue(raw, url, subject),
  };
}

function createOpenRouterModelsReader(
  source: MetadataSource<OpenRouterModelsResponse>,
  { subject, endpoint }: { subject: OpenRouterCatalogueSubject; endpoint: string }
) {
  return createCachedMetadataReader(source, {
    fromDb: readDb,
    ttlMs: OPENROUTER_MODELS_CACHE_TTL_MS,
    fetchFallback: () =>
      fetchOpenRouterModels(
        source.url,
        openRouterCatalogueFetchInit(`Bearer ${OPENROUTER.apiKey}`),
        { subject, endpoint }
      ),
  });
}

export const openRouterModelsMetadataSource = openRouterModelsSource(
  `${OPENROUTER.apiUrl}/models`,
  'models'
);

export const openRouterTranscriptionModelsMetadataSource = openRouterModelsSource(
  `${OPENROUTER.apiUrl}/models?output_modalities=transcription`,
  'transcription models'
);

/** The transcription catalogue's reporting identity: it picks the minimum count and tags reports. */
const TRANSCRIPTION_CATALOGUE = {
  subject: 'transcription models',
  endpoint: 'openrouter/transcription-models',
} as const satisfies { subject: OpenRouterCatalogueSubject; endpoint: string };

const openRouterModelsReader = createOpenRouterModelsReader(openRouterModelsMetadataSource, {
  subject: 'models',
  endpoint: 'openrouter/models',
});

const openRouterTranscriptionModelsReader = createOpenRouterModelsReader(
  openRouterTranscriptionModelsMetadataSource,
  TRANSCRIPTION_CATALOGUE
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
  fromDb,
}: {
  /** The requester's Vercel IP country; custom LLMs denied there are left out.
   * Null lists every custom LLM, for callers that do not serve a request. */
  countryCode: string | null;
  /** Read client for the model-stats snapshot. Gateway callers run in `sfo1` and
   * pass `readDb`; omitting it loads through the primary, which the web app needs
   * because it invalidates the snapshot right after a write. */
  fromDb?: ModelStatsLoadClient;
}): Promise<OpenRouterModelsResponse> {
  const rawResponse = await getRawOpenRouterModels();

  const models = await enhancedModelList(rawResponse.data, countryCode);
  const snapshot = await getEnkryptBenchmarks({ fromDb });
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
    openRouterCatalogueFetchInit(`Bearer ${LOCAL_FAKE_LLM_API_KEY}`),
    TRANSCRIPTION_CATALOGUE
  );
}
