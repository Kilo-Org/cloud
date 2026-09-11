import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';
import { applyVercelSettings } from '@/lib/ai-gateway/providers/vercel';

export const VERCEL_AI_GATEWAY = {
  id: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('VERCEL_AI_GATEWAY_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions', 'messages', 'responses'],
  responseTransforms: null,
  async transformRequest(context) {
    await applyVercelSettings(context.model, context.request, context.userByok);
  },
} as const satisfies Provider;
