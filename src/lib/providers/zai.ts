import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const zai_glm5_free_model = {
  public_id: 'z-ai/glm-5:free',
  display_name: 'Z.ai: GLM 5 (free)',
  description:
    'GLM-5 is Z.ai’s flagship open-source foundation model engineered for complex systems design and long-horizon agent workflows. Built for expert developers, it delivers production-grade performance on large-scale programming tasks, rivaling leading closed-source models. With advanced agentic planning, deep backend reasoning, and iterative self-correction, GLM-5 moves beyond code generation to full-system construction and autonomous execution.',
  context_length: 202800,
  max_completion_tokens: 131072,
  is_enabled: false,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'z-ai/glm-5',
  inference_providers: [],
} satisfies KiloFreeModel;
