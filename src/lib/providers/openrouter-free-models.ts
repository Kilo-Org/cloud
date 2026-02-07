import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const pony_alpha_free_model = {
  public_id: 'openrouter/pony-alpha',
  display_name: 'Pony Alpha (free)',
  description:
    'Pony Alpha is a stealth model optimized for speed and enhanced reasoning capabilities. ' +
    'It is provided free of charge in Kilo Code for a limited time.\n' +
    '**Note:** Prompts and completions are logged and may be used to improve the model.',
  context_length: 200_000,
  max_completion_tokens: 32_000,
  is_enabled: true,
  flags: ['reasoning'],
  gateway: 'openrouter',
  internal_id: 'openrouter/pony-alpha',
  inference_providers: ['stealth'],
} as KiloFreeModel;
