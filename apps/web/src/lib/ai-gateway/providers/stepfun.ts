import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export function isStepModel(requestedModel: string) {
  return requestedModel.includes('step-');
}

export const stepfun_35_flash_free_model: KiloExclusiveModel = {
  public_id: 'stepfun/step-3.5-flash:free',
  display_name: 'StepFun: Step 3.5 Flash (free)',
  description:
    "Step 3.5 Flash is StepFun's most capable open-source foundation model. Built on a sparse Mixture of Experts (MoE) architecture, it selectively activates only 11B of its 196B parameters per token. It is a reasoning model that is incredibly speed efficient even at long contexts.",
  context_length: 262_144,
  max_completion_tokens: 262_144,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'openrouter',
  internal_id: 'stepfun/step-3.5-flash',
  pricing: null,
  exclusive_to: [],
};
