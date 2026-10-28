import 'server-only';

import {
  GEMMA_4_26B_A4B_IT_ID,
  GEMMA_4_26B_A4B_IT_FREE_ID,
} from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

/**
 * A free model Kilo lists under its own id and serves as `internal_id` through
 * OpenRouter, or the Vercel AI Gateway when routing selects it.
 */
export type KiloExclusiveModel = {
  public_id: string;
  internal_id: string;
  display_name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  vision: boolean;
};

export const gemma_4_26b_a4b_it_free_model: KiloExclusiveModel = {
  public_id: GEMMA_4_26B_A4B_IT_FREE_ID,
  internal_id: GEMMA_4_26B_A4B_IT_ID,
  display_name: 'Google: Gemma 4 26B A4B (free)',
  description:
    'Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference — delivering near-31B quality at a fraction of the compute cost.',
  context_length: 262144,
  max_completion_tokens: 32768,
  vision: true,
};

export const kiloExclusiveModels: KiloExclusiveModel[] = [gemma_4_26b_a4b_it_free_model];

export function findKiloExclusiveModel(model: string): KiloExclusiveModel | null {
  return kiloExclusiveModels.find(m => m.public_id === model) ?? null;
}

export function isKiloExclusiveModel(model: string): boolean {
  return findKiloExclusiveModel(model) !== null;
}

type TokenLimitMutation = 'removed' | 'clamped';

function logMaxTokenMutation(
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel,
  field: 'max_completion_tokens' | 'max_tokens' | 'max_output_tokens',
  requestedValue: number,
  mutation: TokenLimitMutation
) {
  console.warn('[removeNonSensicalMaxTokens] mutated request with token limit above model cap', {
    model: kiloExclusiveModel.public_id,
    requestKind: requestToMutate.kind,
    field,
    requestedValue,
    modelMaxCompletionTokens: kiloExclusiveModel.max_completion_tokens,
    mutation,
  });
}

function removeNonSensicalMaxTokens(
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel
) {
  // OpenClaw sometimes puts numbers in that are too large and some providers will reject the request.
  if (requestToMutate.kind === 'chat_completions') {
    const maxCompletionTokens = requestToMutate.body.max_completion_tokens;
    if (
      maxCompletionTokens !== undefined &&
      maxCompletionTokens !== null &&
      maxCompletionTokens > kiloExclusiveModel.max_completion_tokens
    ) {
      logMaxTokenMutation(
        requestToMutate,
        kiloExclusiveModel,
        'max_completion_tokens',
        maxCompletionTokens,
        'removed'
      );
      delete requestToMutate.body.max_completion_tokens;
    }

    const maxTokens = requestToMutate.body.max_tokens;
    if (maxTokens !== undefined && maxTokens > kiloExclusiveModel.max_completion_tokens) {
      logMaxTokenMutation(requestToMutate, kiloExclusiveModel, 'max_tokens', maxTokens, 'removed');
      delete requestToMutate.body.max_tokens;
    }
  }
  if (requestToMutate.kind === 'responses') {
    const maxOutputTokens = requestToMutate.body.max_output_tokens;
    if (
      maxOutputTokens !== undefined &&
      maxOutputTokens !== null &&
      maxOutputTokens > kiloExclusiveModel.max_completion_tokens
    ) {
      logMaxTokenMutation(
        requestToMutate,
        kiloExclusiveModel,
        'max_output_tokens',
        maxOutputTokens,
        'removed'
      );
      delete requestToMutate.body.max_output_tokens;
    }
  }
  if (requestToMutate.kind === 'messages') {
    const maxTokens = requestToMutate.body.max_tokens;
    if (maxTokens !== undefined && maxTokens > kiloExclusiveModel.max_completion_tokens) {
      logMaxTokenMutation(requestToMutate, kiloExclusiveModel, 'max_tokens', maxTokens, 'clamped');
      requestToMutate.body.max_tokens = kiloExclusiveModel.max_completion_tokens;
    }
  }
}

/** Rewrites a gateway request to target a Kilo-exclusive model. */
export function applyKiloExclusiveModelSettings(
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel
) {
  requestToMutate.body.model = kiloExclusiveModel.internal_id;
  removeNonSensicalMaxTokens(requestToMutate, kiloExclusiveModel);
}

const FREE_PRICE_PER_TOKEN = '0.000000000000';

export function convertFromKiloExclusiveModel(model: KiloExclusiveModel) {
  return {
    id: model.public_id,
    canonical_slug: model.public_id,
    hugging_face_id: '',
    name: model.display_name,
    created: 1756238927,
    description: model.description,
    context_length: model.context_length,
    architecture: {
      modality: model.vision ? 'text+image->text' : 'text->text',
      input_modalities: model.vision ? ['text', 'image'] : ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: FREE_PRICE_PER_TOKEN,
      completion: FREE_PRICE_PER_TOKEN,
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: FREE_PRICE_PER_TOKEN,
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools'],
    default_parameters: {},
    isFree: true,
    mayTrainOnYourPrompts: true,
  };
}
