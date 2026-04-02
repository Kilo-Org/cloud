import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const qwen35_plus_free_model: KiloFreeModel = {
  public_id: 'qwen/qwen3.5-plus:free',
  display_name: 'Qwen: Qwen3.5 Plus (free)',
  description:
    'The Qwen3.5 native vision-language series Plus models are built on a hybrid architecture that integrates linear attention mechanisms with sparse mixture-of-experts models, achieving higher inference efficiency. In a variety of task evaluations, the 3.5 series consistently demonstrates performance on par with state-of-the-art leading models. Compared to the 3 series, these models show a leap forward in both pure-text and multimodal capabilities.',
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'disabled',
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.5-plus',
  inference_provider: 'alibaba',
};

export const QWEN36_PLUS_FREE_MODEL_ID = 'qwen/qwen3.6-plus:free';

export const QWEN36_PLUS_FREE_MODEL_NAME = 'Qwen: Qwen3.6 Plus (free)';
