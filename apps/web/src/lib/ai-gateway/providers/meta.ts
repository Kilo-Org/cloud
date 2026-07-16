import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const muse_spark_1_1_model: KiloExclusiveModel = {
  public_id: 'meta/muse-spark-1.1',
  internal_id: 'meta/muse-spark-1.1',
  display_name: 'Meta: Muse Spark 1.1',
  description:
    'Muse Spark 1.1 is strongest at agentic performance, tool use, and computer use. It does well on long-running tasks with a 1M-token context window and can delegate execution to sub-agents running in parallel.',
  status: 'public',
  context_length: 1_048_576,
  max_completion_tokens: 1_048_576,
  gateway: 'vercel',
  flags: ['reasoning', 'vision'],
  pricing: [
    {
      start_context_length: 0,
      pricing: {
        prompt_per_million: 1.25,
        completion_per_million: 4.25,
        input_cache_read_per_million: 0.15,
        input_cache_write_per_million: null,
      },
    },
  ],
  inference_provider_restriction: [],
};
