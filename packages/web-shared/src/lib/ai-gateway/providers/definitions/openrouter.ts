import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { defineGatewayProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/gateway-provider';

export const OPENROUTER = defineGatewayProvider({
  type: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiKey: getEnvVariable('OPENROUTER_API_KEY'),
});

export function createUserOpenRouterProvider(apiKey: string): Provider {
  return { ...OPENROUTER, apiKey };
}
