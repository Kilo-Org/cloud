import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const STREAMLAKE = {
  id: 'streamlake',
  apiUrl: 'https://vanchin.streamlake.ai/api/gateway/v1/endpoints',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('STREAMLAKE_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions'],
  responseTransforms: null,
  async transformRequest(context) {
    delete context.request.body.provider;
  },
} as const satisfies Provider;
