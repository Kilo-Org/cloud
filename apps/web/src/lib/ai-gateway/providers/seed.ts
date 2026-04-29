import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const seed_20_code_free_model: KiloExclusiveModel = {
  public_id: 'bytedance-seed/dola-seed-2.0-code:free',
  display_name: 'ByteDance Seed: Dola Seed 2.0 Code (free)',
  description:
    "Dola-Seed-2.0-Code is optimized for enterprise-grade coding scenarios. Building on the strong agentic and VLM capabilities of Seed 2.0, it further strengthens code generation and software engineering performance. It delivers particularly strong front-end results and is also specifically optimized for the multilingual coding needs commonly found in enterprise environments, making it well suited for integration with a wide range of AI coding tools. **Note:** For the free endpoint, all prompts and output are logged to improve the provider's model and its product and services. Please do not upload any personal, confidential, or otherwise sensitive information.",
  context_length: 256_000,
  max_completion_tokens: 128_000,
  status: 'disabled',
  flags: ['reasoning', 'vision'],
  gateway: 'seed',
  internal_id: 'seed-2-0-code-preview-260328',
  pricing: null,
  exclusive_to: [],
};
