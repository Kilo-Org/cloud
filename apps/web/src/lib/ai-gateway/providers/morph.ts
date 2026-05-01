import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const morph_warp_grep_free_model: KiloExclusiveModel = {
  public_id: 'morph-warp-grep-v2',
  display_name: 'Morph: WarpGrep V2',
  description:
    'A code search subagent that finds relevant code in a separate context window — no embeddings, no indexing.',
  context_length: 256000,
  max_completion_tokens: 32000,
  status: 'hidden',
  flags: [],
  gateway: 'morph',
  internal_id: 'morph-warp-grep-v2',
  pricing: null,
  exclusive_to: [],
};
