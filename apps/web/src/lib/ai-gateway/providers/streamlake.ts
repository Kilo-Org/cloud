import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const kat_coder_pro_v2_5_free_model: KiloExclusiveModel = {
  public_id: 'kwaipilot/kat-coder-pro-v2.5:free',
  display_name: 'KwaiPilot: KAT-Coder-Pro V2.5 (free)',
  description:
    'KAT-Coder-Pro V2.5 is a reasoning model optimized for coding and software engineering tasks.',
  context_length: 256_000,
  max_completion_tokens: 80_000,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'streamlake',
  internal_id: 'ep-fsp5wc-1783487206835267047',
  pricing: null,
  exclusive_to: [],
  inference_provider_restriction: [],
};
