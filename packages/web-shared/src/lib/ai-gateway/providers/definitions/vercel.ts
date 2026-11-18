import { getEnvVariable } from '@kilocode/web-shared/lib/dotenvx';
import type { Provider } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { defineGatewayProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/gateway-provider';

export const VERCEL_AI_GATEWAY = defineGatewayProvider({
  type: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
});

export function createUserVercelAiGatewayProvider(apiKey: string): Provider {
  return { ...VERCEL_AI_GATEWAY, apiKey };
}
