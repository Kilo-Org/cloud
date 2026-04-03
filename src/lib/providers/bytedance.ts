import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const seed_20_pro_free_model: KiloFreeModel = {
  public_id: 'bytedance-seed/dola-seed-2.0-pro:free',
  display_name: 'ByteDance Seed: Dola Seed 2.0 Pro (free)',
  description:
    "Built for the Agent era, it delivers stable performance in complex reasoning and long-horizon tasks, including multi-step planning, visual-text reasoning, video understanding, and advanced analysis. **Note:** For the free endpoint, all prompts and output are logged to improve the provider's model and its product and services. Please do not upload any personal, confidential, or otherwise sensitive information.",
  context_length: 256_000,
  max_completion_tokens: 128_000,
  status: 'public',
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'bytedance',
  internal_id: 'seed-2-0-pro-260328',
  inference_provider: 'seed',
};
