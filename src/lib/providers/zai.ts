import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const zai_glm47_free_model = {
  public_id: 'z-ai/glm-4.7:free',
  display_name: 'Z.AI: GLM 4.7 (free)',
  description:
    "GLM-4.7 is Z.AI's latest flagship model, featuring upgrades in two key areas: enhanced programming capabilities and more stable multi-step reasoning/execution. It demonstrates significant improvements in executing complex agent tasks while delivering more natural conversational experiences and superior front-end aesthetics.",
  context_length: 202752,
  max_completion_tokens: 65535,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'z-ai/glm-4.7',
  inference_providers: ['novita'],
} as KiloFreeModel;
