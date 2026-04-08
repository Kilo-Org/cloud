import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const qwen36_plus_free_model: KiloFreeModel = {
  public_id: 'qwen/qwen3.6-plus:free',
  display_name: 'Qwen: Qwen3.6 Plus (free)',
  description:
    'The Qwen3.6 native vision-language Plus series models demonstrate exceptional performance on par with the current state-of-the-art models, with a significant improvement in overall results compared to the 3.5 series. The models have been markedly enhanced in code-related capabilities such as agentic coding, front-end programming, and Vibe coding, as well as in multi-modal general object recognition, OCR, and object localization.',
  context_length: 1000000,
  max_completion_tokens: 65536,
  status: 'disabled',
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'alibaba',
  internal_id: 'qwen3.6-plus',
  inference_provider: 'alibaba',
};
