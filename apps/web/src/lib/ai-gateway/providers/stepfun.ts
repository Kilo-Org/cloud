import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isStepModel(requestedModel: string) {
  return requestedModel.includes('step-');
}

export const stepfun_37_flash_free_model: KiloExclusiveModel = {
  public_id: 'stepfun/step-3.7-flash:free',
  display_name: 'StepFun: Step 3.7 Flash (free)',
  description:
    "Step 3.7 Flash is StepFun's latest high-efficiency multimodal Mixture-of-Experts model. It pairs a 196B-parameter language backbone with a vision encoder for native image and video understanding, activating roughly 11B parameters per token. The model supports a 256K context window and exposes selectable reasoning levels (high/medium/low), letting callers trade off speed, cost, and depth of reasoning.\n\nDesigned for coding, agentic workflows, structured outputs, and long-context productivity tasks.",
  context_length: 262_144,
  max_completion_tokens: 262_144,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'openrouter',
  internal_id: 'stepfun/step-3.7-flash',
  pricing: null,
  exclusive_to: [],
  inference_provider_restriction: ['stepfun'],
};
