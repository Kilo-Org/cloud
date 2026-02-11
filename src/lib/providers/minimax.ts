import { type KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { OpenRouterChatCompletionRequest } from '@/lib/providers/openrouter/types';

export const minimax_m21_free_model = {
  public_id: 'minimax/minimax-m2.1:free',
  display_name: 'MiniMax: MiniMax M2.1 (free)',
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
    'MiniMax-M2.5 is a lightweight, state-of-the-art large language model optimized for coding, agentic workflows, and modern application development. With only 10 billion activated parameters, it delivers a major jump in real-world capability while maintaining exceptional latency, scalability, and cost efficiency.',
  context_length: 204800,
  max_completion_tokens: 131072,
  is_enabled: true,
  flags: ['reasoning', 'prompt_cache'],
  gateway: 'openrouter',
  internal_id: 'minimax/minimax-m2.5',
  inference_providers: ['minimax'],
} as KiloFreeModel;

export const minimax_m21_free_slackbot_model = {
  public_id: 'minimax/minimax-m2.1:slackbot',
  display_name: 'MiniMax: MiniMax M2.1 (Free for Kilo for Slack)',
  description: 'Free version of MiniMax M2.1 for use in Kilo for Slack only',
  context_length: 204800,
  max_completion_tokens: 131072,
  is_enabled: true,
  flags: ['reasoning'],
  gateway: 'vercel',
  internal_id: 'minimax/minimax-m2.1',
  inference_providers: ['minimax'],
  slackbot_only: true,
} as KiloFreeModel;

export function applyMinimaxProviderSettings(requestToMutate: OpenRouterChatCompletionRequest) {
  requestToMutate.reasoning_split = true;
}
