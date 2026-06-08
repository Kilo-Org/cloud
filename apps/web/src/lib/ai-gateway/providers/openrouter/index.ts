import {
  isPdfSupportingModel,
  kiloExclusiveModels,
  preferredModels,
} from '@/lib/ai-gateway/models';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import PROVIDERS from '@/lib/ai-gateway/providers/provider-definitions';
import type { StoredModel } from '@kilocode/db';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import { errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import {
  convertFromKiloExclusiveModel,
  type KiloExclusiveModel,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { isForbiddenFreeModel } from '@/lib/ai-gateway/forbidden-free-models';
import { getOpenCodeSettings } from '@/lib/ai-gateway/providers/model-settings';
import { AUTO_MODELS } from '@/lib/ai-gateway/auto-model';
import { ATTRIBUTION_HEADERS } from '@/lib/ai-gateway/providers/openrouter/attribution-headers';
import { getOpenRouterModelsMetadata } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { getPreferredProviderOrder } from '@/lib/ai-gateway/providers/apply-provider-specific-logic';
import { normalizeInferenceProviderId } from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { isFreeNemotronModel, NVIDIA_TRIAL_TOS } from '@/lib/ai-gateway/providers/nvidia';

// Re-export from shared module for backwards compatibility
export { normalizeModelId } from '@/lib/ai-gateway/model-utils';

function buildAutoModels(): OpenRouterModel[] {
  return AUTO_MODELS.map(m => {
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
        prompt: m.prompt_price,
        completion: m.completion_price,
        input_cache_read: m.input_cache_read_price,
        input_cache_write: m.input_cache_write_price,
        request: '0',
        image: '0',
        web_search: '0',
        internal_reasoning: '0',
      },
      context_length: m.context_length,
      supported_parameters: [
        'max_tokens',
        'temperature',
        'tools',
        'reasoning',
        'include_reasoning',
      ],
      opencode: m.opencode_settings,
    };
  });
}

export function formatName(model: OpenRouterModel, preferredIndex: number) {
  const promptPrice = Number.parseFloat(model.pricing.prompt);
  const isExpensive = Number.isFinite(promptPrice) && promptPrice >= 0.00001; // Opus 4.8 Fast price
  if (isExpensive) return model.name + ' ($$$$)';
  if (model.name.endsWith(')')) return model.name;
  const ageDays = (Date.now() / 1_000 - model.created) / (24 * 3600);
  const isNew = preferredIndex >= 0 && ageDays >= 0 && ageDays < 7;
  if (isNew) return model.name + ' (new)';
  if (model.expiration_date) {
    const suffix = new Date(model.expiration_date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    });
    return model.name + ' (retires ' + suffix + ')';
  }
  return model.name;
}

type EndpointPricing = NonNullable<StoredModel['endpoints'][number]['pricing']>;

export function undoPricingDiscount(pricing: EndpointPricing): EndpointPricing {
  const { discount, ...prices } = pricing;
  if (discount === undefined || discount <= 0) return pricing;
  const factor = 1 - discount;
  if (factor <= 0) return prices;
  const result = { ...prices };
  for (const key of Object.keys(prices) as (keyof typeof prices)[]) {
    const value = prices[key];
    if (value !== undefined) {
      result[key] = (Number.parseFloat(value) / factor).toFixed(12);
    }
  }
  return result;
}

export function shouldSuppressOpenRouterModel(model: KiloExclusiveModel): boolean {
  return model.status !== 'disabled' || model.pricing === null;
}

async function enhancedModelList(models: OpenRouterModel[]) {
  const autoModels = buildAutoModels();
  const endpointsMetadata = await getOpenRouterModelsMetadata();
  const enhancedModels = await Promise.all(
    models
      .filter(
        (model: OpenRouterModel) =>
          !kiloExclusiveModels.some(
            m => m.public_id === model.id && shouldSuppressOpenRouterModel(m)
          ) && !isForbiddenFreeModel(model.id)
      )
      .map(model => {
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
        const pricing = rawPricing ? undoPricingDiscount(rawPricing) : rawPricing;
        return pricing ? { ...model, pricing } : model;
      })
      .concat(
        kiloExclusiveModels
          .filter(m => m.status === 'public')
          .map(model => convertFromKiloExclusiveModel(model))
      )
      .concat(autoModels)
      .map(async (model: OpenRouterModel) => {
        const preferredIndex = preferredModels.indexOf(model.id);
        const addPdf =
          isPdfSupportingModel(model.id) && !model.architecture.input_modalities.includes('pdf');
        const description = isFreeNemotronModel(model.id)
          ? model.description + '\n\n**Terms of service** ' + NVIDIA_TRIAL_TOS
          : model.description;
        return {
          ...model,
          name: formatName(model, preferredIndex),
          description,
          preferredIndex: preferredIndex >= 0 ? preferredIndex : undefined,
          isFree: await isFreeModel(model.id),
          opencode: model.opencode ?? getOpenCodeSettings(model.id),
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

/**
 * Fetch raw, unfiltered models from OpenRouter API
 * Use this for syncing model stats where you need complete data including :free variants
 */
export async function getRawOpenRouterModels(): Promise<OpenRouterModelsResponse> {
  const response = await fetch(`${PROVIDERS.OPENROUTER.apiUrl}/models`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${PROVIDERS.OPENROUTER.apiKey}`,
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

  const data = await response.json();

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

  return { data: await enhancedModelList(rawResponse.data) };
}
/**
 * Fetch speech-to-text models from the OpenRouter API.
 */
export async function getOpenRouterTranscriptionModels(): Promise<OpenRouterModelsResponse> {
  const response = await fetch(
    `${PROVIDERS.OPENROUTER.apiUrl}/models?output_modalities=transcription`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${PROVIDERS.OPENROUTER.apiKey}`,
        ...ATTRIBUTION_HEADERS,
      },
      next: { revalidate: 60 },
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

  const data = await response.json();

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
