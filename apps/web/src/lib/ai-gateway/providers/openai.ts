import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isOpenAiModel(requestedModel: string) {
  return requestedModel.startsWith('openai/') && !requestedModel.startsWith('openai/gpt-oss');
}

export function isOpenAiOssModel(requestedModel: string) {
  return requestedModel.startsWith('openai/gpt-oss');
}

export const GPT_5_NANO_ID = 'openai/gpt-5-nano';

export const GPT_5_NANO_NAME = 'GPT-5 Nano';

export const gpt_oss_20b_free_model: KiloExclusiveModel = {
  public_id: 'openai/gpt-oss-20b:free',
  display_name: 'OpenAI: gpt-oss-20b (free)',
  description:
    "gpt-oss-20b is an open-weight 21B parameter model released by OpenAI under the Apache 2.0 license. It uses a Mixture-of-Experts (MoE) architecture with 3.6B active parameters per forward pass, optimized for lower-latency inference and deployability on consumer or single-GPU hardware. The model is trained in OpenAI's Harmony response format and supports reasoning level configuration, fine-tuning, and agentic capabilities including function calling, tool use, and structured outputs.",
  context_length: 131072,
  max_completion_tokens: 32768,
  status: 'hidden', // usable through kilo-auto
  flags: ['reasoning'],
  gateway: 'openrouter',
  internal_id: 'openai/gpt-oss-20b',
  inference_provider: null,
  pricing: null,
  exclusive_to: [],
};
