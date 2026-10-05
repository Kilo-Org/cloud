import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';

export const VERCEL_AI_GATEWAY = {
  id: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions', 'messages', 'responses'],
  responseTransforms: null,
  async transformRequest(context) {
    await applyVercelSettings(context.model, context.request, context.userByok);
  },
} as const satisfies Provider;

/**
 * The Vercel AI Gateway with the user's own gateway key. The request is shaped
 * like a managed Vercel request, so the user's account pays and the provider
 * routing settings still apply.
 */
export function createUserVercelAiGatewayProvider(apiKey: string): Provider {
  return {
    ...VERCEL_AI_GATEWAY,
    apiKey,
    async transformRequest(context) {
      await applyVercelSettings(context.model, context.request, null);
    },
  };
}
