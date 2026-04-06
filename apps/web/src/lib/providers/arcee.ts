import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const trinity_large_thinking_free_model: KiloFreeModel = {
  public_id: 'arcee-ai/trinity-large-thinking:free',
  display_name: 'Arcee AI: Trinity Large Thinking (free)',
  description:
    "A powerful open source reasoning model from Arcee AI. Strong performance in multi-turn tool use, context coherence, and instruction following across long-horizon agent runs in tools like OpenClaw and KiloClaw. **Note:** For the free endpoint, all prompts and output are logged to improve the provider's model and its product and services. Please do not upload any personal, confidential, or otherwise sensitive information.",
  context_length: 262_144,
  max_completion_tokens: 262_144,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'openrouter',
  internal_id: 'arcee-ai/trinity-large-thinking',
  inference_provider: 'arcee-ai',
};
