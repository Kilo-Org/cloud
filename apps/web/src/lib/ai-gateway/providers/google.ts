import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';

export function isGeminiModel(model: string) {
  return model.startsWith('google/gemini');
}

export function isGemmaModel(model: string) {
  return model.startsWith('google/gemma');
}

export const GEMMA_4_31B_IT_ID = 'google/gemma-4-31b-it';

export const gemma_4_26b_a4b_it_free_model: KiloExclusiveModel = {
  public_id: 'google/gemma-4-26b-a4b-it:free',
  display_name: 'Google: Gemma 4 26B A4B (free)',
  description:
    'Gemma 4 26B A4B IT is an instruction-tuned Mixture-of-Experts (MoE) model from Google DeepMind. Despite 25.2B total parameters, only 3.8B activate per token during inference — delivering near-31B quality at a fraction of the compute cost.',
  context_length: 262144,
  max_completion_tokens: 32768,
  status: 'hidden', // usable through kilo-auto
  flags: ['vision'],
  gateway: 'openrouter',
  internal_id: 'google/gemma-4-26b-a4b-it',
  inference_provider: 'novita',
  pricing: null,
  exclusive_to: [],
};

export function isGemini3Model(model: string) {
  return model.startsWith('google/gemini-3');
}

type ReadFileParametersSchema = {
  properties?: {
    files?: {
      items?: {
        properties?: {
          line_ranges?: {
            type?: unknown;
            items?: unknown;
            anyOf?: unknown;
          };
        };
      };
    };
  };
};

export function applyGoogleModelSettings(provider: ProviderId, requestToMutate: GatewayRequest) {
  if (provider !== 'vercel' || requestToMutate.kind !== 'chat_completions') {
    // these are workarounds for the old extension, which won't support the responses api
    return;
  }

  const readFileTool = requestToMutate.body.tools?.find(
    tool => tool.type === 'function' && tool.function.name === 'read_file'
  );
  if (!readFileTool || readFileTool.type !== 'function') {
    return;
  }

  const lineRanges = (readFileTool.function.parameters as ReadFileParametersSchema | undefined)
    ?.properties?.files?.items?.properties?.line_ranges;
  if (lineRanges?.type && lineRanges?.items) {
    lineRanges.anyOf = [{ type: 'null' }, { type: 'array', items: lineRanges.items }];
    delete lineRanges.type;
    delete lineRanges.items;
  }
}
