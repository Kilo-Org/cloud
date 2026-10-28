import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

export type KiloExclusiveModelFlag = 'reasoning' | 'vision';

export type KiloExclusiveModel = {
  public_id: string;
  display_name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  flags: KiloExclusiveModelFlag[];
  internal_id: string;
};

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
      modality: model.flags.includes('vision') ? 'text+image->text' : 'text->text',
      input_modalities: ['text'].concat(model.flags.includes('vision') ? ['image'] : []),
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
    supported_parameters: ['max_tokens', 'temperature', 'tools'].concat(
      model.flags.includes('reasoning') ? ['reasoning', 'include_reasoning'] : []
    ),
    default_parameters: {},
    isFree: true,
    mayTrainOnYourPrompts: true,
  };
}
