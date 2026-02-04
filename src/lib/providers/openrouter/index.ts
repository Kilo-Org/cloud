import { isFreeModel, kiloFreeModels, preferredModels } from '@/lib/models';
import { PROVIDERS } from '@/lib/providers';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';
import {
  OpenRouterModelsResponseSchema,
  type OpenRouterModelsResponse,
} from '@/lib/organizations/organization-types';
import { errorExceptInTest } from '@/lib/utils.server';
import { captureException, captureMessage } from '@sentry/nextjs';
import { convertFromKiloModel } from '@/lib/providers/kilo-free-model';
import { getModelSettings, getVersionedModelSettings } from '@/lib/providers/recommended-models';
import {
  KILO_AUTO_MODEL_COMPLETION_PRICE,
  KILO_AUTO_MODEL_CONTEXT_LENGTH,
  KILO_AUTO_MODEL_DESCRIPTION,
  KILO_AUTO_MODEL_ID,
  KILO_AUTO_MODEL_MAX_COMPLETION_TOKENS,
  KILO_AUTO_MODEL_NAME,
  KILO_AUTO_MODEL_PROMPT_PRICE,
} from '@/lib/kilo-auto-model';

// Re-export from shared module for backwards compatibility
export { normalizeModelId } from '@/lib/model-utils';

export function isRateLimitedToDeathFree(model: string) {
  return model.endsWith(':free') && !isFreeModel(model);
}

function buildAutoModel(): OpenRouterModel {
  return {
    id: KILO_AUTO_MODEL_ID,
    name: KILO_AUTO_MODEL_NAME,
    created: 0,
    description: KILO_AUTO_MODEL_DESCRIPTION,
    architecture: {
      input_modalities: ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
    },
    top_provider: {
      is_moderated: false,
      context_length: KILO_AUTO_MODEL_CONTEXT_LENGTH,
      max_completion_tokens: KILO_AUTO_MODEL_MAX_COMPLETION_TOKENS,
    },
    pricing: {
      prompt: KILO_AUTO_MODEL_PROMPT_PRICE,
      completion: KILO_AUTO_MODEL_COMPLETION_PRICE,
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
    },
    context_length: KILO_AUTO_MODEL_CONTEXT_LENGTH,
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
  };
}

function enhancedModelList(models: OpenRouterModel[]) {
  const autoModel = buildAutoModel();
  const enhancedModels = models
    .filter(
      (model: OpenRouterModel) =>
        !isRateLimitedToDeathFree(model.id) &&
        !kiloFreeModels.some(m => m.public_id === model.id && m.is_enabled)
    )
    .concat(kiloFreeModels.filter(m => m.is_enabled).map(model => convertFromKiloModel(model)))
    .concat([autoModel])
    .map((model: OpenRouterModel) => {
      const preferredIndex =
        model.id === KILO_AUTO_MODEL_ID ? -1 : preferredModels.indexOf(model.id);
      const ageDays = (Date.now() / 1_000 - model.created) / (24 * 3600);
      const isNew = preferredIndex >= 0 && ageDays >= 0 && ageDays < 7;
      return {
        ...model,
        name: isNew ? model.name + ' (new)' : model.name,
        preferredIndex:
          preferredIndex >= 0 || model.id === KILO_AUTO_MODEL_ID ? preferredIndex : undefined,
        settings: getModelSettings(model.id),
        versioned_settings: getVersionedModelSettings(model.id),
      };
    });
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
      'HTTP-Referer': 'https://kilocode.ai',
      'X-Title': 'Kilo Code',
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

  return { data: enhancedModelList(rawResponse.data) };
}
