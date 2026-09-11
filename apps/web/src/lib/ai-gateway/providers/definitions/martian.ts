import { getEnvVariable } from '@/lib/dotenvx';
import type { Provider } from '@/lib/ai-gateway/providers/types';

export const MARTIAN = {
  id: 'martian',
  apiUrl: 'https://api.withmartian.com/v1',
  apiUrlOverrides: {},
  apiKey: getEnvVariable('MARTIAN_API_KEY'),
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions', 'responses', 'messages'],
  responseTransforms: null,
  async transformRequest(context) {
    delete context.request.body.provider;
  },
} as const satisfies Provider;
