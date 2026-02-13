import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

export const minimax_m21_free_model = {
  public_id: 'minimax/minimax-m2.1:free',
  display_name: '[DEPRECATED, upgrade to M2.5] MiniMax M2.1 (free)',
  description:
    'MiniMax-M2.1 is a lightweight, state-of-the-art large language model optimized for coding, agentic workflows, and modern application development. With only 10 billion activated parameters, it delivers a major jump in real-world capability while maintaining exceptional latency, scalability, and cost efficiency.\n\nCompared to its predecessor, M2.1 delivers cleaner, more concise outputs and faster perceived response times. It shows leading multilingual coding performance across major systems and application languages, achieving 49.4% on Multi-SWE-Bench and 72.5% on SWE-Bench Multilingual, and serves as a versatile agent “brain” for IDEs, coding tools, and general-purpose assistance.',
  context_length: 204800,
  max_completion_tokens: 131072,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'minimax/minimax-m2.1',
  inference_providers: ['minimax'],
} as KiloFreeModel;

export const minimax_m25_free_model = {
  public_id: 'minimax/minimax-m2.5:free',
  display_name: 'MiniMax: MiniMax M2.5 (free)',
  description:
    'MiniMax-M2.5 is a SOTA large language model designed for real-world productivity. Trained in a diverse range of complex real-world digital working environments, M2.5 builds upon the coding expertise of M2.1 to extend into general office work, reaching fluency in generating and operating Word, Excel, and Powerpoint files, context switching between diverse software environments, and working across different agent and human teams. Scoring 80.2% on SWE-Bench Verified, 51.3% on Multi-SWE-Bench, and 76.3% on BrowseComp, M2.5 is also more token efficient than previous generations, having been trained to optimize its actions and output through planning.',
  context_length: 204800,
  max_completion_tokens: 131072,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'minimax/minimax-m2.5',
  inference_providers: ['minimax'],
} as KiloFreeModel;

export function applyMinimaxProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  requestToMutate.reasoning_split = true;
}
