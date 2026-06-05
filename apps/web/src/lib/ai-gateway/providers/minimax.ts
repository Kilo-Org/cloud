import {
  calculateSimpleCost_mUsd,
  type KiloExclusiveModel,
} from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const MINIMAX_CURRENT_MODEL_ID = 'minimax/minimax-m3';

export const minimax_m3_discounted_model: KiloExclusiveModel = {
  public_id: MINIMAX_CURRENT_MODEL_ID + ':discounted',
  display_name: 'MiniMax: MiniMax M3 (50% off through 2026-06-07)',
  description: `MiniMax-M3 is a multimodal foundation model from MiniMax. It supports text, image, and video inputs with text output, a 1M-token context window, and is suited for long-horizon agentic work, coding, and tool use. It is built on MiniMax Sparse Attention (MSA), which replaces full attention with KV-block selection to cut per-token compute at long context — roughly 1/20 the cost of the previous generation at 1M tokens, with substantially faster prefill and decode while retaining quality across most tasks.

Trained as a native multimodal model on interleaved data and tuned for multi-turn, production-like collaboration via an interactive user-simulator framework, the model is oriented toward sustained, multi-step tasks rather than single-turn execution.`,
  context_length: 524288,
  max_completion_tokens: 512000,
  status: 'public',
  flags: ['reasoning', 'vercel-routing', 'vision'],
  gateway: 'openrouter',
  internal_id: MINIMAX_CURRENT_MODEL_ID,
  pricing: {
    prompt_per_million: 0.3,
    completion_per_million: 1.2,
    input_cache_read_per_million: 0.06,
    input_cache_write_per_million: null,
    calculate_mUsd: calculateSimpleCost_mUsd,
  },
  exclusive_to: [],
  inference_provider_restriction: [],
};

export function isMinimaxModel(model: string) {
  return model.includes('minimax');
}
