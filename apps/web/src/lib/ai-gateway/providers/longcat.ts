import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isLongCatModel(requestedModel: string) {
  return requestedModel.startsWith('meituan/longcat-');
}

export const longcat_2_free_model: KiloExclusiveModel = {
  public_id: 'meituan/longcat-2.0-free',
  display_name: 'Meituan: LongCat 2.0 (free)',
  description:
    "LongCat 2.0 is Meituan's long-context reasoning model for coding, agentic workflows, and complex problem solving.",
  context_length: 1_048_756,
  max_completion_tokens: 131_072,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'longcat',
  internal_id: 'LongCat-2.0',
  pricing: null,
  inference_provider_restriction: [],
};
