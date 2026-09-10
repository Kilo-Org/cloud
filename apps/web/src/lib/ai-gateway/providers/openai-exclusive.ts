import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const gpt_5_6_sol_discounted_model: KiloExclusiveModel = {
  public_id: 'openai/gpt-5.6-sol-discounted',
  internal_id: 'openai/gpt-5.6-sol',
  display_name: 'OpenAI: GPT-5.6 Sol (50% off)',
  description:
    'GPT-5.6 Sol served by OpenAI through Vercel AI Gateway at 50% lower cost than other available inference providers. This promotion runs through September 18, 2026.',
  status: 'public',
  context_length: 1_050_000,
  max_completion_tokens: 128_000,
  gateway: 'vercel',
  flags: ['reasoning', 'vision'],
  pricing: {
    tiers: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 2,
          completion_per_million: 10,
          input_cache_read_per_million: 0.2,
          input_cache_write_per_million: 2.5,
        },
      },
      {
        start_context_length: 272_000,
        pricing: {
          prompt_per_million: 4,
          completion_per_million: 15,
          input_cache_read_per_million: 0.4,
          input_cache_write_per_million: 5,
        },
      },
    ],
  },
  inference_provider_restriction: ['openai'],
};

export const gpt_6_astra_flex_model: KiloExclusiveModel = {
  public_id: 'openai/gpt-6-astra-flex',
  internal_id: 'openai/gpt-6-astra',
  display_name: 'OpenAI: GPT-6 Astra Flex',
  description:
    'GPT-6 Astra with OpenAI Flex processing, offering lower costs in exchange for slower response times and occasional resource unavailability.',
  status: 'disabled',
  context_length: 1_050_000,
  max_completion_tokens: 128_000,
  gateway: 'vercel',
  flags: ['reasoning', 'vision', 'flex'],
  pricing: {
    fallbackOnly: true,
    tiers: [
      {
        start_context_length: 0,
        pricing: {
          prompt_per_million: 5,
          completion_per_million: 25,
          input_cache_read_per_million: 0.5,
          input_cache_write_per_million: 6.25,
        },
      },
      {
        start_context_length: 272_000,
        pricing: {
          prompt_per_million: 10,
          completion_per_million: 37.5,
          input_cache_read_per_million: 1,
          input_cache_write_per_million: 12.5,
        },
      },
    ],
  },
  inference_provider_restriction: ['openai'],
};
