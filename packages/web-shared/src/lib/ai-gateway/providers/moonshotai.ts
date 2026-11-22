import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';

export function isKimiModel(model: string) {
  return model.includes('kimi');
}

/**
 * Runs for Kimi models only; the caller gates on `isKimiModel`. Moonshot rejects the temperature
 * parameter, so it is deleted. `top_p` is dropped rather than forwarded because Kimi accepts no value
 * other than 0.95, and any other value fails the request with a 400.
 */
export function applyMoonshotModelSettings(requestToMutate: GatewayRequest) {
  delete requestToMutate.body.temperature;
  delete requestToMutate.body.top_p;
}
