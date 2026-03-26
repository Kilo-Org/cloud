import type { GatewayRequest } from '@/lib/providers/openrouter/types';

export function isMoonshotModel(model: string) {
  return model.startsWith('moonshotai/');
}

export function applyMoonshotModelSettings(requestToMutate: GatewayRequest) {
  // Moonshot models don't support the temperature parameter
  delete requestToMutate.body.temperature;
  // kimi-k2.5 only accepts top_p=0.95; any other value causes a 400 error
  delete requestToMutate.body.top_p;
}

export const KIMI_CURRENT_MODEL_ID = 'moonshotai/kimi-k2.5';

export const KIMI_CURRENT_MODEL_NAME = 'Kimi K2.5';
