import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';

export const MINIMAX_CURRENT_MODEL_ID = 'minimax/minimax-m3';

export const minimax_m3_free_model: KiloExclusiveModel = {
  public_id: 'minimax/minimax-m3:free',
  display_name: 'MiniMax: MiniMax M3 (free)',
  description:
    'MiniMax-M3 is a frontier-class foundation model that combines a 1M-token context window, coding and agentic performance, and native multimodality. Available free through OpenRouter via GMI Cloud.',
  context_length: 1_048_576,
  max_completion_tokens: 1_048_576,
  status: 'public',
  flags: ['reasoning', 'vision'],
  gateway: 'openrouter',
  internal_id: 'minimax/minimax-m3:free',
  pricing: null,
  inference_provider_restriction: [],
};

export const minimax_m27_free_model: KiloExclusiveModel = {
  public_id: 'minimax/minimax-m2.7:free',
  display_name: 'MiniMax: MiniMax M2.7 (free)',
  description:
    'MiniMax M2.7 is designed for real-world software engineering, including full-project delivery, log analysis and debugging, code security, and machine learning. Available free through Vercel AI Gateway via GMI Cloud until September 6, 2026.',
  context_length: 196_608,
  max_completion_tokens: 196_608,
  status: 'public',
  flags: ['reasoning'],
  gateway: 'vercel',
  internal_id: 'minimax/minimax-m2.7-free',
  pricing: null,
  inference_provider_restriction: ['gmicloud'],
};

export function isMinimaxModel(model: string) {
  return model.includes('minimax');
}
