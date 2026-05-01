import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

export function isKimiModel(model: string) {
  return model.includes('kimi');
}

export function applyMoonshotModelSettings(requestToMutate: GatewayRequest) {
  // Moonshot models don't support the temperature parameter
  delete requestToMutate.body.temperature;
  // Kimi models only accept top_p=0.95; any other value causes a 400 error
  delete requestToMutate.body.top_p;
}

export const KIMI_CURRENT_MODEL_ID = 'moonshotai/kimi-k2.6';

export const KIMI_CURRENT_MODEL_NAME = 'Kimi K2.6';
