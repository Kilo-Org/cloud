import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const kat_coder_pro_v2_5_free_model: KiloExclusiveModel = {
  public_id: 'kwaipilot/kat-coder-pro-v2.5:free',
  display_name: 'Kwaipilot: KAT-Coder-Pro V2.5 (free)',
  description:
    'KAT-Coder-Pro V2.5 is a flagship-level Agentic Coding model that can directly hand over an entire issue or an entire business workflow to it, allowing it to autonomously locate and make modifications, and complete the entire process in the actual repository. At the same time, it seamlessly integrates multiple experts to fully retain the front-end aesthetic generation capability of V2.',
  context_length: 256_000,
  max_completion_tokens: 80_000,
  status: 'disabled',
  flags: ['reasoning'],
  gateway: 'streamlake',
  internal_id: 'ep-fsp5wc-1783487206835267047',
  pricing: null,
  exclusive_to: [],
  inference_provider_restriction: [],
};
