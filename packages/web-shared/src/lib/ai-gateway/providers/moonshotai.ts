import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

export function isKimiModel(model: string) {
  return model.includes('kimi');
}

// Moonshot models don't support the temperature parameter, and Kimi models only accept
// top_p=0.95; any other value causes a 400 error.
export function applyMoonshotModelSettings(requestToMutate: GatewayRequest) {
  if (requestToMutate.kind === 'generate_content') {
    delete requestToMutate.body.generationConfig?.temperature;
    delete requestToMutate.body.generationConfig?.topP;
    return;
  }
  delete requestToMutate.body.temperature;
  delete requestToMutate.body.top_p;
}

export const KIMI_CURRENT_MODEL_ID = 'moonshotai/kimi-k3';
