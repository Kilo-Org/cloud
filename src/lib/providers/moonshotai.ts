import type { KiloFreeModel } from '@/lib/providers/kilo-free-model';
import type { GatewayRequest } from '@/lib/providers/openrouter/types';

export const kimi_k25_free_model: KiloFreeModel = {
  public_id: 'moonshotai/kimi-k2.5:free',
  display_name: 'MoonshotAI: Kimi K2.5 (free)',
  description:
    "Kimi K2.5 is Moonshot AI's native multimodal model, delivering state-of-the-art visual coding capability and a self-directed agent swarm paradigm. Built on Kimi K2 with continued pretraining over approximately 15T mixed visual and text tokens, it delivers strong performance in general reasoning, visual coding, and agentic tool-calling.",
  context_length: 262144,
  max_completion_tokens: 65536,
  status: 'disabled',
  flags: ['reasoning', 'prompt_cache', 'vision'],
  gateway: 'openrouter',
  internal_id: 'moonshotai/kimi-k2.5',
  inference_provider: null,
};

export function isMoonshotModel(model: string) {
  return model.startsWith('moonshotai/');
}

export function applyMoonshotProviderSettings(requestToMutate: GatewayRequest) {
  // Moonshot models don't support the temperature parameter
  delete requestToMutate.body.temperature;
  // kimi-k2.5 only accepts top_p=0.95; any other value causes a 400 error
  delete requestToMutate.body.top_p;
}

export const KIMI_CURRENT_MODEL_ID = 'moonshotai/kimi-k2.5';

export const KIMI_CURRENT_MODEL_NAME = 'Kimi K2.5';
