import type { KiloExclusiveModel } from '@/lib/providers/kilo-exclusive-model';

export const corethink_free_model: KiloExclusiveModel = {
  public_id: 'corethink:free',
  display_name: 'CoreThink (free)',
  description:
    'CoreThink - AI that reasons through problems instead of guessing. Available free of charge in Kilo for a limited time.',
  context_length: 78_000,
  max_completion_tokens: 8192,
  status: 'public',
  flags: ['free'],
  gateway: 'corethink',
  internal_id: 'corethink',
  inference_provider: 'corethink',
};
