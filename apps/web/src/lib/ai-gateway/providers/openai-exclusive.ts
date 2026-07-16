import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const gpt_5_6_sol_stealth_model: KiloExclusiveModel = {
  public_id: 'stealth/gpt-5.6-sol',
  internal_id: 'openai/gpt-5.6-sol:optimized',
  display_name: 'Stealth: GPT-5.6 Sol (20% off)',
  description:
    "Your prompts and completions may be retained and used to train or improve the provider's services. This third-party-served variant of GPT-5.6 Sol is offered at 20% lower cost than standard GPT-5.6 Sol pricing and is not served by OpenAI or Kilo Code.",
  status: 'public',
  context_length: 1_050_000,
  max_completion_tokens: 128_000,
  gateway: 'martian',
  flags: ['reasoning', 'vision', 'stealth', 'requires-data-collection'],
  pricing: [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 4,
        completion_per_million: 24,
        input_cache_read_per_million: 0.4,
        input_cache_write_per_million: 5,
      },
    },
    {
      start_context_length: 272_000,
      pricing: {
        prompt_per_million: 8,
        completion_per_million: 36,
        input_cache_read_per_million: 0.8,
        input_cache_write_per_million: 10,
      },
    },
  ],
  inference_provider_restriction: [],
};
