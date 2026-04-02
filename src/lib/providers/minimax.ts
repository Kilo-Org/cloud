import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';

export const minimax_m25_free_model: KiloFreeModel = {
  public_id: 'minimax/minimax-m2.5:free',
  display_name: 'MiniMax: MiniMax M2.5 (free)',
  description:
    'MiniMax-M2.5 is a SOTA large language model designed for real-world productivity. Trained in a diverse range of complex real-world digital working environments, M2.5 builds upon the coding expertise of M2.1 to extend into general office work, reaching fluency in generating and operating Word, Excel, and Powerpoint files, context switching between diverse software environments, and working across different agent and human teams. Scoring 80.2% on SWE-Bench Verified, 51.3% on Multi-SWE-Bench, and 76.3% on BrowseComp, M2.5 is also more token efficient than previous generations, having been trained to optimize its actions and output through planning.',
  context_length: 204800,
  max_completion_tokens: 131072,
  status: 'hidden', // usable through kilo-auto/free
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'minimax/minimax-m2.5',
  inference_provider: null,
};

export function isMinimaxModel(model: string) {
  return model.startsWith('minimax/');
}

export const MINIMAX_CURRENT_MODEL_ID = 'minimax/minimax-m2.7';

export const MINIMAX_CURRENT_MODEL_NAME = 'MiniMax M2.7';
