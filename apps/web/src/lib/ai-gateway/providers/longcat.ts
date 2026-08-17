import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isLongCatModel(requestedModel: string) {
  return requestedModel.includes('longcat');
}

export const longcat_2_free_model: KiloExclusiveModel = {
  public_id: 'meituan/longcat-2.0-free',
  display_name: 'Meituan: LongCat 2.0 (free)',
  description:
    'LongCat 2.0 is a sparse mixture-of-experts language model from Meituan, with 48B active parameters out of 1.6T total. It is suited for coding, repository-level changes, long-horizon problem solving, and agentic workflows. Available free in Kilo for a limited time.',
  context_length: 1_048_756,
  max_completion_tokens: 131_072,
  status: 'disabled',
  flags: ['reasoning'],
  gateway: 'longcat',
  internal_id: 'LongCat-2.0',
  pricing: null,
  inference_provider_restriction: [],
};
