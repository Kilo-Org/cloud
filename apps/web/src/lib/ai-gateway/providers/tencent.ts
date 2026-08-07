import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const tencent_hy3_free_model: KiloExclusiveModel = {
  public_id: 'tencent/hy3:free',
  display_name: 'Tencent: Hy3 (free)',
  description:
    'Hy3 is a 295B-parameter Mixture-of-Experts model from Tencent, activating 21B parameters per token. It supports configurable reasoning effort, agentic workflows, reliable tool calling, and long-context tasks across coding, document processing, financial analysis, and frontend development.',
  context_length: 262_144,
  max_completion_tokens: 128_000,
  status: 'public',
  flags: ['reasoning', 'vercel-routing'],
  gateway: 'openrouter',
  internal_id: 'tencent/hy3',
  pricing: null,
  inference_provider_restriction: ['tencent'],
};

export function isTencentFreeModel(model: string): boolean {
  return model === tencent_hy3_free_model.public_id || model === tencent_hy3_free_model.internal_id;
}
